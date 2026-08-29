import crypto from 'node:crypto'
import { config } from '../config.js'
import { identifyCaller } from '../middleware/token.js'
import { getSock, isLinked, clearSession } from '../wa/client.js'

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    config: config.rateLimitLogin > 0
      ? { rateLimit: { max: config.rateLimitLogin, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const { username, password } = request.body || {}

    if (!username || !password) {
      return reply.code(400).send({ error: 'Username and password required', code: 'BAD_INPUT' })
    }

    if (!constantTimeEqual(username, config.adminUser) || !constantTimeEqual(password, config.adminPass)) {
      return reply.code(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' })
    }

    request.session.authenticated = true
    return { ok: true }
  })

  // Connection test for the CLI: verifies the credential and reports what it
  // can do, plus the live WhatsApp link state. `wpp connect` calls this before
  // it will save a profile.
  fastify.get('/auth/test', async (request, reply) => {
    const caller = identifyCaller(request)
    if (!caller) {
      return reply.code(401).send({ error: 'Invalid or missing credential', code: 'UNAUTHORIZED' })
    }

    const sock = getSock()
    return {
      ok: true,
      auth: {
        type: caller.type,
        name: caller.name,
        scopes: caller.scopes,
        last_used: caller.last_used ?? null,
      },
      wa: {
        status: fastify.eventBus.waStatus || 'close',
        linked: isLinked(),
        user: sock?.user ? { id: sock.user.id, name: sock.user.name ?? null } : null,
      },
      server: {
        public_url: config.publicUrl,
        uptime: Math.floor(process.uptime()),
      },
      // Only revealed to a credential that could message them anyway; lets the
      // CLI pick personal/send vs others/send in one round trip.
      personal_numbers: caller.scopes.includes('personal:send') ? config.personalNumbers : undefined,
    }
  })

  fastify.post('/auth/logout', async (request) => {
    request.session.destroy()
    return { ok: true }
  })

  fastify.get('/auth/wa/status', async () => {
    const eventBus = fastify.eventBus
    const qrAge = eventBus.qrTimestamp ? Math.floor((Date.now() - eventBus.qrTimestamp) / 1000) : null
    // QR codes expire after ~20s on WhatsApp servers — mark stale ones
    const qrFresh = qrAge !== null && qrAge < 25
    return {
      status: eventBus.waStatus || 'close',
      // Whether a phone has ever completed pairing. `status` alone cannot tell
      // "never linked, waiting to be scanned" from "linked, reconnecting" —
      // both sit in `connecting`.
      linked: isLinked(),
      qr: qrFresh ? eventBus.lastQr : null,
      qr_age: qrAge,
    }
  })

  // Force fresh QR generation — resets retries and reconnects
  fastify.post('/auth/wa/refresh-qr', {
    preHandler: fastify.requireSession,
  }, async (request, reply) => {
    // Refreshing tears the socket down and rebuilds it. Doing that to an
    // already-linked account interrupts its sync for no reason, so refuse
    // unless the caller really means it.
    if (isLinked()) {
      return reply.code(409).send({
        error: 'WhatsApp is already linked. Unlink first to pair a different phone.',
        code: 'ALREADY_LINKED',
      })
    }

    const { createWAClient, resetRetries } = await import('../wa/client.js')
    resetRetries()
    const eventBus = fastify.eventBus
    eventBus.lastQr = null
    eventBus.qrTimestamp = null
    createWAClient(config.waSessionPath, eventBus)
    return { ok: true, message: 'Generating fresh QR code...' }
  })

  // Unlink this device and start over. Destroys the stored credentials, so the
  // next connection begins a fresh pairing.
  fastify.post('/auth/wa/logout', {
    preHandler: fastify.requireSession,
  }, async () => {
    const { createWAClient, resetRetries, getSock: sock } = await import('../wa/client.js')
    try { await sock()?.logout() } catch (_) {}
    clearSession()

    const eventBus = fastify.eventBus
    eventBus.lastQr = null
    eventBus.qrTimestamp = null
    resetRetries()
    createWAClient(config.waSessionPath, eventBus)
    return { ok: true, message: 'Unlinked. Scan a QR code to link again.' }
  })

  fastify.get('/auth/wa/qr', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const eventBus = fastify.eventBus

    // Send current QR if available
    if (eventBus.lastQr) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'qr', data: eventBus.lastQr })}\n\n`)
    }

    if (eventBus.waStatus === 'open') {
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      reply.raw.end()
      return
    }

    const onQr = (qr) => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'qr', data: qr })}\n\n`)
    }

    const onStatus = ({ status }) => {
      if (status === 'open') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
        cleanup()
        reply.raw.end()
      }
    }

    const cleanup = () => {
      eventBus.off('wa.qr', onQr)
      eventBus.off('wa.status', onStatus)
    }

    eventBus.on('wa.qr', onQr)
    eventBus.on('wa.status', onStatus)

    request.raw.on('close', cleanup)
  })

  fastify.post('/auth/wa/reconnect', {
    preHandler: fastify.requireSession,
  }, async () => {
    const { createWAClient, resetRetries } = await import('../wa/client.js')
    resetRetries()
    createWAClient(config.waSessionPath, fastify.eventBus)
    return { ok: true, message: 'Reconnecting...' }
  })
}
