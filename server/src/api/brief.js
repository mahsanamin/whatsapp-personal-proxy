import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { canonicalJidMap, resolveNames } from '../db/lidmap.js'
import { channelType } from '../util/jid.js'

/**
 * The "what did I miss" endpoint.
 *
 * Built for an LLM as the first call of a session: one request returns
 * everything needing attention, already ranked and trimmed, instead of making
 * the caller list chats, then fetch each one, then work out what matters. The
 * shape is deliberately lean — an LLM pays for every field it reads.
 */

// Ranked highest first. A message naming you outranks a DM, which outranks
// group chatter, and anything muted sinks regardless of volume.
function score(chat) {
  if (chat.is_muted) return 0
  let value = chat.unread_count > 0 ? 1 : 0
  if (chat.unread_mentions > 0) value += 100
  if (chat.replies_to_me > 0) value += 50
  if (chat.type === 'dm') value += 20
  value += Math.min(chat.unread_count, 10)
  return value
}

function preview(body, type, limit = 140) {
  if (body) return body.length > limit ? body.slice(0, limit - 1) + '…' : body
  if (type === 'text') return ''
  return type === 'voice' ? '[voice note]' : `[${type}]`
}

export default async function briefRoutes(fastify) {
  fastify.get('/brief', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit, 10) || 15, 50)
    const perChat = Math.min(parseInt(request.query.messages, 10) || 5, 20)
    const since = request.query.since || null
    const includeGroups = request.query.groups !== 'false'
    const includeMuted = request.query.muted === 'true'

    // Every chat holding something unread, with the signals that decide rank.
    const rows = db.prepare(`
      SELECT
        cm.jid,
        cm.display_name,
        cm.is_muted,
        cm.last_read_at,
        (SELECT COUNT(*) FROM messages m
          WHERE m.jid = cm.jid AND m.is_from_me = 0 AND m.type NOT IN ('reaction', 'unknown')
            AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)
            AND (? IS NULL OR m.timestamp > ?)) AS unread_count,
        (SELECT COUNT(*) FROM messages m
          WHERE m.jid = cm.jid AND m.is_from_me = 0 AND m.mentions_me = 1
            AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)
            AND (? IS NULL OR m.timestamp > ?)) AS unread_mentions,
        (SELECT COUNT(*) FROM messages m
          JOIN messages q ON q.id = m.quoted_id
          WHERE m.jid = cm.jid AND m.is_from_me = 0 AND q.is_from_me = 1
            AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)
            AND (? IS NULL OR m.timestamp > ?)) AS replies_to_me,
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.jid = cm.jid) AS last_activity
      FROM channel_meta cm
      WHERE EXISTS (
        SELECT 1 FROM messages m
        WHERE m.jid = cm.jid AND m.is_from_me = 0 AND m.type NOT IN ('reaction', 'unknown')
          AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)
          AND (? IS NULL OR m.timestamp > ?)
      )
    `).all(since, since, since, since, since, since, since, since)

    // Collapse a contact's two addresses, exactly as the chat list does.
    const canonical = canonicalJidMap(rows.map(r => r.jid))
    const merged = new Map()
    for (const row of rows) {
      const key = canonical.get(row.jid) || row.jid
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, {
          jid: key,
          type: channelType(key),
          display_name: row.display_name,
          is_muted: Boolean(row.is_muted),
          unread_count: row.unread_count,
          unread_mentions: row.unread_mentions,
          replies_to_me: row.replies_to_me,
          last_activity: row.last_activity,
          jids: [row.jid],
        })
        continue
      }
      if (!existing.display_name && row.display_name) existing.display_name = row.display_name
      existing.unread_count += row.unread_count
      existing.unread_mentions += row.unread_mentions
      existing.replies_to_me += row.replies_to_me
      existing.is_muted = existing.is_muted && Boolean(row.is_muted)
      if (row.last_activity > existing.last_activity) existing.last_activity = row.last_activity
      existing.jids.push(row.jid)
    }

    let chats = [...merged.values()]
      .filter(c => includeMuted || !c.is_muted)
      .filter(c => includeGroups || c.type === 'dm')
      .sort((a, b) => score(b) - score(a) || (b.last_activity || '').localeCompare(a.last_activity || ''))

    const total = {
      chats: chats.length,
      messages: chats.reduce((n, c) => n + c.unread_count, 0),
      mentions: chats.reduce((n, c) => n + c.unread_mentions, 0),
      replies: chats.reduce((n, c) => n + c.replies_to_me, 0),
    }

    chats = chats.slice(0, limit)

    // The actual unread messages, newest-last so each chat reads as a transcript.
    const recent = db.prepare(`
      SELECT id, jid, from_jid, body, type, timestamp, mentions_me, quoted_id
      FROM messages
      WHERE jid = ? AND is_from_me = 0 AND type NOT IN ('reaction', 'unknown')
        AND (? IS NULL OR timestamp > ?)
        AND (? IS NULL OR timestamp > ?)
      ORDER BY timestamp DESC LIMIT ?
    `)

    const senderJids = []
    for (const chat of chats) {
      const lastRead = rows.find(r => chat.jids.includes(r.jid))?.last_read_at || null
      const messages = []
      for (const jid of chat.jids) {
        messages.push(...recent.all(jid, lastRead, lastRead, since, since, perChat))
      }
      chat.messages = messages
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-perChat)
      senderJids.push(...chat.messages.map(m => m.from_jid))
      delete chat.jids
    }

    const names = resolveNames(senderJids)
    for (const chat of chats) {
      chat.display_name = chat.display_name || chat.jid.split('@')[0]
      chat.messages = chat.messages.map(m => ({
        from: names.get(m.from_jid) || m.from_jid?.split('@')[0] || null,
        at: m.timestamp,
        text: preview(m.body, m.type),
        ...(m.mentions_me ? { mentions_you: true } : {}),
        ...(m.quoted_id ? { reply: true } : {}),
      }))
    }

    return {
      generated_at: new Date().toISOString(),
      since,
      totals: total,
      chats,
    }
  })
}
