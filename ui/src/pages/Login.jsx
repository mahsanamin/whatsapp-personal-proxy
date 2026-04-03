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
      await api('/auth/login', {
        method: 'POST',
        body: { username, password },
      })
      onLogin()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-bg">
      <form onSubmit={handleSubmit} className="w-80 p-6 border border-border bg-surface">
        <h1 className="text-lg font-mono font-semibold text-accent mb-6">wpp</h1>

        {error && (
          <div className="mb-4 text-sm text-red-400 border border-red-900 bg-red-950 p-2">
            {error}
          </div>
        )}

        <label className="block text-xs text-neutral-500 mb-1 font-mono">USERNAME</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-2 text-sm mb-4 outline-none focus:border-accent"
          autoFocus
        />

        <label className="block text-xs text-neutral-500 mb-1 font-mono">PASSWORD</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-2 text-sm mb-6 outline-none focus:border-accent"
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent text-black font-mono font-semibold py-2 text-sm hover:bg-emerald-400 disabled:opacity-50"
        >
          {loading ? 'Authenticating...' : 'Login'}
        </button>
      </form>
    </div>
  )
}
