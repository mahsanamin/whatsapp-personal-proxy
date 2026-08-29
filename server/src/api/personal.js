import { config } from '../config.js'
import { requireScope } from '../middleware/token.js'
import { getSock, ensureConnected } from '../wa/client.js'

export default async function personalRoutes(fastify) {
  fastify.post('/personal/send', {
    preHandler: requireScope('personal:send'),
    config: config.rateLimitSend > 0
      ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const { to, message } = request.body || {}

    if (!to || !message) {
      return reply.code(400).send({ error: 'Fields "to" and "message" required', code: 'BAD_INPUT' })
    }

    // Validate E.164 and check against PERSONAL_NUMBERS
    const normalized = to.startsWith('+') ? to : `+${to}`
    if (!config.personalNumbers.includes(normalized)) {
      return reply.code(403).send({ error: 'Number not in PERSONAL_NUMBERS list', code: 'NOT_PERSONAL_NUMBER' })
    }

    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const jid = normalized.replace('+', '') + '@s.whatsapp.net'
    const result = await sock.sendMessage(jid, { text: message })
    return { ok: true, messageId: result.key.id }
  })
}
