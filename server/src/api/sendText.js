import { refuseIfNotAllowed } from '../util/sendPermission.js'
import { loadRawMessage } from '../util/messageRef.js'
import { ensureConnected, recordSentMessage } from '../wa/client.js'
import { config } from '../config.js'

export const sendRateLimit = config.rateLimitSend > 0
  ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
  : {}

/** Shared body handling for the three text-send routes. */
export async function sendText(request, reply, jid) {
  const { message, reply_to: replyTo } = request.body || {}
  if (!message) {
    return reply.code(400).send({ error: 'Field "message" required', code: 'BAD_INPUT' })
  }
  if (refuseIfNotAllowed(request, reply, jid)) return

  const sock = ensureConnected()
  if (!sock) {
    return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
  }

  const options = {}
  if (replyTo) {
    const quoted = loadRawMessage(replyTo)
    if (!quoted) {
      return reply.code(404).send({ error: 'Message to reply to was not found', code: 'NOT_FOUND' })
    }
    options.quoted = quoted
  }

  const result = await sock.sendMessage(jid, { text: message }, options)
  recordSentMessage(result)
  return { ok: true, messageId: result.key.id, to: jid, ...(replyTo ? { reply_to: replyTo } : {}) }
}
