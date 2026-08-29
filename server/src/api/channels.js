import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { ensureConnected } from '../wa/client.js'
import { channelType, toJid } from '../util/jid.js'

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
        (SELECT COUNT(*) FROM messages m WHERE m.jid = cm.jid AND m.status != 'read' AND m.is_from_me = 0) AS unread_count,
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
      sql += ' AND (cm.display_name LIKE ? OR cm.jid LIKE ?)'
      params.push(`%${search}%`, `%${search}%`)
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

    // Resolve names via LID map for any unnamed channels
    const resolveName = db.prepare(`
      SELECT cm2.display_name FROM lid_map lm
      JOIN channel_meta cm2 ON cm2.jid = lm.pn
      WHERE lm.lid = ? AND cm2.display_name IS NOT NULL
    `)

    return rows.map(row => {
      let displayName = row.display_name
      if (!displayName && row.jid.endsWith('@lid')) {
        const resolved = resolveName.get(row.jid)
        if (resolved?.display_name) displayName = resolved.display_name
      }
      return {
        ...row,
        type: channelType(row.jid),
        display_name: displayName,
        last_message: row.last_message ? JSON.parse(row.last_message) : null,
      }
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
