import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

export default function Connect() {
  const navigate = useNavigate()
  const [qr, setQr] = useState(null)
  const [status, setStatus] = useState('checking') // checking | waiting | scan | expired | linking
  const [refreshing, setRefreshing] = useState(false)
  const [autoTries, setAutoTries] = useState(0)

  const refreshQr = async () => {
    setRefreshing(true)
    setQr(null)
    setStatus('waiting')
    try {
      await api('/auth/wa/refresh-qr', { method: 'POST' })
    } catch (_) {}
    setTimeout(() => setRefreshing(false), 3000)
  }

  // WhatsApp emits QR codes in bursts with quiet gaps of up to a minute in
  // between, and the server hides a code once it is too stale to scan. Asking
  // for a fresh one takes about four seconds, so do it automatically rather
  // than leave the user looking at "expired". Capped, so an unreachable
  // WhatsApp does not reconnect in a loop.
  const AUTO_REFRESH_LIMIT = 5
  useEffect(() => {
    if (status !== 'expired' || refreshing || autoTries >= AUTO_REFRESH_LIMIT) return
    const timer = setTimeout(() => {
      setAutoTries(n => n + 1)
      refreshQr()
    }, 3000)
    return () => clearTimeout(timer)
  }, [status, refreshing, autoTries])

  useEffect(() => {
    // `linked` is authoritative. The QR vanishing is not: the server nulls a
    // stale code after 25s, so a rotation gap used to look like a successful
    // scan and threw the user into an empty workspace.
    const apply = (data) => {
      if (data.status === 'open') {
        navigate('/')
        return true
      }
      if (data.linked) {
        setStatus('linking')
        setQr(null)
        return false
      }
      if (data.qr) {
        setQr(data.qr)
        setStatus('scan')
        setRefreshing(false)
      } else {
        setQr(null)
        if (!refreshing) setStatus('expired')
      }
      return false
    }

    const poll = setInterval(() => {
      api('/auth/wa/status')
        .then(data => { if (apply(data)) clearInterval(poll) })
        .catch(() => {})
    }, 1500)

    api('/auth/wa/status').then(apply).catch(() => {})

    return () => clearInterval(poll)
  }, [navigate, refreshing])

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-bg">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/20 mb-6">
          <span className="text-2xl font-mono font-bold text-accent">W</span>
        </div>

        <h1 className="text-lg font-semibold text-neutral-200 mb-2">Connect WhatsApp</h1>
        <p className="text-xs text-neutral-500 mb-8">Link your device to start using WPP</p>

        {/* Checking */}
        {status === 'checking' && (
          <div className="flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-neutral-600 animate-pulse" />
            <p className="text-neutral-500 text-sm">Checking connection...</p>
          </div>
        )}

        {/* QR Code visible */}
        {status === 'scan' && qr && (
          <div className="inline-block">
            <div className="bg-white rounded-2xl p-5 shadow-2xl shadow-accent/5">
              <img src={qr} alt="QR Code" className="w-64 h-64" />
            </div>
            <div className="flex items-center justify-center gap-2 mt-3">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <p className="text-neutral-500 text-[11px]">Scan this code quickly before it expires</p>
            </div>
            <div className="mt-6 space-y-2">
              <p className="text-neutral-300 text-sm font-medium">Scan with WhatsApp</p>
              <div className="text-neutral-500 text-xs space-y-1">
                <p>1. Open WhatsApp on your phone</p>
                <p>2. Go to Settings &gt; Linked Devices</p>
                <p>3. Tap "Link a Device"</p>
                <p>4. Point your camera at the QR code</p>
              </div>
            </div>
            <button
              onClick={refreshQr}
              disabled={refreshing}
              className="mt-4 text-neutral-500 hover:text-accent text-xs transition-colors disabled:opacity-50"
            >
              Having trouble? Refresh QR Code
            </button>
          </div>
        )}

        {/* Linking in progress — scanned, connecting */}
        {status === 'linking' && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-3 border-accent/20 border-t-accent rounded-full animate-spin" />
            <div>
              <p className="text-neutral-200 text-sm font-medium">Linking your device...</p>
              <p className="text-neutral-500 text-xs mt-1">This may take a moment</p>
            </div>
          </div>
        )}

        {/* No QR / Expired / Waiting */}
        {(status === 'expired' || status === 'waiting') && (
          <div className="flex flex-col items-center gap-4">
            {refreshing ? (
              <>
                <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                <p className="text-neutral-400 text-sm">Generating QR code...</p>
              </>
            ) : (
              <>
                <div className="w-12 h-12 rounded-2xl bg-neutral-800/50 flex items-center justify-center">
                  <svg className="w-6 h-6 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </div>
                <p className="text-neutral-400 text-sm">
                  {status !== 'expired' ? 'Preparing...'
                    : autoTries >= AUTO_REFRESH_LIMIT ? 'Could not reach WhatsApp. Try again?'
                    : 'Waiting for a fresh QR code...'}
                </p>
                <button
                  onClick={() => { setAutoTries(0); refreshQr() }}
                  className="bg-accent hover:bg-emerald-400 text-black px-5 py-2.5 rounded-lg text-sm font-medium transition-all"
                >
                  Generate QR Code
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
