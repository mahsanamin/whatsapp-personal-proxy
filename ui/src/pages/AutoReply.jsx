import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

const STARTER = `{
  "format": 1,
  "name": "My rule set",
  "version": "1.0.0",
  "description": "",
  "scope": { "allowlist": true, "all_dms": false, "chats": [], "blocklist": [] },
  "options": {
    "timezone": "Asia/Singapore",
    "cooldown_minutes": 60,
    "conversation": { "gap_minutes": 30, "max_replies": 5, "backoff_base_minutes": 1, "handoff_text": null }
  },
  "rules": [
    {
      "id": "hello",
      "match": { "keywords": ["hello", "hi"], "keywords_mode": "any" },
      "response": { "type": "text", "text": "Hi {first_name}! I'll reply soon." }
    }
  ]
}
`

const MODES = [
  { id: 'off', label: 'Off' },
  { id: 'dry_run', label: 'Dry run' },
  { id: 'live', label: 'Live' },
]

const ACTION_TONE = {
  sent: 'text-accent',
  dry_run: 'text-sky-400',
  skipped: 'text-neutral-500',
  failed: 'text-red-400',
}

const label = 'block text-[11px] text-neutral-500 mb-2 font-medium uppercase tracking-wider'
const input = 'bg-neutral-800/60 rounded-xl px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:ring-1 focus:ring-accent/50'
const card = 'bg-neutral-900/50 border border-neutral-800 rounded-xl p-5'
const smallButton = 'text-xs text-neutral-400 hover:text-white px-2 py-1 rounded hover:bg-neutral-800 transition-colors'

const formatTime = (ms) => (ms ? new Date(ms).toLocaleString('en-SG', { hour12: false }) : '')
const prettyJid = (jid) => {
  if (!jid) return ''
  if (jid.endsWith('@g.us')) return 'Group'
  if (jid.endsWith('@lid')) return jid
  return '+' + jid.split('@')[0]
}

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

const LIMIT_FIELDS = [
  { key: 'minGapSeconds', label: 'Delay between replies in a chat', unit: 'seconds' },
  { key: 'maxPerChatPerHour', label: 'Replies per contact per hour', unit: 'replies' },
  { key: 'maxPerChatPerDay', label: 'Replies per contact per day', unit: 'replies' },
  { key: 'maxPerHour', label: 'Replies per hour, all chats', unit: 'replies' },
  { key: 'maxAgeSeconds', label: 'Ignore messages older than', unit: 'seconds' },
]

/** Same rule as the server: a whole number inside the bounds. */
function limitProblem(value, bounds) {
  if (!bounds) return null
  const number = Number(value)
  if (value === '' || !Number.isInteger(number) || number < bounds.min || number > bounds.max) {
    return `Whole number from ${bounds.min} to ${bounds.max}`
  }
  return null
}

