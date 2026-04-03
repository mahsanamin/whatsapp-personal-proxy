import crypto from 'node:crypto'
import { nanoid } from 'nanoid'
import { db } from '../db/index.js'
import { VALID_SCOPES } from '../middleware/token.js'

export default async function tokenRoutes(fastify) {
  // All token routes require web UI session
  fastify.addHook('onRequest', fastify.requireSession)

  fastify.get('/tokens', async () => {
    return db.prepare(
      'SELECT id, name, scopes, created_at, last_used, revoked FROM tokens ORDER BY created_at DESC'
    ).all().map(row => ({ ...row, scopes: JSON.parse(row.scopes) }))
  })

  fastify.post('/tokens', async (request, reply) => {
    const { name, scopes } = request.body || {}

    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Token name required', code: 'BAD_INPUT' })
    }

    if (!Array.isArray(scopes) || scopes.length === 0) {
      return reply.code(400).send({ error: 'At least one scope required', code: 'BAD_INPUT' })
    }

    const invalid = scopes.filter(s => !VALID_SCOPES.includes(s))
    if (invalid.length > 0) {
      return reply.code(400).send({ error: `Invalid scopes: ${invalid.join(', ')}`, code: 'INVALID_SCOPES' })
    }

    const id = nanoid()
    const rawToken = 'sk_' + crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

    db.prepare(
      'INSERT INTO tokens (id, name, token_hash, scopes) VALUES (?, ?, ?, ?)'
    ).run(id, name, tokenHash, JSON.stringify(scopes))

    return { id, name, scopes, token: rawToken }
  })

  fastify.delete('/tokens/:id', async (request, reply) => {
    const { id } = request.params
    const result = db.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').run(id)
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Token not found', code: 'NOT_FOUND' })
    }
    return { ok: true }
  })
}
