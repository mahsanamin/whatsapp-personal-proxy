import { useEffect } from 'react'
import { api } from '../api/client'

// Only acknowledge a page which was loaded for the currently visible chat.
// Hidden tabs and failed/stale fetches must never silently consume unread messages.
export function useConversationRead({ jid, ready, messageId, timestamp, onRead }) {
  useEffect(() => {
    if (!jid || !ready || !timestamp) return
    let disposed = false
    let completed = false
    let pending = false
    let retry
    const controller = new AbortController()

    const acknowledge = async () => {
      if (disposed || completed || pending || document.visibilityState !== 'visible' || !document.hasFocus()) return
      pending = true
      try {
        const result = await api(`/channels/${encodeURIComponent(jid)}/read`, {
          method: 'POST', body: { up_to: timestamp }, signal: controller.signal,
        })
        if (!disposed) {
          completed = true
          onRead(jid, result)
        }
      } catch (_) {
        if (!disposed) retry = setTimeout(acknowledge, 3000)
      } finally {
        pending = false
      }
    }

    acknowledge()
    window.addEventListener('focus', acknowledge)
    document.addEventListener('visibilitychange', acknowledge)
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(retry)
      window.removeEventListener('focus', acknowledge)
      document.removeEventListener('visibilitychange', acknowledge)
    }
  }, [jid, ready, messageId, timestamp, onRead])
}
