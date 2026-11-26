import { generateMessageIDV2 } from '@whiskeysockets/baileys'
import pino from 'pino'
import { config } from '../config.js'
import { expandJids, canonicalJid, savedContactName } from '../db/lidmap.js'
import {
  isEnabled, loadActiveRuleSet, isAllowlisted, claimMessage, recordManualReply,
  isBotReply, logDecision, contactSnapshot, saveContact, prune, getServerLimits,
  recordDecryptFailure, wasDecryptFailure, pruneDecryptFailures, recentMessages, ownMessageIdsSince,
} from '../db/autoreply.js'
import { decide, liveMessageRefusal, answerRefusal, isDecryptFailure, isManualReply, scopeRefusal } from '../util/autoreply.js'
import { writeLlmReply } from '../util/autoreplyLlm.js'
import { ensureConnected, isOwnJid, recordSentMessage, toNumber, unwrapMessage } from './client.js'
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

try {
  pruneDecryptFailures(Date.now())
} catch (err) {
  logger.warn({ err: err?.message }, 'could not prune decrypt failures')
}

/**
 * Called by ingestion for every upserted message, before it is normalized:
 * the stub left by a failed decryption is dropped by normalization, and its
 * id has to be on record before the resend arrives. Never throws.
 */
export function noteDecryptFailure(raw) {
  try {
    if (isDecryptFailure(raw)) recordDecryptFailure(raw.key.id, raw.key.remoteJid, Date.now())
  } catch (err) {
    logger.warn({ err: err?.message, id: raw?.key?.id }, 'could not record decrypt failure')
  }
}

/**
 * The sender as a rule sees them: the address-book name, and whether they are
 * saved at all. A profile name (pushName) is the sender's own choice and is
 * never used, so a reply to an unknown number cannot name them.
 */
export function senderIdentity(senderJid) {
  const name = savedContactName(senderJid)
  return { senderName: name, senderSaved: Boolean(name) }
}

/**
 * Fill in the text of a reply decision from an "llm" rule. Called only after
 * every gate and limit has passed. Returns { text, reason, generated }; text
 * null means nothing may be sent. Logs the reason, never the key or the text.
 */
export async function writeGeneratedReply({ decision, ruleSet, message, chatAliases, messageId, nowMs }) {
  const response = decision.rule.response
  const result = await writeLlmReply({
    response,
    status: decision.generate.status,
    fallbackText: decision.generate.fallbackText,
    nowMs,
    timezone: ruleSet.options.timezone,
    senderName: message.senderSaved ? message.senderName : null,
    history: response.context_messages > 0
      ? recentMessages({ chatAliases, excludeId: messageId, limit: response.context_messages })
      : [],
    incoming: { type: message.type, text: message.text },
    gateway: config.llmGateway,
  })
  if (!result.generated) logger.warn({ rule: decision.rule.id, reason: result.reason }, 'auto-reply model reply not used')
  return result
}

// One message at a time, so a burst from one chat cannot read the limits
// before the first reply has been logged and answer several times.
let queue = Promise.resolve()

/**
 * Called by ingestion for every stored message. Never throws and never delays
 * ingestion: the work runs later, on a queue.
 */
export function onMessageIngested(raw, normalized, upsertType) {
  const receivedAtMs = Date.now()
  setImmediate(() => {
    queue = queue
      .then(() => handle(raw, normalized, upsertType, receivedAtMs))
      .catch(err => logger.warn({ err: err?.message, id: normalized?.id }, 'auto-reply failed'))
  })
}

async function handle(raw, normalized, upsertType, receivedAtMs) {
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
  if (liveMessageRefusal({ upsertType, message: normalized, raw })) return

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

  // Every condition for a clear, live message, checked before any rule.
  const refused = answerRefusal({
    message: normalized,
    content: unwrapMessage(raw?.message),
    redelivered: wasDecryptFailure(normalized.id),
    sentAtSeconds, receivedAtMs, nowMs, maxAgeSeconds,
  })
  if (refused) {
    logDecision({ at: nowMs, chat_jid: chatJid, message_id: normalized.id, ruleset_id: row.id, ruleset_name: row.name, action: 'skipped', reason: refused })
    return
  }

  const action = row.mode === 'live' ? 'sent' : 'dry_run'
  const sender = senderIdentity(normalized.from_jid)
  const snapshot = contactSnapshot({
    ruleSet, rulesetId: row.id, chatJid, senderJid: normalized.from_jid, text: normalized.body, action, nowMs,
  })
  saveContact(snapshot.contactKey, snapshot.contactUpdate, nowMs)

  const message = { type: normalized.type, text: normalized.body, chatAliases: aliases, ...sender }
  const decision = decide({
    ruleSet,
    message,
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
  if (decision.generate) {
    // Dry runs write the text too, so the log shows what live would send.
    const written = await writeGeneratedReply({ decision, ruleSet, message, chatAliases: aliases, messageId: normalized.id, nowMs })
    if (!written.text) {
      logDecision({ ...base, action: 'skipped', reason: written.reason })
      return
    }
    decision.text = written.text
    decision.reason = written.reason
    // The model took a while. Limits read "at", so log the time of the send,
    // and if the owner wrote here by hand meanwhile, they have taken over.
    base.at = Date.now()
    if (ownerWroteSince(aliases, receivedAtMs)) {
      logDecision({ ...base, action: 'skipped', reason: 'manual_reply_pause', reply_text: decision.text })
      return
    }
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
 * Whether the owner sent something in this chat by hand since a time. The
 * owner's messages are stored at ingestion, before the queue reaches them, so
 * this sees a takeover that happened while a model reply was being written.
 */
function ownerWroteSince(aliases, sinceMs) {
  return ownMessageIdsSince({ chatAliases: aliases, sinceMs })
    .some(id => !botMessageIds.has(id) && !isBotReply(id))
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
