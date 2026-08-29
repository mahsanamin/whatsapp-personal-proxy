import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { downloadMediaOnDemand } from '../wa/media.js'
import { expandJids } from '../db/lidmap.js'
import { toJid, channelType } from '../util/jid.js'

// Attach reactions to their target message and drop the standalone
// reaction rows, which are noise in a transcript.
function withReactions(messages) {
  const msgIds = messages.filter(m => m.type !== 'reaction').map(m => m.id)
  const reactions = msgIds.length > 0
    ? db.prepare(
        `SELECT body, quoted_id, from_jid FROM messages WHERE type = 'reaction' AND quoted_id IN (${msgIds.map(() => '?').join(',')})`,
      ).all(...msgIds)
    : []

  const reactionMap = {}
  for (const r of reactions) {
    if (!reactionMap[r.quoted_id]) reactionMap[r.quoted_id] = []
    reactionMap[r.quoted_id].push({ emoji: r.body, from: r.from_jid })
  }

  return messages
    .filter(m => m.type !== 'reaction')
    .map(m => ({ ...m, reactions: reactionMap[m.id] || [] }))
}

const MESSAGE_COLUMNS =
  'id, jid, from_jid, body, type, timestamp, is_from_me, media_mime, media_size, media_saved, quoted_id'

export default async function messageRoutes(fastify) {
  fastify.get('/channels/:jid/messages', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const requested = toJid(request.params.jid) || request.params.jid
    const { limit = 50, before, after, type } = request.query

    // A DM can be filed under the phone-number JID, the @lid one, or both.
    // Read across every JID that maps to the same conversation.
    const jids = expandJids(requested)

    let sql = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE jid IN (${jids.map(() => '?').join(',')})`
    const params = [...jids]

    if (before) {
      sql += ' AND timestamp < ?'
      params.push(before)
    }

    if (after) {
      sql += ' AND timestamp > ?'
      params.push(after)
    }

    if (type) {
      sql += ' AND type = ?'
      params.push(type)
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(Math.min(parseInt(limit, 10) || 50, 200))

    return withReactions(db.prepare(sql).all(...params))
  })

  // Full-text-ish search over stored message bodies. Scoped to one chat with
  // ?jid=, otherwise across everything the mirror has seen.
  fastify.get('/messages/search', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { q, jid, limit = 50, type } = request.query

    if (!q || !q.trim()) {
      return reply.code(400).send({ error: 'Query parameter "q" required', code: 'BAD_INPUT' })
    }

    let sql = `
      SELECT m.${MESSAGE_COLUMNS.split(', ').join(', m.')},
             cm.display_name AS channel_name
      FROM messages m
      LEFT JOIN channel_meta cm ON cm.jid = m.jid
      WHERE m.body LIKE ? AND m.type != 'reaction'
    `
    const params = [`%${q}%`]

    if (jid) {
      const jids = expandJids(toJid(jid) || jid)
      sql += ` AND m.jid IN (${jids.map(() => '?').join(',')})`
      params.push(...jids)
    }

    if (type) {
      sql += ' AND m.type = ?'
      params.push(type)
    }

    sql += ' ORDER BY m.timestamp DESC LIMIT ?'
    params.push(Math.min(parseInt(limit, 10) || 50, 200))

    return db.prepare(sql).all(...params).map(row => ({
      ...row,
      channel_type: channelType(row.jid),
    }))
  })

  // Stream media on demand — does NOT write to disk
  fastify.get('/channels/:jid/messages/:id/media', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { id } = request.params
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    }

    if (!msg.media_key) {
      return reply.code(400).send({ error: 'Message has no media', code: 'NO_MEDIA' })
    }

    try {
      const { buffer } = await downloadMediaOnDemand(msg)
      reply.header('Content-Type', msg.media_mime || 'application/octet-stream')
      reply.header('Content-Disposition', 'inline')
      return reply.send(buffer)
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to download media', code: 'MEDIA_DOWNLOAD_FAILED' })
    }
  })

  // Save media to disk explicitly
  fastify.post('/channels/:jid/messages/:id/media/save', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { id } = request.params
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    }

    if (!msg.media_key) {
      return reply.code(400).send({ error: 'Message has no media', code: 'NO_MEDIA' })
    }

    if (msg.media_saved) {
      return { ok: true, path: msg.media_path }
    }

    try {
      const { savePath } = await downloadMediaOnDemand(msg, { saveToDisk: true })

      db.prepare(
        'UPDATE messages SET media_saved = 1, media_path = ? WHERE id = ?'
      ).run(savePath, id)

      return { ok: true, path: savePath }
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to save media', code: 'MEDIA_SAVE_FAILED' })
    }
  })
}
