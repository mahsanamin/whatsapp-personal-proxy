import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

const SCOPE_GROUPS = {
  Personal: ['personal:send'],
  Others: ['others:send', 'others:whitelist:read', 'others:whitelist:manage'],
  Groups: ['groups:send'],
  'Chats & Messages': ['channels:read', 'channels:summarize'],
  Tabs: ['tabs:manage'],
  Admin: ['wa:admin'],
}

const SCOPE_LABELS = {
  'personal:send': 'Send to personal numbers',
  'others:send': 'Send to allowed contacts',
  'others:whitelist:read': 'View allow list',
  'others:whitelist:manage': 'Manage allow list',
  'groups:send': 'Send to allowed groups',
  'channels:read': 'Read all chats & messages',
  'channels:summarize': 'Summarize chats & messages',
  'tabs:manage': 'Manage tabs',
  'wa:admin': 'Manage WhatsApp connection',
}

export default function Tokens() {
  const [tokens, setTokens] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState([])
  const [newToken, setNewToken] = useState(null)
  const [copied, setCopied] = useState(false)
  const [install, setInstall] = useState(null)
  const [copiedInstall, setCopiedInstall] = useState(false)

  const load = () => api('/tokens').then(setTokens).catch(() => {})
  useEffect(() => { load() }, [])
  useEffect(() => { api('/cli/install-command').then(setInstall).catch(() => {}) }, [])

  const copyInstall = () => {
    navigator.clipboard.writeText(`${install.install}\n${install.connect}`)
    setCopiedInstall(true)
    setTimeout(() => setCopiedInstall(false), 2000)
  }

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
      setShowCreate(false)
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
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/30">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-neutral-500 hover:text-white transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-base font-semibold text-neutral-200">API Keys</h1>
            <Link to="/whitelist" className="text-xs text-neutral-500 hover:text-accent transition-colors ml-2">Allow list</Link>
          </div>
          <button
            onClick={() => { setShowCreate(!showCreate); setNewToken(null) }}
            className={`text-xs font-medium px-4 py-2 rounded-lg transition-all
              ${showCreate
                ? 'bg-neutral-800 text-neutral-400 hover:text-white'
                : 'bg-accent hover:bg-emerald-400 text-black'
              }`}
          >
            {showCreate ? 'Cancel' : 'Create Key'}
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        {/* New token display */}
        {newToken && (
          <div className="mb-6 bg-yellow-950/30 border border-yellow-900/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span className="text-yellow-400 text-xs font-medium">This key will not be shown again. Copy it now.</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-bg rounded-lg px-4 py-2.5 text-sm font-mono text-white break-all border border-neutral-800">
                {newToken}
              </code>
              <button onClick={copyToken} className="bg-accent hover:bg-emerald-400 text-black rounded-lg px-4 py-2.5 text-sm font-medium transition-all flex-shrink-0">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            {install && (
              <p className="text-[11px] text-neutral-500 mt-3">
                On the other machine: <code className="text-neutral-400">{install.connect}</code> and paste this key when prompted.
              </p>
            )}
          </div>
        )}

        {/* CLI bootstrap — everything a new machine needs */}
        {install && (
          <div className="mb-6 bg-neutral-900/50 border border-neutral-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-medium text-neutral-200">Use WPP from another machine</h2>
                <p className="text-[11px] text-neutral-500 mt-0.5">
                  Install the <code className="text-neutral-400">wpp</code> CLI, then connect it with a key from this page. Python 3.9+, no other dependencies.
                </p>
              </div>
              <button
                onClick={copyInstall}
                className="text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg px-3 py-1.5 transition-all flex-shrink-0"
              >
                {copiedInstall ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-bg border border-neutral-800 rounded-lg px-4 py-3 text-[11px] font-mono text-neutral-300 overflow-x-auto">
{install.install}
{'\n'}
{install.connect}
            </pre>
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <form onSubmit={create} className="mb-6 bg-neutral-900/50 border border-neutral-800 rounded-xl p-5">
            <label className="block text-[11px] text-neutral-500 mb-1.5 font-medium uppercase tracking-wider">Key Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50 transition-all mb-5"
              placeholder="e.g. My Bot, Automation Script"
              autoFocus
            />

            <label className="block text-[11px] text-neutral-500 mb-3 font-medium uppercase tracking-wider">Permissions</label>
            <div className="space-y-4 mb-6">
              {Object.entries(SCOPE_GROUPS).map(([group, groupScopes]) => (
                <div key={group}>
                  <span className="text-xs text-neutral-300 font-medium">{group}</span>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    {groupScopes.map(scope => (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => toggleScope(scope)}
                        className={`text-left px-3 py-1.5 rounded-lg transition-all
                          ${scopes.includes(scope)
                            ? 'bg-accent/20 text-accent border border-accent/40'
                            : 'bg-neutral-800/60 text-neutral-500 border border-neutral-700 hover:text-white hover:border-neutral-600'
                          }`}
                      >
                        <span className="block text-xs">{SCOPE_LABELS[scope]}</span>
                        <span className="block text-[10px] font-mono opacity-70 mt-0.5">{scope}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="submit"
              disabled={!name || scopes.length === 0}
              className="bg-accent hover:bg-emerald-400 disabled:opacity-30 text-black font-semibold rounded-xl px-6 py-2.5 text-sm transition-all"
            >
              Create API Key
            </button>
          </form>
        )}

        {/* Token list */}
        <div className="space-y-2">
          {tokens.length === 0 && !showCreate && (
            <div className="text-center py-12">
              <div className="w-12 h-12 rounded-2xl bg-neutral-800/50 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-neutral-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <p className="text-neutral-500 text-sm">No API keys yet</p>
              <p className="text-neutral-600 text-xs mt-1">Create one to access WPP from scripts and bots</p>
            </div>
          )}
          {tokens.map(t => (
            <div key={t.id} className={`bg-neutral-900/50 border border-neutral-800 rounded-xl p-4 ${t.revoked ? 'opacity-40' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-neutral-200">{t.name}</span>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-neutral-600">
                    {t.last_used ? `Used ${new Date(t.last_used).toLocaleDateString()}` : 'Never used'}
                  </span>
                  {!t.revoked ? (
                    <button onClick={() => revoke(t.id)} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                      Revoke
                    </button>
                  ) : (
                    <span className="text-xs text-neutral-600">Revoked</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {t.scopes.map(s => (
                  <span key={s} className="bg-neutral-800/80 text-neutral-400 rounded px-2 py-1">
                    <span className="block text-[11px]">{SCOPE_LABELS[s]}</span>
                    <span className="block text-[9px] font-mono text-neutral-500 mt-0.5">{s}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
