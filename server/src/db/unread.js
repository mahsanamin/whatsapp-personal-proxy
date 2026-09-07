const placeholders = jids => jids.map(() => '?').join(',')

function currentState(db, jids) {
  if (!jids.length) return undefined
  return db.prepare(`SELECT * FROM conversation_unread WHERE jid IN (${placeholders(jids)}) ORDER BY revision DESC LIMIT 1`).get(...jids)
}

function saveState(db, jid, state) {
  db.prepare(`INSERT OR REPLACE INTO conversation_unread
    (jid, unread_count, known, marked_unread, source, as_of) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(jid, state.unread_count, state.known, state.marked_unread, state.source, state.as_of)
}

export function unreadState(db, jids) {
  const state = currentState(db, jids)
  return {
    unread_count: state?.known ? state.unread_count : null,
    unread_known: Boolean(state?.known),
    unread_lower_bound: state?.unread_count || 0,
    marked_unread: Boolean(state?.marked_unread),
  }
}

export function applyUnreadUpdate(db, jids, chat, source = 'live') {
  const value = chat.unreadCount
  if (!jids.length || value === undefined) return false
  if (value !== null && (!Number.isSafeInteger(value) || value < -1)) return false
  return db.transaction(() => {
    const old = currentState(db, jids)
    const now = Date.now()
    const messageIds = [...new Set((chat.messages || []).map(item => item.message?.key)
      .filter(key => key?.id && !key.fromMe).map(key => key.id))]
    const remember = db.prepare('INSERT OR IGNORE INTO unread_counter_events (message_id) VALUES (?)')
    let increment = value
    if (source !== 'history' && value > 0 && messageIds.length === value) {
      increment = messageIds.reduce((count, id) => count + remember.run(id).changes, 0)
      if (increment === 0) return false
    }
    let state
    if (source === 'history') {
      const seconds = Number(chat.conversationTimestamp?.toNumber?.() ?? chat.conversationTimestamp)
      const hasTimestamp = Number.isFinite(seconds) && seconds > 0
      const asOf = hasTimestamp ? Math.min(seconds * 1000, now) : now
      // Old or on-demand history cannot undo a later read or live update.
      if (old && (!hasTimestamp || asOf <= old.as_of)) return false
      for (const id of messageIds) remember.run(id)
      state = { unread_count: Math.max(value || 0, 0), known: value === -1 ? 0 : 1,
        marked_unread: value === -1 ? 1 : 0, source, as_of: asOf }
    } else if (value === 0 || value === null) {
      state = { unread_count: 0, known: 1, marked_unread: 0, source, as_of: now }
    } else {
      // Baileys emits positive increments, not absolute live counts. -1 is
      // "marked unread", not a negative count or a request to subtract one.
      state = { unread_count: (old?.unread_count || 0) + (value > 0 ? increment : 0),
        known: old?.known || 0, marked_unread: value === -1 ? 1 : (old?.marked_unread || 0),
        source, as_of: now }
    }
    saveState(db, jids[0], state)
    if (state.known && state.unread_count === 0 && !state.marked_unread) {
      const cursor = new Date(state.as_of).toISOString()
      const update = db.prepare(`UPDATE channel_meta SET last_read_at = CASE
        WHEN last_read_at IS NULL OR last_read_at < ? THEN ? ELSE last_read_at END WHERE jid = ?`)
      for (const jid of jids) update.run(cursor, cursor, jid)
      db.prepare(`UPDATE unread_messages SET is_read = 1 WHERE jid IN (${placeholders(jids)})`).run(...jids)
    }
    return true
  })()
}

const countableTypes = new Set(['text', 'image', 'video', 'voice', 'audio', 'doc', 'sticker', 'location', 'contact'])

export function recordUnreadMessage(db, message) {
  if (message.is_from_me || !countableTypes.has(message.type)) return
  db.prepare(`INSERT OR IGNORE INTO unread_messages (message_id, jid, timestamp, mentions_me) VALUES (?, ?, ?, ?)`)
    .run(message.id, message.jid, message.timestamp, message.mentions_me || 0)
}

export function markUnreadThrough(db, jids, upTo) {
  const old = currentState(db, jids)
  const pending = db.prepare(`SELECT COUNT(*) AS count FROM unread_messages
    WHERE jid IN (${placeholders(jids)}) AND is_read = 0 AND timestamp > ?`).get(...jids, upTo).count
  // Preserve arrivals newer than the rendered page, without resurrecting
  // messages which a WhatsApp read update already cleared.
  const count = old?.known ? Math.min(old.unread_count, pending) : pending
  db.prepare(`UPDATE unread_messages SET is_read = 1 WHERE jid IN (${placeholders(jids)}) AND timestamp <= ?`).run(...jids, upTo)
  saveState(db, jids[0], { unread_count: count, known: 1, marked_unread: 0, source: 'console', as_of: Date.now() })
  return count
}

export function unreadMentions(db, jids) {
  const state = currentState(db, jids)
  if (!state?.unread_count) return 0
  const cursor = db.prepare(`SELECT MAX(last_read_at) AS value FROM channel_meta WHERE jid IN (${placeholders(jids)})`).get(...jids).value
  const mentions = db.prepare(`SELECT COUNT(*) AS count FROM unread_messages
    WHERE jid IN (${placeholders(jids)}) AND is_read = 0 AND mentions_me = 1 AND (? IS NULL OR timestamp > ?)`)
    .get(...jids, cursor, cursor).count
  return Math.min(mentions, state.unread_count)
}

export function applyUnreadReceipt(db, jids, messageId) {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE unread_messages SET is_read = 1
      WHERE message_id = ? AND jid IN (${placeholders(jids)}) AND is_read = 0`).run(messageId, ...jids).changes
    if (!changed) return false
    const old = currentState(db, jids)
    if (old) saveState(db, jids[0], { ...old, unread_count: Math.max(old.unread_count - 1, 0), source: 'live', as_of: Date.now() })
    return true
  })()
}
