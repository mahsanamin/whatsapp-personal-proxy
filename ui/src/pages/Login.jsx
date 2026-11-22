import { useState } from 'react'
import { api } from '../api/client'

const REMEMBER_OPTIONS = [
  { value: '30d', label: '30 days' },
  { value: '60d', label: '60 days' },
  { value: 'forever', label: 'Forever' },
]

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [remember, setRemember] = useState(false)
  const [rememberFor, setRememberFor] = useState('30d')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api('/auth/login', { method: 'POST', body: { username, password, ...(remember ? { remember: rememberFor } : {}) } })
      onLogin()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-bg">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/20 mb-4">
            <span className="text-2xl font-mono font-bold text-accent">W</span>
          </div>
          <h1 className="text-lg font-semibold text-neutral-200">Welcome to WPP</h1>
          <p className="text-xs text-neutral-500 mt-1">WhatsApp Personal Proxy</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6">
          {error && (
            <div className="mb-4 text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <label className="block text-[11px] text-neutral-500 mb-1.5 font-medium uppercase tracking-wider">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50 transition-all mb-4"
            placeholder="admin"
            autoFocus
          />

          <label className="block text-[11px] text-neutral-500 mb-1.5 font-medium uppercase tracking-wider">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50 transition-all mb-4"
            placeholder="Enter password"
          />

          <div className="flex items-center justify-between gap-3 mb-6">
            <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-3.5 h-3.5 accent-emerald-500"
              />
              Remember me
            </label>
            <select
              value={rememberFor}
              onChange={(e) => setRememberFor(e.target.value)}
              disabled={!remember}
              aria-label="Remember me for"
              className="bg-neutral-800/60 rounded-lg px-2 py-1 text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-40"
            >
              {REMEMBER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold rounded-xl py-2.5 text-sm transition-all"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
