import { nanoid } from 'nanoid'
import { db } from './index.js'
import { expandJids, canonicalJid } from './lidmap.js'
import { isGroup } from '../util/jid.js'
import {
  validateRuleSet, HANDOFF_RULE_ID, conversationStart, nextLoopStreak, textHash,
} from '../util/autoreply.js'

const HOUR_MS = 60 * 60 * 1000
const KEEP_DECISIONS_MS = 30 * 24 * HOUR_MS
const KEEP_PROCESSED_MS = 2 * 24 * HOUR_MS

const placeholders = (list) => list.map(() => '?').join(',')

// ─── Settings ────────────────────────────────────────────────────────

/** The global kill switch. Off unless someone turned it on in the console. */
export function isEnabled() {
  try {
    const row = db.prepare("SELECT value FROM autoreply_settings WHERE key = 'enabled'").get()
    return row?.value === '1'
  } catch (_) {
    return false
  }
}

export function setEnabled(enabled) {
  db.prepare(`
    INSERT INTO autoreply_settings (key, value) VALUES ('enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(enabled ? '1' : '0')
}

// ─── Rule sets ───────────────────────────────────────────────────────

const SUMMARY_COLUMNS = 'id, name, version, description, mode, active, created_at, updated_at'

export function listRuleSets() {
  return db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM autoreply_rulesets ORDER BY created_at DESC`).all()
    .map(row => ({ ...row, active: Boolean(row.active) }))
}

export function getRuleSet(id) {
  const row = db.prepare(`SELECT ${SUMMARY_COLUMNS}, template FROM autoreply_rulesets WHERE id = ?`).get(id)
  return row ? { ...row, active: Boolean(row.active) } : null
}

/** A new rule set always starts inactive and in dry-run. */
export function createRuleSet(templateText, ruleSet) {
  const id = nanoid(12)
  db.prepare(`
    INSERT INTO autoreply_rulesets (id, name, version, description, template, mode, active)
    VALUES (?, ?, ?, ?, ?, 'dry_run', 0)
  `).run(id, ruleSet.name, ruleSet.version, ruleSet.description, templateText)
  return getRuleSet(id)
}

/** Any edit takes a live rule set back to dry-run, so a change is seen before it sends. */
export function updateRuleSet(id, templateText, ruleSet) {
  const result = db.prepare(`
    UPDATE autoreply_rulesets
    SET name = ?, version = ?, description = ?, template = ?,
        mode = CASE WHEN mode = 'live' THEN 'dry_run' ELSE mode END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ruleSet.name, ruleSet.version, ruleSet.description, templateText, id)
  return result.changes ? getRuleSet(id) : null
}

export function deleteRuleSet(id) {
  return db.prepare('DELETE FROM autoreply_rulesets WHERE id = ?').run(id).changes > 0
}

/** Only one rule set is active at a time; activating one deactivates the rest. */
export const setRuleSetState = db.transaction((id, { mode, active }) => {
  if (active === true) {
    db.prepare('UPDATE autoreply_rulesets SET active = 0 WHERE id != ?').run(id)
  }
  const sets = []
  const values = []
  if (mode !== undefined) { sets.push('mode = ?'); values.push(mode) }
  if (active !== undefined) { sets.push('active = ?'); values.push(active ? 1 : 0) }
  if (sets.length) {
    db.prepare(`UPDATE autoreply_rulesets SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, id)
  }
  return getRuleSet(id)
})

// Validation times each regex against long inputs, which is wasted work on
// every message and could misfire on a busy moment. A template only changes
// with updated_at, so validate it once per version.
let validated = { key: null, result: null }

/** The rule set the engine should run, parsed, or null. The row is re-read on every use. */
export function loadActiveRuleSet() {
  const row = db.prepare(`
    SELECT ${SUMMARY_COLUMNS}, template FROM autoreply_rulesets
    WHERE active = 1 AND mode != 'off'
    ORDER BY updated_at DESC LIMIT 1
  `).get()
  if (!row) return null
  const key = `${row.id}:${row.updated_at}:${row.template.length}`
  if (validated.key !== key) validated = { key, result: validateRuleSet(row.template) }
  const { ok, ruleSet, errors } = validated.result
  return { row, ruleSet: ok ? ruleSet : null, errors }
}

