import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { downloadMediaOnDemand } from '../wa/media.js'

export default async function messageRoutes(fastify) {
  fastify.get('/channels/:jid/messages', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const { jid } = request.params
    const { limit = 50, before, type } = request.query

    let sql = 'SELECT id, jid, from_jid, body, type, timestamp, is_from_me, media_mime, media_size, media_saved, quoted_id FROM messages WHERE jid = ?'
    const params = [jid]

    if (before) {
      sql += ' AND timestamp < ?'
      params.push(before)
    }

    if (request.query.after) {
      sql += ' AND timestamp > ?'
      params.push(request.query.after)
    }

    if (type) {
      sql += ' AND type = ?'
      params.push(type)
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(Math.min(parseInt(limit, 10), 200))

    return db.prepare(sql).all(...params)
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
