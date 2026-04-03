import crypto from 'node:crypto'
import { config } from '../config.js'

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export default async function authRoutes(fastify) {
  fastify.post('/auth/login', async (request, reply) => {
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

  fastify.post('/auth/logout', async (request) => {
    request.session.destroy()
    return { ok: true }
  })

  fastify.get('/auth/wa/status', async () => {
    const eventBus = fastify.eventBus
    return {
      status: eventBus.waStatus || 'close',
      qr: eventBus.lastQr || null,
    }
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
    const { createWAClient } = await import('../wa/client.js')
    createWAClient(config.waSessionPath, fastify.eventBus)
    return { ok: true, message: 'Reconnecting...' }
  })
}