// ─── Allow list ──────────────────────────────────────────────────────

export function isAllowlisted(aliases) {
  if (!aliases.length) return false
  try {
    return Boolean(db.prepare(`SELECT 1 FROM whitelist WHERE jid IN (${placeholders(aliases)}) LIMIT 1`).get(...aliases))
  } catch (_) {
    // Fail closed: an unreadable allow list must not become an open one.
    return false
  }
}

// ─── Dedupe ──────────────────────────────────────────────────────────

/** Claim a message id. False means it was already handled. */
export function claimMessage(messageId, nowMs) {
  return db.prepare('INSERT OR IGNORE INTO autoreply_processed (message_id, at) VALUES (?, ?)')
    .run(messageId, nowMs).changes > 0
}

// ─── Contacts ────────────────────────────────────────────────────────

const CONTACT_FIELDS = ['muted_until', 'mute_reason', 'last_manual_at', 'last_incoming_at', 'conversation_started_at', 'loop_streak', 'last_sent_at']

/** The key for one person inside a group: flood is counted per sender there. */
export const senderKey = (groupJid, senderJid) => `${groupJid}|${senderJid}`

/**
 * State for a contact, merged across every key it may have been written
 * under. A DM can be filed under its @lid or its phone number depending on
 * what was known at the time, and both are the same person.
 */
export function loadContact(keys) {
  const merged = { muted_until: null, mute_reason: null, last_manual_at: null, last_incoming_at: null, conversation_started_at: null, loop_streak: 0, last_sent_at: null }
  if (!keys.length) return merged
  const rows = db.prepare(`SELECT * FROM autoreply_contacts WHERE contact_key IN (${placeholders(keys)})`).all(...keys)
  for (const row of rows) {
    if ((row.muted_until || 0) > (merged.muted_until || 0)) {
      merged.muted_until = row.muted_until
      merged.mute_reason = row.mute_reason
    }
    for (const field of ['last_manual_at', 'last_incoming_at', 'conversation_started_at', 'last_sent_at']) {
      if ((row[field] || 0) > (merged[field] || 0)) merged[field] = row[field]
    }
    merged.loop_streak = Math.max(merged.loop_streak, row.loop_streak || 0)
  }
  return merged
}

/** Write fields onto the canonical key. Fields left out keep their value. */
export function saveContact(key, fields, nowMs) {
  const columns = Object.keys(fields).filter(f => CONTACT_FIELDS.includes(f))
  db.prepare(`
    INSERT INTO autoreply_contacts (contact_key, updated_at${columns.map(c => `, ${c}`).join('')})
    VALUES (?, ?${columns.map(() => ', ?').join('')})
    ON CONFLICT(contact_key) DO UPDATE SET updated_at = excluded.updated_at${columns.map(c => `, ${c} = excluded.${c}`).join('')}
  `).run(key, nowMs, ...columns.map(c => fields[c] ?? null))
}

/** Clear a mute on every key the contact may be stored under. */
export function unmuteContact(keys, nowMs) {
  if (!keys.length) return 0
  return db.prepare(`
    UPDATE autoreply_contacts SET muted_until = NULL, mute_reason = NULL, loop_streak = 0, updated_at = ?
    WHERE contact_key IN (${placeholders(keys)})
  `).run(nowMs, ...keys).changes
}

export function recordManualReply(key, atMs) {
  saveContact(key, { last_manual_at: atMs, loop_streak: 0 }, atMs)
}

export function isBotReply(messageId) {
  return Boolean(db.prepare('SELECT 1 FROM autoreply_decisions WHERE reply_message_id = ? LIMIT 1').get(messageId))
}

