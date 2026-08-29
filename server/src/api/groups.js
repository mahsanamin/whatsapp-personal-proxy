import { requireAnyCredential } from '../middleware/token.js'
import { isGroup } from '../util/jid.js'
import { sendText, sendRateLimit } from './sendText.js'

export default async function groupsRoutes(fastify) {
  fastify.post('/groups/send', {
    preHandler: requireAnyCredential,
    config: sendRateLimit,
  }, async (request, reply) => {
    const { jid } = request.body || {}
    if (!isGroup(jid)) {
      return reply.code(400).send({ error: 'JID must be a group JID (ending in @g.us)', code: 'BAD_INPUT' })
    }
    return sendText(request, reply, jid)
  })
}
