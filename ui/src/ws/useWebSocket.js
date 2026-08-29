import { useEffect, useRef, useCallback, useState } from 'react'

export function useWebSocket({ onMessage, onStatus }) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)

  // The socket is opened once, so a handler captured in that effect would see
  // the state of the first render forever — which is why an incoming message
  // never landed in the open conversation while the chat list still updated.
  // Route through a ref so the live socket always calls the current handlers.
  const handlers = useRef({ onMessage, onStatus })
  handlers.current = { onMessage, onStatus }

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let timer = null

    const connect = () => {
      if (disposed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?session=1`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
      }

      ws.onclose = () => {
        setConnected(false)
        if (disposed) return
        // Actually reconnect. This previously just cleared the ref, so a
        // dropped socket stayed dead until the page was reloaded.
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 30000))
      }

      ws.onerror = () => ws.close()

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.event === 'message.new') handlers.current.onMessage?.(msg.data)
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
