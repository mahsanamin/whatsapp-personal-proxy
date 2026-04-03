import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

const SCOPE_GROUPS = {
  Personal: ['personal:send'],
  Others: ['others:send', 'others:whitelist:read', 'others:whitelist:manage'],
  Groups: ['groups:send'],
  Channels: ['channels:read', 'channels:summarize'],
  Tabs: ['tabs:manage'],
  Admin: ['wa:admin'],
}

export default function Tokens() {
  const [tokens, setTokens] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState([])
  const [newToken, setNewToken] = useState(null)
  const [copied, setCopied] = useState(false)

  const load = () => api('/tokens').then(setTokens).catch(() => {})

  useEffect(() => { load() }, [])

  const toggleScope = (scope) => {
    setScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope])
  }

  const create = async (e) => {
    e.preventDefault()
    if (!name || scopes.length === 0) return
    try {
      const result = await api('/tokens', { method: 'POST', body: { name, scopes } })
      setNewToken(result.token)
      setName('')
      setScopes([])
      load()
    } catch (_) {}
  }

  const revoke = async (id) => {
    await api(`/tokens/${id}`, { method: 'DELETE' })
    load()
  }

  const copyToken = () => {
    navigator.clipboard.writeText(newToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="min-h-screen bg-bg p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-mono font-semibold text-accent">API Tokens</h1>
          <div className="flex gap-3">
            <button onClick={() => { setShowCreate(!showCreate); setNewToken(null) }} className="text-sm font-mono text-accent border border-accent px-3 py-1 hover:bg-accent hover:text-black">
              {showCreate ? 'Cancel' : '+ New Token'}
            </button>
            <Link to="/" className="text-sm font-mono text-neutral-500 border border-border px-3 py-1 hover:text-white">
              Back
            </Link>
          </div>
        </div>

        {/* New token display */}
        {newToken && (
          <div className="mb-6 border border-yellow-700 bg-yellow-950 p-4">
            <p className="text-yellow-400 text-xs font-mono mb-2">This token will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-bg border border-border px-3 py-2 text-sm font-mono text-white break-all">
                {newToken}
              </code>
              <button onClick={copyToken} className="text-sm font-mono text-accent border border-accent px-3 py-1 hover:bg-accent hover:text-black">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <form onSubmit={create} className="mb-6 border border-border p-4 bg-surface">
            <label className="block text-xs text-neutral-500 mb-1 font-mono">NAME</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg border border-border px-3 py-2 text-sm mb-4 outline-none focus:border-accent"
              placeholder="e.g. My Bot"
            />

            <label className="block text-xs text-neutral-500 mb-2 font-mono">SCOPES</label>
            <div className="space-y-3 mb-4">
              {Object.entries(SCOPE_GROUPS).map(([group, groupScopes]) => (
                <div key={group}>
                  <span className="text-xs text-neutral-400 font-mono">{group}</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {groupScopes.map(scope => (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => toggleScope(scope)}
                        className={`text-xs font-mono px-2 py-1 border ${
                          scopes.includes(scope)
                            ? 'border-accent text-accent bg-emerald-950'
                            : 'border-border text-neutral-500 hover:text-white'
                        }`}
                      >
                        {scope}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <button type="submit" className="bg-accent text-black font-mono font-semibold py-2 px-4 text-sm hover:bg-emerald-400">
              Create Token
            </button>
          </form>
        )}

        {/* Token list */}
        <div className="border border-border">
          <div className="grid grid-cols-[1fr_2fr_auto_auto] gap-4 px-4 py-2 bg-surface text-xs font-mono text-neutral-500 border-b border-border">
            <span>Name</span>
            <span>Scopes</span>
            <span>Last Used</span>
            <span></span>
          </div>
          {tokens.length === 0 && (
            <div className="px-4 py-6 text-center text-neutral-600 text-sm font-mono">No tokens yet</div>
          )}
          {tokens.map(t => (
            <div key={t.id} className={`grid grid-cols-[1fr_2fr_auto_auto] gap-4 px-4 py-3 border-b border-border items-center ${t.revoked ? 'opacity-40' : ''}`}>
              <span className="text-sm">{t.name}</span>
              <div className="flex flex-wrap gap-1">
                {t.scopes.map(s => (
                  <span key={s} className="text-xs font-mono bg-neutral-900 border border-border px-1.5 py-0.5">
                    {s}
                  </span>
                ))}
              </div>
              <span className="text-xs text-neutral-600 font-mono">
                {t.last_used ? new Date(t.last_used).toLocaleDateString() : 'never'}
              </span>
              {!t.revoked ? (
                <button onClick={() => revoke(t.id)} className="text-xs font-mono text-red-400 hover:text-red-300">
                  Revoke
                </button>
              ) : (
                <span className="text-xs font-mono text-neutral-600">Revoked</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
