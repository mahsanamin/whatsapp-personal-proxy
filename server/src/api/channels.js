import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { ensureConnected } from '../wa/client.js'
import { channelType, toJid } from '../util/jid.js'
import { canonicalJidMap, expandJids } from '../db/lidmap.js'

export default async function channelRoutes(fastify) {
  fastify.get('/channels', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const { tab, archived, search, type, limit } = request.query

    let sql = `
      SELECT
        cm.jid,
        cm.display_name,
        cm.tab_id,
        cm.is_muted,
        cm.is_archived,
        cm.priority,
        cm.notes,
        (SELECT COUNT(*) FROM messages m
          WHERE m.jid = cm.jid AND m.is_from_me = 0
            AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)) AS unread_count,
        (SELECT COUNT(*) FROM messages m
          WHERE m.jid = cm.jid AND m.is_from_me = 0 AND m.mentions_me = 1
            AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)) AS unread_mentions,
        (SELECT json_object(
          'body', m2.body,
          'timestamp', m2.timestamp,
          'type', m2.type
        ) FROM messages m2 WHERE m2.jid = cm.jid ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
      FROM channel_meta cm
      WHERE (cm.display_name IS NOT NULL OR EXISTS (SELECT 1 FROM messages m3 WHERE m3.jid = cm.jid AND m3.type != 'unknown' AND m3.type != 'reaction'))
    `
    const params = []

    if (tab) {
      sql += ' AND cm.tab_id = ?'
      params.push(tab)
    }

    if (archived !== undefined) {
      sql += ' AND cm.is_archived = ?'
      params.push(archived === 'true' ? 1 : 0)
    }

    if (type === 'group') {
      sql += " AND cm.jid LIKE '%@g.us'"
    } else if (type === 'dm') {
      sql += " AND cm.jid NOT LIKE '%@g.us' AND cm.jid NOT LIKE '%@newsletter'"
    } else if (type === 'channel') {
      sql += " AND cm.jid LIKE '%@newsletter'"
    }

    if (search) {
      // Match the partner address too. A DM lives under both a phone-number
      // JID and an @lid one; matching only the row that literally contains the
      // search text would drop the other half before the merge below, so the
      // same chat would report different unread counts depending on whether
      // you searched its number or its name.
      sql += ` AND (
        cm.display_name LIKE ?
        OR cm.jid LIKE ?
        OR EXISTS (
          SELECT 1 FROM lid_map m
          LEFT JOIN channel_meta partner
            ON partner.jid = CASE WHEN m.lid = cm.jid THEN m.pn ELSE m.lid END
          WHERE (m.lid = cm.jid OR m.pn = cm.jid)
            AND (
              (CASE WHEN m.lid = cm.jid THEN m.pn ELSE m.lid END) LIKE ?
              OR partner.display_name LIKE ?
            )
        )
      )`
      const like = `%${search}%`
      params.push(like, like, like, like)
    }

    sql += ` ORDER BY cm.priority DESC,
      (SELECT MAX(m4.timestamp) FROM messages m4 WHERE m4.jid = cm.jid) DESC NULLS LAST,
      cm.display_name, cm.jid`

    const cap = limit === undefined ? null : Math.min(Math.max(parseInt(limit, 10) || 0, 1), 1000)
    if (cap) {
      sql += ' LIMIT ?'
      params.push(cap)
    }

    const rows = db.prepare(sql).all(...params)

    // One person, one row. WhatsApp files the same DM under a phone-number JID
    // and a device-linked @lid one depending on which address the sender used,
    // so without collapsing them a contact appears twice — typically an old
    // thread under the number and a new one under the LID.
    const canonical = canonicalJidMap(rows.map(r => r.jid))
    const merged = new Map()

    for (const row of rows) {
      const key = canonical.get(row.jid) || row.jid
      const lastMessage = row.last_message ? JSON.parse(row.last_message) : null
      const existing = merged.get(key)

      if (!existing) {
        merged.set(key, {
          ...row,
          jid: key,
          type: channelType(key),
          display_name: row.display_name,
          last_message: lastMessage,
          unread_count: row.unread_count || 0,
          unread_mentions: row.unread_mentions || 0,
          alt_jids: row.jid === key ? [] : [row.jid],
        })
        continue
      }

      // A name on either address names the person.
      if (!existing.display_name && row.display_name) existing.display_name = row.display_name
      existing.unread_count += row.unread_count || 0
      existing.unread_mentions += row.unread_mentions || 0
      if (lastMessage && (!existing.last_message || lastMessage.timestamp > existing.last_message.timestamp)) {
        existing.last_message = lastMessage
      }
      if (row.jid !== key) existing.alt_jids.push(row.jid)
      // Prefer real metadata over a placeholder row.
      existing.tab_id = existing.tab_id ?? row.tab_id
      existing.notes = existing.notes ?? row.notes
      existing.is_muted = existing.is_muted || row.is_muted
      existing.is_archived = existing.is_archived && row.is_archived
    }

    return [...merged.values()].sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0)
      const at = a.last_message?.timestamp || ''
      const bt = b.last_message?.timestamp || ''
      if (at !== bt) return bt.localeCompare(at)
      return (a.display_name || a.jid).localeCompare(b.display_name || b.jid)
    })
  })

  // Groups straight from WhatsApp, not from the local mirror. Use this to find
  // the JID of a group that has not spoken since the DB was created.
  fastify.get('/groups', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const { search } = request.query
    let groups
    try {
      groups = await sock.groupFetchAllParticipating()
    } catch (err) {
      return reply.code(502).send({ error: 'Could not fetch groups from WhatsApp', code: 'WA_FETCH_FAILED' })
    }

    // Keep the local mirror fresh while we have the data in hand
    const upsert = db.prepare(`
      INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET display_name = COALESCE(excluded.display_name, channel_meta.display_name)
    `)

    const needle = search ? search.toLowerCase() : null

    return Object.entries(groups)
      .map(([jid, meta]) => {
        try { upsert.run(jid, meta.subject || null) } catch (_) {}
        return {
          jid,
          type: 'group',
          display_name: meta.subject || null,
          participants: meta.participants?.length ?? null,
          owner: meta.owner || null,
          announce: Boolean(meta.announce),
        }
      })
      .filter(g => !needle || (g.display_name || '').toLowerCase().includes(needle) || g.jid.toLowerCase().includes(needle))
      .sort((a, b) => (a.display_name || a.jid).localeCompare(b.display_name || b.jid))
  })

  fastify.get('/channels/:jid', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const jid = toJid(request.params.jid) || request.params.jid
    const channel = db.prepare('SELECT * FROM channel_meta WHERE jid = ?').get(jid)
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', code: 'NOT_FOUND' })
    }

    const lastMessage = db.prepare(
      'SELECT body, timestamp, type FROM messages WHERE jid = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(jid)

    return { ...channel, type: channelType(jid), last_message: lastMessage || null }
  })

  // Mark a conversation read. WhatsApp does not tell us when the owner reads
  // something, so this is the only thing that makes "unread" mean anything.
  fastify.post('/channels/:jid/read', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const requested = toJid(request.params.jid) || request.params.jid
    const jids = expandJids(requested)
    const upTo = request.body?.up_to || new Date().toISOString()

    const stmt = db.prepare(`
      INSERT INTO channel_meta (jid, last_read_at) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET last_read_at = excluded.last_read_at
    `)
    const apply = db.transaction(() => {
      for (const jid of jids) stmt.run(jid, upTo)
    })
    apply()

    const remaining = db.prepare(
      `SELECT COUNT(*) AS c FROM messages
       WHERE jid IN (${jids.map(() => '?').join(',')}) AND is_from_me = 0 AND timestamp > ?`
    ).get(...jids, upTo).c

    return { ok: true, jid: requested, read_up_to: upTo, unread_count: remaining }
  })

  fastify.patch('/channels/:jid', {
    preHandler: fastify.requireSession,
  }, async (request, reply) => {
    const { jid } = request.params
    const allowed = ['tab_id', 'is_muted', 'is_archived', 'priority', 'notes', 'display_name']
    const updates = []
    const params = []

    for (const key of allowed) {
      if (request.body[key] !== undefined) {
        updates.push(`${key} = ?`)
        params.push(request.body[key])
      }
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update', code: 'BAD_INPUT' })
    }

    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(jid)

    const result = db.prepare(
      `UPDATE channel_meta SET ${updates.join(', ')} WHERE jid = ?`
    ).run(...params)

    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Channel not found', code: 'NOT_FOUND' })
    }

    const updated = db.prepare('SELECT * FROM channel_meta WHERE jid = ?').get(jid)
    fastify.eventBus.emit('channel.update', updated)
    return updated
  })
}
