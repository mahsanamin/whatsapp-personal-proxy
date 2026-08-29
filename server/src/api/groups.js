import { config } from '../config.js'
import { db } from '../db/index.js'
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

    // A token is a machine, and a machine only gets to reach destinations that
    // were explicitly allowed. The console (a session) sends anywhere; a token
    // does not, and that has to hold for groups as much as for DMs.
    if (!request.session?.authenticated) {
      const allowed = db.prepare('SELECT id FROM whitelist WHERE jid = ?').get(jid)
      if (!allowed) {
        return reply.code(403).send({
          error: 'Group is not on the allow list. Add it in the console under Allow list.',
          code: 'NOT_WHITELISTED',
        })
      }
    }

    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const result = await sock.sendMessage(jid, { text: message })
    return { ok: true, messageId: result.key.id }
  })
}
