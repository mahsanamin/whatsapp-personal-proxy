import { useEffect, useRef, useCallback, useState } from 'react'
import { signalUnauthorized } from '../api/client'

export function useWebSocket({ onMessage, onStatus, onChannelUpdate, onReconnect }) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)

  // The socket is opened once, so a handler captured in that effect would see
  // the state of the first render forever — which is why an incoming message
  // never landed in the open conversation while the chat list still updated.
  // Route through a ref so the live socket always calls the current handlers.
  const handlers = useRef({ onMessage, onStatus, onChannelUpdate, onReconnect })
  handlers.current = { onMessage, onStatus, onChannelUpdate, onReconnect }

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let timer = null
    let wasOpen = false
    let rejected = false

    const connect = () => {
      if (disposed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?session=1`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        // Events sent while the socket was down are not replayed, so whatever
        // arrived in the gap has to be fetched again.
        if (wasOpen) handlers.current.onReconnect?.()
        wasOpen = true
      }

      ws.onclose = () => {
        setConnected(false)
        if (disposed) return
        // Retrying a refused session would loop forever behind a page that
        // looks fine. Hand over to the login screen instead.
        if (rejected) return
        // Actually reconnect. This previously just cleared the ref, so a
        // dropped socket stayed dead until the page was reloaded.
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 30000))
      }

      ws.onerror = () => ws.close()

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.error === 'Unauthorized') {
            rejected = true
            signalUnauthorized()
            return
          }
          if (msg.event === 'message.new') handlers.current.onMessage?.(msg.data)
          if (msg.event === 'channel.update') handlers.current.onChannelUpdate?.(msg.data)
          if (msg.event === 'wa.status') handlers.current.onStatus?.(msg.data)
        } catch (e) {
          // Ignore malformed frames
        }
      }
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(timer)
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { connected, send }
}
