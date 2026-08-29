import { requireAnyCredential } from '../middleware/token.js'
import { toJid } from '../util/jid.js'
import { sendText, sendRateLimit } from './sendText.js'

export default async function personalRoutes(fastify) {
  fastify.post('/personal/send', {
    preHandler: requireAnyCredential,
    config: sendRateLimit,
  }, async (request, reply) => {
    const { to } = request.body || {}
    const jid = toJid(to)
    if (!jid) {
      return reply.code(400).send({ error: 'Field "to" must be a number or JID', code: 'BAD_INPUT' })
    }
    // Destination rules, including "is this one of the owner's own numbers",
    // live in checkSendPermission — see util/sendPermission.js.
    return sendText(request, reply, jid)
  })
}
