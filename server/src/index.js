import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'
import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { db } from './db/index.js'
import { requireSession } from './middleware/session.js'
import { createWAClient } from './wa/client.js'

// Route imports
import authRoutes from './api/auth.js'
import tokenRoutes from './api/tokens.js'
import personalRoutes from './api/personal.js'
import othersRoutes from './api/others.js'
import groupsRoutes from './api/groups.js'
import channelRoutes from './api/channels.js'
import messageRoutes from './api/messages.js'
import tabRoutes from './api/tabs.js'
import whitelistRoutes from './api/whitelist.js'
import wsRoutes from './ws/index.js'

const fastify = Fastify({
  logger: {
    level: config.nodeEnv === 'development' ? 'info' : 'warn',
  },
  trustProxy: true,
})

// Event bus for WA events → WS broadcast
const eventBus = new EventEmitter()
eventBus.waStatus = 'close'
eventBus.lastQr = null
fastify.decorate('eventBus', eventBus)
fastify.decorate('requireSession', requireSession)

// Plugins
await fastify.register(cors, {
  origin: false,
})

await fastify.register(cookie)

await fastify.register(session, {
  secret: config.jwtSecret,
  cookie: {
    secure: config.cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
})

await fastify.register(websocket)

if (config.rateLimitLogin > 0) {
  await fastify.register(rateLimit, {
    max: config.rateLimitLogin,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    // Only apply global rate limit to login
    allowList: (request) => !request.url.startsWith('/auth/login'),
  })
}

// Health check
fastify.get('/health', async () => ({
  ok: true,
  wa: eventBus.waStatus,
  uptime: Math.floor(process.uptime()),
}))

// Register routes
await fastify.register(authRoutes)
await fastify.register(tokenRoutes)
await fastify.register(personalRoutes)
await fastify.register(othersRoutes)
await fastify.register(groupsRoutes)
await fastify.register(channelRoutes)
await fastify.register(messageRoutes)
await fastify.register(tabRoutes)
await fastify.register(whitelistRoutes)
await fastify.register(wsRoutes)

// Force resolve unnamed contacts using Baileys
fastify.post('/admin/resolve-contacts', {
  preHandler: requireSession,
}, async (request, reply) => {
  const { ensureConnected } = await import('./wa/client.js')
  const sock = ensureConnected()
  if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

  const unnamed = db.prepare(
    "SELECT jid FROM channel_meta WHERE display_name IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.jid = channel_meta.jid AND m.type != 'unknown')"
  ).all()

  let resolved = 0
  for (const { jid } of unnamed) {
    try {
      if (jid.endsWith('@g.us')) {
        const meta = await sock.groupMetadata(jid)
        if (meta?.subject) {
          db.prepare('UPDATE channel_meta SET display_name = ? WHERE jid = ?').run(meta.subject, jid)
          resolved++
        }
      }
    } catch (_) {}
  }

  return { ok: true, checked: unnamed.length, resolved }
})

// General send — for web UI session (sends to any JID directly)
fastify.post('/send', {
  preHandler: requireSession,
}, async (request, reply) => {
  const { jid, message } = request.body || {}
  if (!jid || !message) {
    return reply.code(400).send({ error: 'Fields "jid" and "message" required', code: 'BAD_INPUT' })
  }
  const { ensureConnected } = await import('./wa/client.js')
  const sock = ensureConnected()
  if (!sock) {
    return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
  }
  const result = await sock.sendMessage(jid, { text: message })
  return { ok: true, messageId: result.key.id }
})

// LLM summary stub — deferred to Phase 2
fastify.get('/channels/:jid/summary', {
  preHandler: async (request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' })
  },
}, async () => {})

// Serve saved media files
fastify.get('/media/:sha256', { preHandler: requireSession }, async (request, reply) => {
  const { sha256 } = request.params
  const msg = db.prepare('SELECT media_mime, media_path FROM messages WHERE media_sha256 = ? AND media_saved = 1').get(sha256)
  if (!msg?.media_path) {
    return reply.code(404).send({ error: 'Media not found', code: 'NOT_FOUND' })
  }
  const { createReadStream } = await import('node:fs')
  reply.header('Content-Type', msg.media_mime || 'application/octet-stream')
  return reply.send(createReadStream(msg.media_path))
})

// Start server
try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  fastify.log.info(`Server listening on port ${config.port}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

// Start WhatsApp client
createWAClient(config.waSessionPath, eventBus).catch(err => {
  fastify.log.error('Failed to start WhatsApp client:', err.message)
})