/** Incoming messages from one sender in one chat since a time, for flood detection. */
export function countIncoming({ chatAliases, senderAliases, sinceMs }) {
  if (!chatAliases.length || !senderAliases.length) return 0
  return db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE jid IN (${placeholders(chatAliases)}) AND from_jid IN (${placeholders(senderAliases)})
      AND is_from_me = 0 AND timestamp > ?
  `).get(...chatAliases, ...senderAliases, new Date(sinceMs).toISOString()).c
}

/** Contacts the auto-replier has dealt with recently, or that are muted. */
export function listContacts(nowMs) {
  const dayAgo = nowMs - 24 * HOUR_MS
  return db.prepare(`
    SELECT * FROM autoreply_contacts
    WHERE updated_at > ? OR muted_until > ?
    ORDER BY updated_at DESC LIMIT 200
  `).all(nowMs - 7 * 24 * HOUR_MS, nowMs).map(row => {
    const chat = row.contact_key.split('|')[0]
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN action = 'sent' AND at > ? THEN 1 ELSE 0 END) AS sent_24h,
        SUM(CASE WHEN action = 'dry_run' AND at > ? THEN 1 ELSE 0 END) AS dry_run_24h,
        SUM(CASE WHEN action IN ('sent', 'dry_run') AND at >= ? THEN 1 ELSE 0 END) AS conversation_replies
      FROM autoreply_decisions WHERE chat_jid = ?
    `).get(dayAgo, dayAgo, row.conversation_started_at || nowMs, chat)
    return {
      ...row,
      chat_jid: chat,
      sender_jid: row.contact_key.includes('|') ? row.contact_key.split('|')[1] : null,
      muted: Boolean(row.muted_until && row.muted_until > nowMs),
      sent_24h: counts?.sent_24h || 0,
      dry_run_24h: counts?.dry_run_24h || 0,
      conversation_replies: counts?.conversation_replies || 0,
    }
  })
}

// ─── Decision log ────────────────────────────────────────────────────

