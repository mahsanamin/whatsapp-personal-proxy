import { useState } from 'react'
import { api } from '../api/client'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api('/auth/login', { method: 'POST', body: { username, password } })
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
            className="w-full bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50 transition-all mb-6"
            placeholder="Enter password"
          />

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
