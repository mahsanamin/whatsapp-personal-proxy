import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'
import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { db } from './db/index.js'
import { SqliteSessionStore } from './db/sessionStore.js'
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
import cliRoutes from './api/cli.js'
import eventRoutes from './api/events.js'
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

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

await fastify.register(session, {
  secret: config.jwtSecret,
  // Persisted in SQLite; the default in-memory store signed the owner out of
  // the console on every restart.
  store: new SqliteSessionStore({ ttlMs: SESSION_TTL_MS }),
  cookie: {
    secure: config.cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  },
})

await fastify.register(websocket)

// Registered non-globally: routes opt in via `config.rateLimit`, so the login
// and send limits can differ and either can be switched off with a 0.
await fastify.register(rateLimit, {
  global: false,
  keyGenerator: (request) => request.ip,
})

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
await fastify.register(cliRoutes)
await fastify.register(eventRoutes)
await fastify.register(wsRoutes)

// Force resolve unnamed contacts and groups.
//
// Address-book names are not something this server can look up on demand:
// WhatsApp pushes them to a linked device through app-state sync, the same
// mechanism WhatsApp Web relies on. So ask for that sync again, then fill in
// group subjects (which *can* be fetched directly) and re-propagate names
// across each contact's two JIDs.
fastify.post('/admin/resolve-contacts', {
  preHandler: requireSession,
}, async (request, reply) => {
  const { ensureConnected } = await import('./wa/client.js')
  const { backfillLidMap } = await import('./db/lidmap.js')
  const sock = ensureConnected()
  if (!sock) return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })

  const before = db.prepare('SELECT COUNT(*) AS c FROM channel_meta WHERE display_name IS NOT NULL').get().c

  // Contact names live in these app-state collections. Re-requesting them is
  // the only way to pull address-book names down to a companion device.
  let appStateError = null
  try {
    await sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true)
  } catch (err) {
    appStateError = err?.message || String(err)
  }

  // Group subjects can be fetched directly.
  const unnamedGroups = db.prepare(
    "SELECT jid FROM channel_meta WHERE display_name IS NULL AND jid LIKE '%@g.us'"
  ).all()

  let groupsResolved = 0
  for (const { jid } of unnamedGroups) {
    try {
      const meta = await sock.groupMetadata(jid)
      if (meta?.subject) {
        db.prepare('UPDATE channel_meta SET display_name = ? WHERE jid = ?').run(meta.subject, jid)
        groupsResolved++
      }
    } catch (_) {}
  }

  // resyncAppState resolves as soon as the request is acknowledged; the
  // contact records arrive afterwards as events. Measuring straight away
  // reported "gained: 0" while hundreds of names were still landing, so wait
  // for the count to stop moving before answering.
  const countNamed = () =>
    db.prepare('SELECT COUNT(*) AS c FROM channel_meta WHERE display_name IS NOT NULL').get().c

  let after = countNamed()
  let settled = 0
  for (let waited = 0; waited < 30_000 && settled < 3; waited += 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const now = countNamed()
    settled = now === after ? settled + 1 : 0
    after = now
  }

  const backfilled = backfillLidMap()
  after = countNamed()

  return {
    ok: true,
    named_before: before,
    named_after: after,
    gained: after - before,
    groups_resolved: groupsResolved,
    lid_mappings: backfilled.mappings,
    app_state_error: appStateError,
  }
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