export function logDecision(entry) {
  const result = db.prepare(`
    INSERT INTO autoreply_decisions
      (at, chat_jid, message_id, ruleset_id, ruleset_name, rule_id, action, reason, reply_text, reply_message_id, text_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.at, entry.chat_jid, entry.message_id ?? null, entry.ruleset_id ?? null,
    entry.ruleset_name ?? null, entry.rule_id ?? null, entry.action, entry.reason ?? null,
    entry.reply_text ?? null, entry.reply_message_id ?? null, entry.text_hash ?? null,
  )
  return result.lastInsertRowid
}

export function listDecisions({ limit = 100, rulesetId = null } = {}) {
  const capped = Math.min(Math.max(1, limit), 500)
  if (rulesetId) {
    return db.prepare('SELECT * FROM autoreply_decisions WHERE ruleset_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(rulesetId, capped)
  }
  return db.prepare('SELECT * FROM autoreply_decisions ORDER BY at DESC, id DESC LIMIT ?').all(capped)
}

/**
 * Past replies to one contact, across all its aliases and every rule set, in
 * the shape decide() expects. `action` is 'sent' or 'dry_run', so a dry run
 * simulates its own limits without being blocked by real sends, and the
 * reverse.
 */
export function loadReplyStats({ aliases, rulesetId, action, nowMs, conversationStart, textHash }) {
  const hourAgo = nowMs - HOUR_MS
  const dayAgo = nowMs - 24 * HOUR_MS
  const since = conversationStart ?? nowMs
  const inChat = `chat_jid IN (${placeholders(aliases)})`

  const chat = db.prepare(`
    SELECT
      MAX(at) AS last,
      SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS last_hour,
      SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS last_day,
      SUM(CASE WHEN at >= ? AND (rule_id IS NULL OR rule_id != ?) THEN 1 ELSE 0 END) AS conversation,
      SUM(CASE WHEN at >= ? AND rule_id = ? THEN 1 ELSE 0 END) AS handoffs,
      MAX(CASE WHEN at >= ? THEN at END) AS conversation_last
    FROM autoreply_decisions WHERE action = ? AND ${inChat}
  `).get(hourAgo, dayAgo, since, HANDOFF_RULE_ID, since, HANDOFF_RULE_ID, since, action, ...aliases)

  const global = db.prepare('SELECT COUNT(*) AS c FROM autoreply_decisions WHERE action = ? AND at > ?').get(action, hourAgo)

  const ruleLastReplyAt = {}
  const rulesReplied = []
  for (const row of db.prepare(`
    SELECT rule_id, MAX(at) AS last FROM autoreply_decisions
    WHERE action = ? AND ruleset_id = ? AND ${inChat} GROUP BY rule_id
  `).all(action, rulesetId, ...aliases)) {
    ruleLastReplyAt[row.rule_id] = row.last
    rulesReplied.push(row.rule_id)
  }

  const sameTextRuleIds = textHash
    ? db.prepare(`
        SELECT DISTINCT rule_id FROM autoreply_decisions
        WHERE action = ? AND text_hash = ? AND at >= ? AND ${inChat}
      `).all(action, textHash, since, ...aliases).map(r => r.rule_id)
    : []

  return {
    lastReplyAt: chat?.last ?? null,
    contactRepliesLastHour: chat?.last_hour ?? 0,
    contactRepliesLastDay: chat?.last_day ?? 0,
    conversationReplies: chat?.conversation ?? 0,
    conversationHandoffSent: (chat?.handoffs ?? 0) > 0,
    conversationLastReplyAt: chat?.conversation_last ?? null,
    globalRepliesLastHour: global?.c ?? 0,
    ruleLastReplyAt,
    rulesReplied,
    sameTextRuleIds,
  }
}

/**
 * Everything decide() needs to know about one incoming message's contact,
 * read without changing anything. The engine saves `contactUpdate` afterwards;
 * the test endpoint does not.
 */
export function contactSnapshot({ ruleSet, rulesetId, chatJid, senderJid, text, action, nowMs }) {
  const options = ruleSet.options
  const aliases = expandJids(chatJid)
  const contactKey = canonicalJid(chatJid)
  const contact = loadContact(aliases)

  const senderAliases = expandJids(senderJid || chatJid)
  const inGroup = isGroup(chatJid)
  const senderKeys = inGroup ? senderAliases.map(alias => senderKey(chatJid, alias)) : []
  const sender = inGroup ? loadContact(senderKeys) : null

  const start = conversationStart({
    previousStart: contact.conversation_started_at,
    lastIncomingAt: contact.last_incoming_at,
    lastManualReplyAt: contact.last_manual_at,
    nowMs,
    gapMinutes: options.conversation.gap_minutes,
  })
  const loopStreak = nextLoopStreak({
    previousStreak: contact.loop_streak,
    lastSentAt: contact.last_sent_at,
    incomingAt: nowMs,
    replyWithinSeconds: options.loop.reply_within_seconds,
  })
  const hash = textHash(text)

  return {
    aliases,
    contactKey,
    // In a DM the sender is the contact; in a group a flood mutes one person.
    floodKey: inGroup ? senderKey(chatJid, canonicalJid(senderJid)) : contactKey,
    textHash: hash,
    contactUpdate: { last_incoming_at: nowMs, conversation_started_at: start, loop_streak: loopStreak },
    stats: {
      contactMute: { until: contact.muted_until, reason: contact.mute_reason },
      senderMute: sender ? { until: sender.muted_until, reason: sender.mute_reason } : null,
      lastManualReplyAt: contact.last_manual_at,
      loopStreak,
      floodCount: countIncoming({
        chatAliases: aliases,
        senderAliases,
        sinceMs: nowMs - options.flood.window_seconds * 1000,
      }),
      ...loadReplyStats({ aliases, rulesetId, action, nowMs, conversationStart: start, textHash: hash }),
    },
  }
}

let lastPruneAt = 0

/** Keep the bookkeeping tables bounded. Cheap enough to call on every message. */
export function prune(nowMs) {
  if (nowMs - lastPruneAt < HOUR_MS) return
  lastPruneAt = nowMs
  db.prepare('DELETE FROM autoreply_processed WHERE at < ?').run(nowMs - KEEP_PROCESSED_MS)
  db.prepare('DELETE FROM autoreply_decisions WHERE at < ?').run(nowMs - KEEP_DECISIONS_MS)
  db.prepare('DELETE FROM autoreply_contacts WHERE updated_at < ? AND (muted_until IS NULL OR muted_until < ?)').run(nowMs - KEEP_DECISIONS_MS, nowMs)
}
