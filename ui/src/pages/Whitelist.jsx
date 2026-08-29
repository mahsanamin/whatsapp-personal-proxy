import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

function Row({ children, tone = 'default' }) {
  const border = tone === 'personal' ? 'border-accent/30 bg-accent/5' : 'border-neutral-800 bg-neutral-900/50'
  return <div className={`border ${border} rounded-xl p-4 flex items-center justify-between gap-4`}>{children}</div>
}

export default function Whitelist() {
  const [entries, setEntries] = useState([])
  const [personal, setPersonal] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [manual, setManual] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () => api('/whitelist').then(setEntries).catch(() => {})

  useEffect(() => {
    load()
    api('/auth/test').then(d => setPersonal(d.personal_numbers || [])).catch(() => {})
  }, [])

  // Look chats up by name so a person can be allowed without anyone having to
  // know what a JID is.
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(() => {
      api(`/channels?search=${encodeURIComponent(query)}&limit=8`)
        .then(setResults)
        .catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const add = async (jid, entryLabel) => {
    setError(null)
    setBusy(true)
    try {
      await api('/whitelist', { method: 'POST', body: { jid, label: entryLabel || null } })
      setQuery(''); setResults([]); setManual(''); setLabel('')
      load()
    } catch (err) {
      setError(err.code === 'DUPLICATE' ? 'Already on the allow list.' : err.message)
    }
    setBusy(false)
  }

  const remove = async (id) => {
    await api(`/whitelist/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  const already = (jid) => entries.some(e => e.jid === jid)
  const pretty = (jid) => (jid.endsWith('@g.us') ? 'Group' : '+' + jid.split('@')[0])

  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-neutral-800 bg-neutral-900/30">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link to="/" className="text-neutral-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-base font-semibold text-neutral-200">Allow list</h1>
          <Link to="/tokens" className="ml-auto text-xs text-neutral-500 hover:text-accent transition-colors">API Keys</Link>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="mb-6 bg-neutral-900/40 border border-neutral-800 rounded-xl p-4">
          <p className="text-xs text-neutral-400 leading-relaxed">
            <span className="text-neutral-200 font-medium">This list only restricts API keys.</span>{' '}
            From this console you can message anyone. Anything using an API key — the
            <code className="text-accent mx-1">wpp</code> CLI, a script, an agent — can only reach
            your own numbers and the people and groups listed here.
          </p>
        </div>

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>
        )}

        {/* Add by searching your chats */}
        <div className="mb-6 bg-neutral-900/50 border border-neutral-800 rounded-xl p-5">
          <label className="block text-[11px] text-neutral-500 mb-2 font-medium uppercase tracking-wider">Allow someone</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your chats by name or number..."
            className="w-full bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50 transition-all"
          />

          {results.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {results.map(c => (
                <div key={c.jid} className="flex items-center justify-between gap-3 bg-neutral-800/40 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-neutral-200 truncate">{c.display_name || pretty(c.jid)}</p>
                    <p className="text-[11px] text-neutral-600 truncate">
                      {c.type === 'group' ? 'Group' : pretty(c.jid)}
                    </p>
                  </div>
                  <button
                    onClick={() => add(c.jid, c.display_name)}
                    disabled={busy || already(c.jid)}
                    className="text-xs bg-accent hover:bg-emerald-400 disabled:opacity-30 text-black font-medium rounded-lg px-3 py-1.5 transition-all flex-shrink-0"
                  >
                    {already(c.jid) ? 'Allowed' : 'Allow'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-neutral-800">
            <label className="block text-[11px] text-neutral-500 mb-2 font-medium uppercase tracking-wider">
              Or add a number directly
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="+923214461264"
                className="flex-1 bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50"
              />
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (optional)"
                className="w-44 bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50"
              />
              <button
                onClick={() => add(manual, label)}
                disabled={busy || !manual.trim()}
                className="bg-accent hover:bg-emerald-400 disabled:opacity-30 text-black font-semibold rounded-xl px-5 text-sm transition-all"
              >
                Allow
              </button>
            </div>
          </div>
        </div>

        {/* Always allowed */}
        {personal.length > 0 && (
          <>
            <h2 className="text-[11px] text-neutral-500 mb-2 font-medium uppercase tracking-wider">
              Your own numbers — always allowed
            </h2>
            <div className="space-y-2 mb-6">
              {personal.map(n => (
                <Row key={n} tone="personal">
                  <div>
                    <p className="text-sm text-neutral-200">{n}</p>
                    <p className="text-[11px] text-neutral-500">From PERSONAL_NUMBERS in .env</p>
                  </div>
                  <span className="text-[11px] text-accent">always allowed</span>
                </Row>
              ))}
            </div>
          </>
        )}

        <h2 className="text-[11px] text-neutral-500 mb-2 font-medium uppercase tracking-wider">
          Allowed for API keys ({entries.length})
        </h2>

        {entries.length === 0 ? (
          <div className="text-center py-10 border border-neutral-800 border-dashed rounded-xl">
            <p className="text-neutral-500 text-sm">Nobody is allowed yet</p>
            <p className="text-neutral-600 text-xs mt-1">
              API keys can currently only message your own numbers
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map(e => (
              <Row key={e.id}>
                <div className="min-w-0">
                  <p className="text-sm text-neutral-200 truncate">{e.label || pretty(e.jid)}</p>
                  <p className="text-[11px] text-neutral-600 font-mono truncate">{e.jid}</p>
                </div>
                <button
                  onClick={() => remove(e.id)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors flex-shrink-0"
                >
                  Remove
                </button>
              </Row>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
