import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'

export default async function channelRoutes(fastify) {
  fastify.get('/channels', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const { tab, archived, search } = request.query

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
      WHERE 1=1
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

    if (search) {
      sql += ' AND (cm.display_name LIKE ? OR cm.jid LIKE ?)'
      params.push(`%${search}%`, `%${search}%`)
    }

    sql += ' ORDER BY cm.priority DESC, cm.jid'

    const rows = db.prepare(sql).all(...params)
    return rows.map(row => ({
      ...row,
      last_message: row.last_message ? JSON.parse(row.last_message) : null,
    }))
  })

  fastify.get('/channels/:jid', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { jid } = request.params
    const channel = db.prepare('SELECT * FROM channel_meta WHERE jid = ?').get(jid)
    if (!channel) {
      return reply.code(404).send({ error: 'Channel not found', code: 'NOT_FOUND' })
    }

    const lastMessage = db.prepare(
      'SELECT body, timestamp, type FROM messages WHERE jid = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(jid)

    return { ...channel, last_message: lastMessage || null }
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
