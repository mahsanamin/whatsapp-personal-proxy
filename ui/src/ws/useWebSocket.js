import { useEffect, useRef, useCallback, useState } from 'react'

export function useWebSocket({ onMessage, onStatus }) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?session=1`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      // Reconnect after 3s
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }
      }, 3000)
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.event === 'message.new' && onMessage) {
          onMessage(msg.data)
        }
        if (msg.event === 'wa.status' && onStatus) {
          onStatus(msg.data)
        }
      } catch (e) {
        // ignore
      }
    }

    return () => {
      ws.close()
    }
  }, [])

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { connected, send }
}