function ServerLimits({ settings, onChange }) {
  const [values, setValues] = useState({})
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!settings?.limits) return
    setValues(Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, String(settings.limits[key])])))
  }, [settings])

  if (!settings?.limits || !settings.bounds) return null

  const problems = Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, limitProblem(values[key], settings.bounds[key])]))
  const changed = LIMIT_FIELDS.filter(({ key }) => values[key] !== String(settings.limits[key]))
  const hasProblem = LIMIT_FIELDS.some(({ key }) => problems[key])

  const send = async (request, done) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      onChange(await request())
      setNote(done)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const save = () => send(
    () => api('/autoreply/limits', {
      method: 'PUT',
      body: Object.fromEntries(changed.map(({ key }) => [key, Number(values[key])])),
    }),
    'Saved. The next incoming message uses these limits.',
  )

  const reset = () => {
    if (!window.confirm('Reset every server limit to the defaults from .env?')) return
    send(() => api('/autoreply/limits', { method: 'DELETE' }), 'Reset to the defaults.')
  }

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-1">
        <h2 className={label + ' mb-0'}>Server limits</h2>
        <button onClick={reset} disabled={busy || !settings.overridden?.length} className={`${smallButton} disabled:opacity-40 disabled:hover:bg-transparent`}>
          Reset to defaults
        </button>
      </div>
      <p className="text-[11px] text-neutral-500 mb-4 leading-relaxed">
        Apply to every rule set. A rule set can be stricter than these, never looser. Changing them does not take a live rule set out of live mode.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        {LIMIT_FIELDS.map(({ key, label: text, unit }) => {
          const bounds = settings.bounds[key]
          const overridden = settings.overridden?.includes(key)
          return (
            <div key={key}>
              <label htmlFor={`limit-${key}`} className="block text-xs text-neutral-300 mb-1.5">
                {text}
                {overridden && <span className="ml-2 text-[10px] text-accent">changed</span>}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`limit-${key}`}
                  type="number"
                  min={bounds.min}
                  max={bounds.max}
                  step={1}
                  value={values[key] ?? ''}
                  onChange={e => setValues(current => ({ ...current, [key]: e.target.value }))}
                  className={`${input} w-28 ${problems[key] ? 'ring-1 ring-red-500/60' : ''}`}
                />
                <span className="text-xs text-neutral-500">{unit}</span>
                <span className="text-[11px] text-neutral-600 ml-auto">default {settings.defaults[key]}</span>
              </div>
              {problems[key] && <p className="text-[11px] text-red-400 mt-1">{problems[key]}</p>}
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3 mt-5">
        <button
          onClick={save}
          disabled={busy || hasProblem || changed.length === 0}
          className="text-sm font-semibold rounded-xl px-5 py-2 bg-accent hover:bg-emerald-400 text-black disabled:opacity-40 disabled:hover:bg-accent transition-all"
        >
          Save
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
        {note && !error && <span className="text-xs text-neutral-400">{note}</span>}
      </div>
    </div>
  )
}

export default function AutoReply() {
  const [settings, setSettings] = useState(null)
  const [ruleSets, setRuleSets] = useState([])
  const [decisions, setDecisions] = useState([])
  const [contacts, setContacts] = useState([])
  const [error, setError] = useState(null)

  // The editor works on a draft: either an existing rule set or a new one.
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [problems, setProblems] = useState([])
  const [validNote, setValidNote] = useState(null)
  const [saving, setSaving] = useState(false)

  const [testChat, setTestChat] = useState('')
  const [testText, setTestText] = useState('')
  const [testType, setTestType] = useState('text')
  const [testResult, setTestResult] = useState(null)

  const loadSets = useCallback(() => api('/autoreply/rulesets').then(setRuleSets).catch(err => setError(err.message)), [])
  const loadLog = useCallback(() => {
    api('/autoreply/decisions?limit=100').then(setDecisions).catch(() => {})
    api('/autoreply/contacts').then(setContacts).catch(() => {})
  }, [])

  useEffect(() => {
    api('/autoreply/settings').then(setSettings).catch(err => setError(err.message))
    loadSets()
    loadLog()
    const timer = setInterval(loadLog, 15000)
    return () => clearInterval(timer)
  }, [loadSets, loadLog])

  const run = async (work) => {
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err.message)
    }
  }

  const toggleEnabled = () => run(async () => {
    const turningOn = !settings?.enabled
    if (turningOn && !window.confirm('Turn auto-reply on? A rule set in Live mode will start sending real messages from your number.')) return
    setSettings(await api('/autoreply/settings', { method: 'PUT', body: { enabled: turningOn } }))
  })

  const setState = (set, changes) => run(async () => {
    const goesLive = changes.mode === 'live' || (changes.active === true && set.mode === 'live')
    if (goesLive && !window.confirm(`Put "${set.name}" live? When it is active and auto-reply is on, it sends real messages.`)) return
    await api(`/autoreply/rulesets/${set.id}`, { method: 'PATCH', body: changes })
    await loadSets()
  })

  const remove = (set) => run(async () => {
    if (!window.confirm(`Delete "${set.name}"? Its decision log stays.`)) return
    await api(`/autoreply/rulesets/${set.id}`, { method: 'DELETE' })
    if (editingId === set.id) closeEditor()
    await loadSets()
  })

  const download = (set) => run(async () => {
    const full = await api(`/autoreply/rulesets/${set.id}`)
    const slug = full.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule-set'
    saveFile(`${slug}.json`, full.template)
  })

  const openEditor = (set) => run(async () => {
    const full = await api(`/autoreply/rulesets/${set.id}`)
    setEditingId(set.id)
    setDraft(full.template)
    setProblems([])
    setValidNote(null)
    setTestResult(null)
  })

  const openNew = (text = STARTER) => {
    setEditingId(null)
    setDraft(text)
    setProblems([])
    setValidNote(null)
    setTestResult(null)
  }

  const closeEditor = () => {
    setEditingId(null)
    setDraft(null)
    setProblems([])
    setValidNote(null)
    setTestResult(null)
  }

  const upload = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      openNew(String(reader.result))
      validate(String(reader.result))
    }
    reader.readAsText(file)
  }

  const validate = (text = draft) => run(async () => {
    const result = await api('/autoreply/validate', { method: 'POST', body: { template: text } })
    setProblems(result.errors)
    setValidNote(result.valid
      ? `Valid: ${result.summary.rules} rule${result.summary.rules === 1 ? '' : 's'}${result.summary.fallback ? ' plus a fallback' : ''}`
      : null)
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = editingId
        ? await api(`/autoreply/rulesets/${editingId}`, { method: 'PUT', body: { template: draft } })
        : await api('/autoreply/rulesets', { method: 'POST', body: { template: draft } })
      setEditingId(saved.id)
      setProblems([])
      setValidNote(editingId ? 'Saved. A live rule set goes back to dry run after an edit.' : 'Saved in dry run, not active yet.')
      await loadSets()
    } catch (err) {
      setError(err.message)
      validate()
    }
    setSaving(false)
  }

  const runTest = () => run(async () => {
    setTestResult(await api('/autoreply/test', {
      method: 'POST',
      body: { template: draft, chat: testChat, text: testText, type: testType },
    }))
  })

  const mute = (contact) => run(async () => {
    await api(`/autoreply/contacts/${encodeURIComponent(contact.chat_jid)}/mute`, { method: 'POST', body: { minutes: 24 * 60 } })
    loadLog()
  })

  const unmute = (contact) => run(async () => {
    await api(`/autoreply/contacts/${encodeURIComponent(contact.contact_key)}/mute`, { method: 'DELETE' })
    loadLog()
  })

  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-neutral-800 bg-neutral-900/30">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link to="/" className="text-neutral-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-base font-semibold text-neutral-200">Auto-reply</h1>
          <Link to="/whitelist" className="ml-auto text-xs text-neutral-500 hover:text-accent transition-colors">Allow list</Link>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {error && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>
        )}

        {/* Kill switch */}
        <div className={`${card} flex items-center justify-between gap-4`}>
          <div>
            <p className="text-sm text-neutral-200 font-medium">
              Auto-reply is {settings?.enabled ? <span className="text-accent">on</span> : <span className="text-neutral-400">off</span>}
            </p>
            <p className="text-[11px] text-neutral-500 mt-1 leading-relaxed">
              Only the active rule set runs. Dry run logs what it would send; Live sends from your number.
            </p>
          </div>
          <button
            onClick={toggleEnabled}
            disabled={!settings}
            className={`text-sm font-semibold rounded-xl px-5 py-2 transition-all flex-shrink-0 ${settings?.enabled
              ? 'bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30'
              : 'bg-accent hover:bg-emerald-400 text-black'}`}
          >
            {settings?.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>

        <ServerLimits settings={settings} onChange={setSettings} />

        {/* Rule sets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className={label + ' mb-0'}>Rule sets ({ruleSets.length})</h2>
            <div className="flex gap-2">
              <label className={`${smallButton} cursor-pointer`}>
                Upload JSON
                <input type="file" accept="application/json,.json" onChange={upload} className="hidden" />
              </label>
              <button onClick={() => openNew()} className={smallButton}>New</button>
            </div>
          </div>
          {ruleSets.length === 0 ? (
            <div className="text-center py-8 border border-neutral-800 border-dashed rounded-xl">
              <p className="text-neutral-500 text-sm">No rule sets yet</p>
              <p className="text-neutral-600 text-xs mt-1">Upload a template or start a new one</p>
            </div>
          ) : (
            <div className="space-y-2">
              {ruleSets.map(set => (
                <div key={set.id} className={`border rounded-xl p-4 flex flex-wrap items-center gap-4 ${set.active ? 'border-accent/40 bg-accent/5' : 'border-neutral-800 bg-neutral-900/50'}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-neutral-200 truncate">
                      {set.name} <span className="text-[11px] text-neutral-600 font-mono">v{set.version}</span>
                      {set.active && <span className="ml-2 text-[11px] text-accent">active</span>}
                    </p>
                    {set.description && <p className="text-[11px] text-neutral-500 truncate">{set.description}</p>}
                  </div>
                  <div className="flex rounded-lg overflow-hidden border border-neutral-700">
                    {MODES.map(mode => (
                      <button
                        key={mode.id}
                        onClick={() => set.mode !== mode.id && setState(set, { mode: mode.id })}
                        className={`text-xs px-3 py-1.5 transition-colors ${set.mode === mode.id
                          ? mode.id === 'live' ? 'bg-red-500/30 text-red-200' : mode.id === 'dry_run' ? 'bg-sky-500/20 text-sky-300' : 'bg-neutral-700 text-neutral-200'
                          : 'text-neutral-500 hover:text-white'}`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setState(set, { active: !set.active })} className={smallButton}>
                    {set.active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => openEditor(set)} className={smallButton}>Edit</button>
                  <button onClick={() => download(set)} className={smallButton}>Download</button>
                  <button onClick={() => remove(set)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1">Delete</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Editor and test box */}
        {draft !== null && (
          <div className={card}>
            <div className="flex items-center justify-between mb-2">
              <span className={label + ' mb-0'}>{editingId ? 'Edit rule set' : 'New rule set'}</span>
              <button onClick={closeEditor} className={smallButton}>Close</button>
            </div>
            <textarea
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setValidNote(null) }}
              spellCheck={false}
              rows={22}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 font-mono text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-accent/50"
            />
            {problems.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">
                {problems.map((p, i) => (
                  <li key={i}><span className="font-mono text-red-300">{p.path || '(template)'}</span>: {p.message}</li>
                ))}
              </ul>
            )}
            {validNote && <p className="mt-2 text-xs text-accent">{validNote}</p>}
            <div className="mt-3 flex gap-2">
              <button onClick={() => validate()} className="text-xs border border-neutral-700 text-neutral-300 hover:text-white rounded-lg px-4 py-2">Validate</button>
              <button
                onClick={save}
                disabled={saving}
                className="text-xs bg-accent hover:bg-emerald-400 disabled:opacity-30 text-black font-semibold rounded-lg px-4 py-2"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>

            <div className="mt-5 pt-4 border-t border-neutral-800">
              <span className={label}>Test a message (nothing is sent)</span>
              <div className="flex flex-wrap gap-2">
                <input value={testChat} onChange={(e) => setTestChat(e.target.value)} placeholder="Chat: +15555550100 or JID" className={`${input} w-56`} />
                <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="Message text" className={`${input} flex-1 min-w-48`} />
                <select value={testType} onChange={(e) => setTestType(e.target.value)} className={input}>
                  {['text', 'image', 'video', 'doc', 'audio', 'voice', 'sticker', 'location', 'contact', 'album'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <button
                  onClick={runTest}
                  disabled={!testChat.trim()}
                  className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-30 text-white rounded-lg px-4"
                >
                  Test
                </button>
              </div>
              {testResult && (
                <div className="mt-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg p-3 space-y-1">
                  <p className="text-neutral-400">
                    Chat <span className="font-mono">{testResult.chat}</span>{' '}
                    {testResult.in_scope ? <span className="text-accent">is in scope</span> : <span className="text-red-400">is out of scope ({testResult.scope_reason})</span>}
                  </p>
                  <p className="text-neutral-400">
                    Matching rule: {testResult.match ? <span className="text-neutral-200 font-mono">{testResult.match.rule_id}</span> : 'none'}
                  </p>
                  {testResult.match && <p className="text-neutral-200 whitespace-pre-wrap">“{testResult.match.reply}”</p>}
                  <p className="text-neutral-400">
                    Right now it would {testResult.decision.action === 'would_send'
                      ? <span className="text-accent">reply</span>
                      : <span className="text-neutral-300">skip ({testResult.decision.reason})</span>}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contacts */}
        <div>
          <h2 className={label}>Contacts ({contacts.length})</h2>
          {contacts.length === 0 ? (
            <p className="text-xs text-neutral-600">No contacts have reached the auto-replier yet.</p>
          ) : (
            <div className="border border-neutral-800 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-neutral-500 text-left">
                  <tr className="border-b border-neutral-800">
                    <th className="px-3 py-2 font-medium">Contact</th>
                    <th className="px-3 py-2 font-medium">Replies 24h</th>
                    <th className="px-3 py-2 font-medium">This conversation</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map(c => (
                    <tr key={c.contact_key} className="border-b border-neutral-900 last:border-0">
                      <td className="px-3 py-2">
                        <p className="text-neutral-200">{c.name || prettyJid(c.sender_jid || c.chat_jid)}</p>
                        <p className="text-[10px] text-neutral-600 font-mono">{c.sender_jid ? `${c.sender_jid} in ${c.chat_jid}` : c.chat_jid}</p>
                      </td>
                      <td className="px-3 py-2 text-neutral-300">{c.sent_24h} sent{c.dry_run_24h ? `, ${c.dry_run_24h} dry run` : ''}</td>
                      <td className="px-3 py-2 text-neutral-300">{c.conversation_replies}</td>
                      <td className="px-3 py-2">
                        {c.muted
                          ? <span className="text-yellow-400">muted until {formatTime(c.muted_until)} ({c.mute_reason})</span>
                          : <span className="text-neutral-500">active</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {c.muted
                          ? <button onClick={() => unmute(c)} className={smallButton}>Unmute</button>
                          : !c.sender_jid && <button onClick={() => mute(c)} className={smallButton}>Mute 24h</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Decision log */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className={label + ' mb-0'}>Recent decisions</h2>
            <button onClick={loadLog} className={smallButton}>Refresh</button>
          </div>
          {decisions.length === 0 ? (
            <p className="text-xs text-neutral-600">Nothing yet. Decisions show up here once an active rule set sees a message in its scope.</p>
          ) : (
            <div className="border border-neutral-800 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-neutral-500 text-left">
                  <tr className="border-b border-neutral-800">
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Chat</th>
                    <th className="px-3 py-2 font-medium">Rule</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Reply</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map(d => (
                    <tr key={d.id} className="border-b border-neutral-900 last:border-0 align-top">
                      <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(d.at)}</td>
                      <td className="px-3 py-2 text-neutral-300 font-mono text-[10px]">{d.chat_jid}</td>
                      <td className="px-3 py-2 text-neutral-400">
                        <span className="font-mono">{d.rule_id || '-'}</span>
                        <p className="text-[10px] text-neutral-600">{d.ruleset_name}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className={ACTION_TONE[d.action] || 'text-neutral-400'}>{d.action}</span>
                        {d.reason && <p className="text-[10px] text-neutral-500">{d.reason}</p>}
                      </td>
                      <td className="px-3 py-2 text-neutral-300 whitespace-pre-wrap max-w-xs">{d.reply_text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
