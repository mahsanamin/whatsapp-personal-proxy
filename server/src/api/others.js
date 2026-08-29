import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { ensureConnected } from '../wa/client.js'

export default async function othersRoutes(fastify) {
  fastify.post('/others/send', {
    preHandler: requireScope('others:send'),
    config: config.rateLimitSend > 0
      ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const { to, message } = request.body || {}

    if (!to || !message) {
      return reply.code(400).send({ error: 'Fields "to" and "message" required', code: 'BAD_INPUT' })
    }

    const normalized = to.startsWith('+') ? to : `+${to}`
    const jid = normalized.replace('+', '') + '@s.whatsapp.net'

    // Check whitelist
    const entry = db.prepare('SELECT id FROM whitelist WHERE jid = ?').get(jid)
    if (!entry) {
      return reply.code(403).send({ error: 'Number not in whitelist', code: 'NOT_WHITELISTED' })
    }

    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const result = await sock.sendMessage(jid, { text: message })
    return { ok: true, messageId: result.key.id }
  })
}
