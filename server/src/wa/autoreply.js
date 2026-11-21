import { generateMessageIDV2 } from '@whiskeysockets/baileys'
import pino from 'pino'
import { config } from '../config.js'
import { expandJids, canonicalJid, resolveNames } from '../db/lidmap.js'
import {
  isEnabled, loadActiveRuleSet, isAllowlisted, claimMessage, recordManualReply,
  isBotReply, logDecision, contactSnapshot, saveContact, prune, getServerLimits,
} from '../db/autoreply.js'
import { decide, liveMessageRefusal, isManualReply, scopeRefusal } from '../util/autoreply.js'
import { ensureConnected, isOwnJid, recordSentMessage, toNumber } from './client.js'
import { sendMessage } from './send.js'

const logger = pino({ level: config.waLogLevel })

// Ids of replies this process sent, recorded before the send so the echo can
// never be mistaken for the owner typing. The decision log covers restarts.
const botMessageIds = new Map()
const BOT_ID_TTL_MS = 10 * 60 * 1000

function rememberBotMessage(id, nowMs) {
  botMessageIds.set(id, nowMs)
  for (const [known, at] of botMessageIds) {
    if (nowMs - at > BOT_ID_TTL_MS) botMessageIds.delete(known)
  }
}

// One message at a time, so a burst from one chat cannot read the limits
// before the first reply has been logged and answer several times.
let queue = Promise.resolve()

/**
 * Called by ingestion for every stored message. Never throws and never delays
 * ingestion: the work runs later, on a queue.
 */
export function onMessageIngested(raw, normalized, upsertType) {
  setImmediate(() => {
    queue = queue
      .then(() => handle(raw, normalized, upsertType))
      .catch(err => logger.warn({ err: err?.message, id: normalized?.id }, 'auto-reply failed'))
  })
}

async function handle(raw, normalized, upsertType) {
  const nowMs = Date.now()
  const sentAtSeconds = toNumber(raw?.messageTimestamp)
  // Read per message, so a limit changed in the console applies without a restart.
  const { limits } = getServerLimits()
  const { maxAgeSeconds } = limits

  if (normalized?.is_from_me) {
    // Cheap test first: history replays thousands of own messages on a reconnect.
    if (!isManualReply({ message: normalized, sentAtSeconds, nowMs, maxAgeSeconds, isBotMessage: false })) return
    const id = normalized.id
    if (botMessageIds.has(id) || isBotReply(id)) return
    recordManualReply(canonicalJid(normalized.jid), nowMs)
    return
  }

  if (!isEnabled()) return
  if (liveMessageRefusal({ upsertType, message: normalized, sentAtSeconds, nowMs, maxAgeSeconds })) return

  const active = loadActiveRuleSet()
  if (!active?.ruleSet) return
  const { row, ruleSet } = active

  if (!claimMessage(normalized.id, nowMs)) return
  prune(nowMs)

  const chatJid = normalized.jid
  const aliases = expandJids(chatJid)
  const outOfScope = scopeRefusal(ruleSet.scope, {
    chatJid, aliases, allowlisted: isAllowlisted(aliases), isOwn: isOwnJid(chatJid),
  })
  if (outOfScope === 'blocklisted') {
    logDecision({ at: nowMs, chat_jid: chatJid, message_id: normalized.id, ruleset_id: row.id, ruleset_name: row.name, action: 'skipped', reason: 'blocklisted' })
    return
  }
  // Other out-of-scope chats are not logged: that would record every message
  // from everyone.
  if (outOfScope) return

  const action = row.mode === 'live' ? 'sent' : 'dry_run'
  const senderName = resolveNames([normalized.from_jid]).get(normalized.from_jid) || null
  const snapshot = contactSnapshot({
    ruleSet, rulesetId: row.id, chatJid, senderJid: normalized.from_jid, text: normalized.body, action, nowMs,
  })
  saveContact(snapshot.contactKey, snapshot.contactUpdate, nowMs)

  const decision = decide({
    ruleSet,
    message: { type: normalized.type, text: normalized.body, chatAliases: aliases, senderName },
    nowMs,
    stats: snapshot.stats,
    limits,
  })

  const base = {
    at: nowMs, chat_jid: chatJid, message_id: normalized.id,
    ruleset_id: row.id, ruleset_name: row.name, rule_id: decision.rule?.id ?? null,
    text_hash: snapshot.textHash,
  }

  if (decision.action === 'mute') {
    const { target, minutes, reason } = decision.mute
    const key = target === 'sender' ? snapshot.floodKey : snapshot.contactKey
    saveContact(key, { muted_until: nowMs + minutes * 60_000, mute_reason: reason, ...(reason === 'loop' ? { loop_streak: 0 } : {}) }, nowMs)
    logDecision({ ...base, action: 'skipped', reason })
    return
  }
  if (decision.action === 'skip') {
    logDecision({ ...base, action: 'skipped', reason: decision.reason })
    return
  }
  if (row.mode !== 'live') {
    logDecision({ ...base, action: 'dry_run', reason: decision.reason, reply_text: decision.text })
    return
  }

  const refusal = preSendRefusal(row, chatJid)
  if (refusal) {
    logDecision({ ...base, action: 'skipped', reason: refusal, reply_text: decision.text })
    return
  }

  const sock = ensureConnected()
  if (!sock) {
    logDecision({ ...base, action: 'failed', reason: 'wa_disconnected', reply_text: decision.text })
    return
  }

  const messageId = generateMessageIDV2(sock.user?.id)
  rememberBotMessage(messageId, nowMs)
  try {
    const result = await sendMessage(sock, chatJid, { text: decision.text }, { messageId })
    recordSentMessage(result)
    // Only real sends feed loop detection: a dry run cannot provoke another bot.
    saveContact(snapshot.contactKey, { last_sent_at: Date.now() }, Date.now())
    logDecision({ ...base, action: 'sent', reason: decision.reason, reply_text: decision.text, reply_message_id: result?.key?.id || messageId })
  } catch (err) {
    logDecision({ ...base, action: 'failed', reason: `send_failed: ${String(err?.message || err).slice(0, 200)}`, reply_text: decision.text })
  }
}

/**
 * Everything that allowed the reply, read again just before it goes out:
 * the kill switch, the same rule set still active and live and unchanged, and
 * the chat still inside its scope with the current allow list.
 */
function preSendRefusal(row, chatJid) {
  if (!isEnabled()) return 'disabled'
  const current = loadActiveRuleSet()
  if (!current?.ruleSet || current.row.id !== row.id) return 'ruleset_changed'
  if (current.row.mode !== 'live') return 'not_live'
  if (current.row.updated_at !== row.updated_at) return 'ruleset_changed'
  const aliases = expandJids(chatJid)
  const outOfScope = scopeRefusal(current.ruleSet.scope, {
    chatJid, aliases, allowlisted: isAllowlisted(aliases), isOwn: isOwnJid(chatJid),
  })
  return outOfScope ? `scope:${outOfScope}` : null
}
