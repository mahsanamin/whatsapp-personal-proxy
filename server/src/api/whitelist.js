import { nanoid } from 'nanoid'
import { toJid } from '../util/jid.js'
import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'

export default async function whitelistRoutes(fastify) {
  fastify.get('/whitelist', {
    preHandler: requireScope('others:whitelist:read'),
  }, async () => {
    return db.prepare('SELECT * FROM whitelist ORDER BY added_at DESC').all()
  })

  fastify.post('/whitelist', {
    preHandler: requireScope('others:whitelist:manage'),
  }, async (request, reply) => {
    const { jid, label } = request.body || {}

    if (!jid) {
      return reply.code(400).send({ error: 'JID required', code: 'BAD_INPUT' })
    }

    const normalizedJid = toJid(jid)
    if (!normalizedJid || !/^(?:\d+@(s\.whatsapp\.net|lid)|[\d-]+@g\.us)$/.test(normalizedJid)) {
      return reply.code(400).send({ error: 'A valid phone number or chat address is required', code: 'BAD_INPUT' })
    }

    const id = nanoid()

    try {
      db.prepare(
        'INSERT INTO whitelist (id, jid, label) VALUES (?, ?, ?)'
      ).run(id, normalizedJid, label || null)
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'JID already whitelisted', code: 'DUPLICATE' })
      }
      throw err
    }

    return db.prepare('SELECT * FROM whitelist WHERE id = ?').get(id)
  })

  fastify.delete('/whitelist/:id', {
    preHandler: requireScope('others:whitelist:manage'),
  }, async (request, reply) => {
    const { id } = request.params
    const result = db.prepare('DELETE FROM whitelist WHERE id = ?').run(id)
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Whitelist entry not found', code: 'NOT_FOUND' })
    }
    return { ok: true }
  })
}
