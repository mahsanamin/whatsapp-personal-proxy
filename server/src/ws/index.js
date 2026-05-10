import crypto from 'node:crypto'
import { db } from '../db/index.js'

export default async function wsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, (connection, request) => {
    // @fastify/websocket v8 passes connection object; .socket is the raw WebSocket
    const ws = connection.socket ?? connection

    const { token, session } = request.query

    // Authenticate
    let authenticated = false

    if (session && request.session?.authenticated) {
      authenticated = true
    }

    if (token) {
      const hash = crypto.createHash('sha256').update(token).digest('hex')
      const row = db.prepare('SELECT id, scopes, revoked FROM tokens WHERE token_hash = ?').get(hash)
      if (row && !row.revoked) {
        authenticated = true
        db.prepare('UPDATE tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.id)
      }
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ error: 'Unauthorized' }))
      ws.close()
      return
    }

    // Subscription state
    let subscribedJids = null // null = all
    let subscribedTabId = null

    const eventBus = fastify.eventBus

    const shouldForward = (jid) => {
      if (!subscribedJids && !subscribedTabId) return true
      if (subscribedJids && subscribedJids.has(jid)) return true
      if (subscribedTabId) {
        const channel = db.prepare('SELECT tab_id FROM channel_meta WHERE jid = ?').get(jid)
        if (channel?.tab_id === subscribedTabId) return true
      }
      return false
    }

    const safeSend = (data) => {
      if (ws.readyState === 1) ws.send(data)
    }

    const onMessage = (data) => {
      if (shouldForward(data.jid)) {
        safeSend(JSON.stringify({ event: 'message.new', data }))
      }
    }

    const onMessageUpdate = (data) => {
      safeSend(JSON.stringify({ event: 'message.update', data }))
    }

    const onWaStatus = (data) => {
      safeSend(JSON.stringify({ event: 'wa.status', data }))
    }

    const onChannelUpdate = (data) => {
      safeSend(JSON.stringify({ event: 'channel.update', data }))
    }

    eventBus.on('message.new', onMessage)
    eventBus.on('message.update', onMessageUpdate)
    eventBus.on('wa.status', onWaStatus)
    eventBus.on('channel.update', onChannelUpdate)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.action === 'subscribe' && Array.isArray(msg.jids)) {
          subscribedJids = new Set(msg.jids)
        }

        if (msg.action === 'subscribe_tab' && msg.tab_id) {
          subscribedTabId = msg.tab_id
        }

        if (msg.action === 'ping') {
          safeSend(JSON.stringify({ event: 'pong' }))
        }
      } catch (err) {
        // Ignore malformed messages
      }
    })

    ws.on('close', () => {
      eventBus.off('message.new', onMessage)
      eventBus.off('message.update', onMessageUpdate)
      eventBus.off('wa.status', onWaStatus)
      eventBus.off('channel.update', onChannelUpdate)
    })
  })
}
