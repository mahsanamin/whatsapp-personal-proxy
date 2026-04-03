import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

export default function Connect() {
  const navigate = useNavigate()
  const [qr, setQr] = useState(null)
  const [status, setStatus] = useState('checking')

  useEffect(() => {
    // Check current status
    api('/auth/wa/status').then(data => {
      if (data.status === 'open') {
        navigate('/')
        return
      }

      setStatus(data.status)

      // Open SSE for QR
      const evtSource = new EventSource('/api/auth/wa/qr')
      evtSource.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'qr') {
          setQr(msg.data)
          setStatus('scan')
        }
        if (msg.type === 'connected') {
          setStatus('connected')
          evtSource.close()
          setTimeout(() => navigate('/'), 1000)
        }
      }
      evtSource.onerror = () => {
        evtSource.close()
      }

      return () => evtSource.close()
    })
  }, [navigate])

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-bg">
      <h1 className="text-lg font-mono font-semibold text-accent mb-8">Connect WhatsApp</h1>

      {status === 'checking' && (
        <p className="text-neutral-500 font-mono text-sm">Checking connection...</p>
      )}

      {status === 'scan' && qr && (
        <div className="border border-border p-4 bg-white">
          <img src={qr} alt="QR Code" className="w-64 h-64" />
        </div>
      )}

      {status === 'scan' && (
        <p className="text-neutral-500 font-mono text-sm mt-4">
          Scan with WhatsApp &gt; Linked Devices &gt; Link a Device
        </p>
      )}

      {status === 'connecting' && (
        <p className="text-yellow-500 font-mono text-sm">Connecting...</p>
      )}

      {status === 'connected' && (
        <p className="text-accent font-mono text-sm">Connected! Redirecting...</p>
      )}

      {status === 'close' && !qr && (
        <p className="text-neutral-500 font-mono text-sm">Waiting for QR code...</p>
      )}
    </div>
  )
}
