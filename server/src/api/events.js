import { requireScope } from '../middleware/token.js'

/**
 * Server-Sent Events stream of live WhatsApp activity.
 *
 * The WebSocket at /ws serves the browser. This SSE endpoint exists so the
 * dependency-free `wpp` CLI can stream with nothing but the standard library.
 */
export default async function eventRoutes(fastify) {
  fastify.get('/events', {
    preHandler: requireScope('channels:read'),
  }, (request, reply) => {
    const { jid, type } = request.query
    const only = jid ? new Set(jid.split(',').map(s => s.trim()).filter(Boolean)) : null

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const eventBus = fastify.eventBus
    let open = true

    const write = (event, data) => {
      if (!open) return
      try {
        reply.raw.write(`data: ${JSON.stringify({ event, data })}\n\n`)
      } catch (_) {
        cleanup()
      }
    }

    write('ready', { wa: eventBus.waStatus || 'close' })

    const onMessage = (msg) => {
      if (only && !only.has(msg.jid)) return
      if (type && msg.type !== type) return
      write('message.new', msg)
    }
    const onStatus = (data) => write('wa.status', data)
    const onChannel = (data) => write('channel.update', data)

    eventBus.on('message.new', onMessage)
    eventBus.on('wa.status', onStatus)
    eventBus.on('channel.update', onChannel)

    // Keep proxies from closing an idle stream
    const heartbeat = setInterval(() => {
      if (!open) return
      try { reply.raw.write(': ping\n\n') } catch (_) { cleanup() }
    }, 25_000)

    function cleanup() {
      if (!open) return
      open = false
      clearInterval(heartbeat)
      eventBus.off('message.new', onMessage)
      eventBus.off('wa.status', onStatus)
      eventBus.off('channel.update', onChannel)
    }

    request.raw.on('close', cleanup)
    reply.raw.on('error', cleanup)
  })
}
