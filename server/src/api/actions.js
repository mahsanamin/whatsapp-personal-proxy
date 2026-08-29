import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAnyCredential, requireScope } from '../middleware/token.js'
import { refuseIfNotAllowed } from '../util/sendPermission.js'
import { loadMessageKey, loadMessageMeta } from '../util/messageRef.js'
import { expandJids } from '../db/lidmap.js'
import { ensureConnected } from '../wa/client.js'

const sendRateLimit = config.rateLimitSend > 0
  ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
  : {}

export default async function actionRoutes(fastify) {
  // React to a message. An empty emoji removes your reaction, which is how
  // WhatsApp itself models "un-react".
  fastify.post('/messages/:id/react', {
    preHandler: requireAnyCredential,
    config: sendRateLimit,
  }, async (request, reply) => {
    const { id } = request.params
    const emoji = request.body?.emoji ?? ''

    const meta = loadMessageMeta(id)
    if (!meta) return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    if (refuseIfNotAllowed(request, reply, meta.jid)) return

    const key = loadMessageKey(id)
    if (!key) return reply.code(404).send({ error: 'Message key not available', code: 'NOT_FOUND' })

    const sock = ensureConnected()
    if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

    await sock.sendMessage(meta.jid, { react: { text: emoji, key } })
    return { ok: true, id, emoji, removed: emoji === '' }
  })

  // Edit your own message. WhatsApp only permits this on messages you sent,
  // and only for a limited window after sending.
  fastify.post('/messages/:id/edit', {
    preHandler: requireAnyCredential,
    config: sendRateLimit,
  }, async (request, reply) => {
    const { id } = request.params
    const { message } = request.body || {}
    if (!message) return reply.code(400).send({ error: 'Field "message" required', code: 'BAD_INPUT' })

    const meta = loadMessageMeta(id)
    if (!meta) return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    if (!meta.is_from_me) {
      return reply.code(403).send({ error: 'Only your own messages can be edited', code: 'NOT_YOUR_MESSAGE' })
    }
    if (refuseIfNotAllowed(request, reply, meta.jid)) return

    const key = loadMessageKey(id)
    if (!key) return reply.code(404).send({ error: 'Message key not available', code: 'NOT_FOUND' })

    const sock = ensureConnected()
    if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

    try {
      const result = await sock.sendMessage(meta.jid, { text: message, edit: key })
      db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(message, id)
      return { ok: true, id, messageId: result?.key?.id ?? id }
    } catch (err) {
      return reply.code(502).send({ error: `WhatsApp refused the edit: ${err.message}`, code: 'EDIT_FAILED' })
    }
  })

  // Delete for everyone. Irreversible, and only valid on your own messages.
  fastify.delete('/messages/:id', {
    preHandler: requireAnyCredential,
    config: sendRateLimit,
  }, async (request, reply) => {
    const { id } = request.params

    const meta = loadMessageMeta(id)
    if (!meta) return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    if (!meta.is_from_me) {
      return reply.code(403).send({ error: 'Only your own messages can be deleted', code: 'NOT_YOUR_MESSAGE' })
    }
    if (refuseIfNotAllowed(request, reply, meta.jid)) return

    const key = loadMessageKey(id)
    if (!key) return reply.code(404).send({ error: 'Message key not available', code: 'NOT_FOUND' })

    const sock = ensureConnected()
    if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

    await sock.sendMessage(meta.jid, { delete: key })
    db.prepare("UPDATE messages SET body = NULL, type = 'deleted' WHERE id = ?").run(id)
    return { ok: true, id, deleted: true }
  })

  // Send read receipts to WhatsApp — the blue ticks the sender sees. Distinct
  // from marking a chat read locally, which only affects this server's unread
  // counts and is invisible to anyone else.
  fastify.post('/channels/:jid/receipts', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const jids = expandJids(request.params.jid)
    const sock = ensureConnected()
    if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

    const rows = db.prepare(
      `SELECT id FROM messages
       WHERE jid IN (${jids.map(() => '?').join(',')}) AND is_from_me = 0
       ORDER BY timestamp DESC LIMIT 100`
    ).all(...jids)

    const keys = rows.map(r => loadMessageKey(r.id)).filter(Boolean)
    if (keys.length === 0) return { ok: true, marked: 0 }

    try {
      await sock.readMessages(keys)
      return { ok: true, marked: keys.length }
    } catch (err) {
      return reply.code(502).send({ error: `WhatsApp refused the receipts: ${err.message}`, code: 'RECEIPT_FAILED' })
    }
  })

  // Typing / recording indicator, so an automated reply does not appear out of
  // nowhere. Values: composing, recording, paused.
  fastify.post('/channels/:jid/presence', {
    preHandler: requireAnyCredential,
  }, async (request, reply) => {
    const jid = request.params.jid
    const state = request.body?.state || 'composing'
    if (!['composing', 'recording', 'paused', 'available', 'unavailable'].includes(state)) {
      return reply.code(400).send({ error: `Unknown presence state "${state}"`, code: 'BAD_INPUT' })
    }
    if (refuseIfNotAllowed(request, reply, jid)) return

    const sock = ensureConnected()
    if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

    await sock.sendPresenceUpdate(state, jid)
    return { ok: true, jid, state }
  })
}
