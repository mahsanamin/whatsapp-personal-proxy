import { config } from '../config.js'
import { requireScope } from '../middleware/token.js'
import { ensureConnected } from '../wa/client.js'

export default async function groupsRoutes(fastify) {
  fastify.post('/groups/send', {
    preHandler: requireScope('groups:send'),
    config: config.rateLimitSend > 0
      ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const { jid, message } = request.body || {}

    if (!jid || !message) {
      return reply.code(400).send({ error: 'Fields "jid" and "message" required', code: 'BAD_INPUT' })
    }

    if (!jid.endsWith('@g.us')) {
      return reply.code(400).send({ error: 'JID must be a group JID (ending in @g.us)', code: 'BAD_INPUT' })
    }

    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const result = await sock.sendMessage(jid, { text: message })
    return { ok: true, messageId: result.key.id }
  })
}
