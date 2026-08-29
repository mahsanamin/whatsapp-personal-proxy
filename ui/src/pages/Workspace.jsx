import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api/client'
import { useWebSocket } from '../ws/useWebSocket'

function formatJid(jid) {
  if (jid.endsWith('@s.whatsapp.net')) return '+' + jid.replace('@s.whatsapp.net', '')
  if (jid.endsWith('@g.us')) return 'Group ' + jid.split('@')[0].slice(-6)
  if (jid.endsWith('@lid')) return 'Contact ' + jid.split('@')[0].slice(-6)
  return jid.split('@')[0]
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function Avatar({ name, jid, size = 'md' }) {
  const label = name || formatJid(jid)
  const initial = label.replace(/^\+/, '').charAt(0).toUpperCase()
  const colors = ['bg-emerald-700', 'bg-blue-700', 'bg-purple-700', 'bg-orange-700', 'bg-pink-700', 'bg-teal-700', 'bg-rose-700', 'bg-cyan-700']
  const idx = (jid || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length
  const sizeClass = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm'
  const isGroup = jid?.endsWith('@g.us')

  return (
    <div className={`${sizeClass} ${colors[idx]} rounded-full flex items-center justify-center font-semibold text-white flex-shrink-0`}>
      {isGroup ? (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v1h8v-1zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-1a5.97 5.97 0 00-.75-2.906A3.005 3.005 0 0119 17v1h-3zM4.75 14.094A5.97 5.97 0 004 17v1H1v-1a3 3 0 013.75-2.906z" /></svg>
      ) : initial}
    </div>
  )
}

function ChannelRow({ channel, active, onClick, onDragStart }) {
  const name = channel.display_name || formatJid(channel.jid)
  const preview = channel.last_message?.body
  const mediaPreview = { image: 'Photo', video: 'Video', doc: 'Document', audio: 'Audio', sticker: 'Sticker' }
  const msgPreview = preview || (channel.last_message?.type ? mediaPreview[channel.last_message.type] || '' : '')

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-all duration-150 border-l-2
        ${active
          ? 'bg-neutral-800/80 border-l-accent'
          : 'border-l-transparent hover:bg-neutral-800/40'
        }`}
    >
      <Avatar name={channel.display_name} jid={channel.jid} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium truncate text-neutral-200">{name}</span>
          <span className="text-[10px] text-neutral-500 flex-shrink-0">{timeAgo(channel.last_message?.timestamp)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-neutral-500 truncate">{msgPreview}</p>
          {channel.unread_count > 0 && (
            <span className="bg-accent text-black text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center flex-shrink-0">
              {channel.unread_count > 99 ? '99+' : channel.unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg, prevMsg, isGroupChat }) {
  const isMe = msg.is_from_me
  const isMedia = msg.type !== 'text' && msg.type !== 'reaction' && msg.type !== 'unknown'
  const mediaLabels = { image: 'Photo', video: 'Video', doc: 'Document', audio: 'Audio', sticker: 'Sticker' }
  // Only groups need a sender label; in a one-to-one chat there is exactly one
  // other person and naming them above every bubble is noise.
  // Coerced: is_from_me is SQLite's 0/1, and `a && b && 0` evaluates to 0,
  // which React happily renders as a literal "0" above the bubble.
  const showSender = Boolean(
    isGroupChat && !isMe && msg.from_jid &&
    (!prevMsg || prevMsg.from_jid !== msg.from_jid || prevMsg.is_from_me)
  )
  // Fall back to the number only when WhatsApp has given us no name for them.
  const senderLabel = msg.from_name || msg.from_jid?.split('@')[0]

  return (
    <div className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-1 group`}>
      {showSender && (
        <span className="text-[11px] text-accent/70 font-medium ml-1 mb-0.5">{senderLabel}</span>
      )}
      <div className="relative">
        <div className={`max-w-[480px] px-3 py-1.5 text-[13px] leading-relaxed rounded-2xl
          ${isMe
            ? 'bg-accent/20 text-neutral-100 rounded-br-sm'
            : 'bg-neutral-800 text-neutral-200 rounded-bl-sm'
          }`}>
          {isMedia && !msg.body && (
            <div className="flex items-center gap-2 py-1">
              <span className="text-neutral-400">
                {msg.type === 'image' ? '🖼' : msg.type === 'video' ? '🎬' : msg.type === 'audio' ? '🎵' : msg.type === 'doc' ? '📄' : '📎'}
              </span>
              <span className="text-neutral-400 text-xs">{mediaLabels[msg.type] || msg.type}</span>
              {msg.media_size > 0 && <span className="text-neutral-600 text-xs">{(msg.media_size / 1024).toFixed(0)}KB</span>}
              <a
                href={`/api/channels/${encodeURIComponent(msg.jid)}/messages/${msg.id}/media`}
                target="_blank"
                rel="noreferrer"
                className="text-accent text-xs hover:underline ml-1"
              >
                View
              </a>
            </div>
          )}
          {msg.body && <p className="whitespace-pre-wrap break-words">{msg.body}</p>}
          <span className={`text-[10px] float-right ml-3 mt-1 ${isMe ? 'text-accent/40' : 'text-neutral-600'}`}>
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {msg.reactions?.length > 0 && (
          <div className={`absolute -bottom-2.5 ${isMe ? 'right-2' : 'left-2'} flex gap-0.5`}>
            <div className="flex bg-neutral-700 rounded-full px-1.5 py-0.5 shadow-lg border border-neutral-600">
              {[...new Set(msg.reactions.map(r => r.emoji))].map((emoji, i) => {
                const count = msg.reactions.filter(r => r.emoji === emoji).length
                return (
                  <span key={i} className="text-xs leading-none" title={msg.reactions.filter(r => r.emoji === emoji).map(r => r.from?.split('@')[0]).join(', ')}>
                    {emoji}{count > 1 && <span className="text-[10px] text-neutral-400">{count}</span>}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </div>
      {msg.reactions?.length > 0 && <div className="h-2" />}
    </div>
  )
}

function DateSeparator({ date }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-neutral-800" />
      <span className="text-[11px] text-neutral-600 font-medium">{date}</span>
      <div className="flex-1 h-px bg-neutral-800" />
    </div>
  )
}

function TabBar({ tabs, activeTab, onSelect, onCreate, onRename, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [editName, setEditName] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus() }, [editing])

  const startRename = (tab) => {
    setEditing(tab.id)
    setEditName(tab.name)
  }

  const submitRename = () => {
    if (editName.trim() && editing) {
      onRename(editing, editName.trim())
    }
    setEditing(null)
  }

  const submitNew = () => {
    if (newName.trim()) {
      onCreate(newName.trim())
      setNewName('')
      setShowNew(false)
    }
  }

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-neutral-800 bg-neutral-900/50 overflow-x-auto"
      onDragOver={(e) => e.preventDefault()}
    >
      <button
        onClick={() => onSelect(null)}
        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap
          ${!activeTab ? 'bg-accent/20 text-accent' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
      >
        All Chats
      </button>
      {tabs.map(tab => (
        <div
          key={tab.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const jid = e.dataTransfer.getData('text/plain')
            if (jid) {
              api(`/channels/${encodeURIComponent(jid)}`, { method: 'PATCH', body: { tab_id: tab.id } })
            }
          }}
        >
          {editing === tab.id ? (
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setEditing(null) }}
              className="px-3 py-1.5 text-xs bg-neutral-800 border border-accent rounded-lg outline-none w-24 text-white"
            />
          ) : (
            <button
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => startRename(tab)}
              className={`group/tab px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap flex items-center gap-1.5
                ${activeTab === tab.id ? 'bg-accent/20 text-accent' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tab.color }} />
              {tab.name}
              {tab.channel_count > 0 && <span className="text-neutral-600">{tab.channel_count}</span>}
              <span
                onClick={(e) => { e.stopPropagation(); onDelete(tab.id) }}
                className="opacity-0 group-hover/tab:opacity-100 text-neutral-600 hover:text-red-400 ml-0.5 cursor-pointer"
              >
                x
              </span>
            </button>
          )}
        </div>
      ))}
      {showNew ? (
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={() => { submitNew(); setShowNew(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); if (e.key === 'Escape') { setShowNew(false); setNewName('') } }}
          placeholder="Tab name..."
          className="px-3 py-1.5 text-xs bg-neutral-800 border border-neutral-700 rounded-lg outline-none w-24 text-white placeholder-neutral-600"
        />
      ) : (
        <button
          onClick={() => setShowNew(true)}
          className="px-2 py-1.5 text-neutral-600 hover:text-accent text-sm transition-colors"
          title="New tab"
        >
          +
        </button>
      )}
    </div>
  )
}

function SearchBar({ value, onChange }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 bg-neutral-800/60 rounded-lg px-3 py-2">
        <svg className="w-3.5 h-3.5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={onChange}
          placeholder="Search chats..."
          className="bg-transparent text-xs text-white placeholder-neutral-500 outline-none w-full"
        />
        {value && (
          <button onClick={() => onChange({ target: { value: '' } })} className="text-neutral-500 hover:text-white text-xs">
            x
          </button>
        )}
      </div>
    </div>
  )
}

function ChannelHeader({ channel, onRename }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const displayName = channel.display_name || formatJid(channel.jid)
  const hasCustomName = !!channel.display_name

  const startEdit = () => {
    setName(channel.display_name || '')
    setEditing(true)
  }

  const save = () => {
    if (name.trim()) onRename(name.trim())
    setEditing(false)
  }

  return (
    <div className="px-5 py-3 border-b border-neutral-800 flex items-center gap-3 bg-neutral-900/20">
      <Avatar name={channel.display_name} jid={channel.jid} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            placeholder="Enter contact name..."
            className="bg-neutral-800 rounded-lg px-3 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-accent/50 w-full max-w-xs"
          />
        ) : (
          <div className="flex items-center gap-2 group/name">
            <span className={`text-sm font-medium truncate ${hasCustomName ? 'text-neutral-200' : 'text-neutral-400'}`}>
              {displayName}
            </span>
            <button
              onClick={startEdit}
              className="opacity-0 group-hover/name:opacity-100 text-neutral-600 hover:text-accent transition-all"
              title="Rename contact"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>
        )}
        <div className="text-[11px] text-neutral-500 font-mono truncate">{channel.jid}</div>
      </div>
    </div>
  )
}

export default function Workspace({ onLogout }) {
  const navigate = useNavigate()
  const [channels, setChannels] = useState([])
  const [tabs, setTabs] = useState([])
  const [activeTab, setActiveTab] = useState(null)
  const [activeJid, setActiveJid] = useState(null)
  const [messages, setMessages] = useState([])
  const [msgInput, setMsgInput] = useState('')
  const [waStatus, setWaStatus] = useState('close')
  const [waLinked, setWaLinked] = useState(true)
  const [syncingContacts, setSyncingContacts] = useState(false)
  const [syncNote, setSyncNote] = useState(null)
  const [search, setSearch] = useState('')
  const [sendError, setSendError] = useState(null)
  const [syncStats, setSyncStats] = useState({ channels: 0, messages: 0 })
  const [initialLoad, setInitialLoad] = useState(true)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // One conversation can be addressed two ways, so an arriving message may
  // carry the @lid address while the open chat is keyed by its phone number.
  const openChannel = channels.find(c => c.jid === activeJid)
  const activeJids = useMemo(
    () => new Set([activeJid, ...(openChannel?.alt_jids || [])].filter(Boolean)),
    [activeJid, openChannel],
  )

  const { connected } = useWebSocket({
    onMessage: (data) => {
      if (activeJids.has(data.jid) || (data.canonical_jid && data.canonical_jid === activeJid)) {
        // The chat is also refetched on open, so guard against a double insert.
        setMessages(prev => prev.some(m => m.id === data.id) ? prev : [...prev, data])
      }
      loadChannels()
    },
    onStatus: (data) => setWaStatus(data.status),
  })

  const loadChannels = useCallback(() => {
    const params = new URLSearchParams()
    if (activeTab) params.set('tab', activeTab)
    if (search) params.set('search', search)
    const qs = params.toString()
    api('/channels' + (qs ? `?${qs}` : ''))
      .then(data => {
        setChannels(data)
        const totalMsgs = data.reduce((sum, c) => sum + (c.last_message ? 1 : 0), 0)
        setSyncStats({ channels: data.length, messages: totalMsgs })
        if (data.length > 0) setInitialLoad(false)
      })
      .catch(() => {})
  }, [activeTab, search])

  const loadTabs = () => api('/tabs').then(setTabs).catch(() => {})

  useEffect(() => {
    api('/auth/wa/status').then(data => {
      setWaStatus(data.status)
      setWaLinked(Boolean(data.linked))
      // No account paired yet — there is nothing to sync, so send the user to
      // scan a QR. An unlinked server sits in `connecting` while it emits QR
      // codes, so checking the status alone would strand them on a sync screen
      // that never finishes.
      if (!data.linked) navigate('/connect')
    }).catch(() => navigate('/login'))
    loadTabs()
    // After 30s, stop showing loading even if no channels arrived
    const timeout = setTimeout(() => setInitialLoad(false), 30000)
    return () => clearTimeout(timeout)
  }, [])

  useEffect(() => {
    loadChannels()
    const interval = setInterval(loadChannels, 5000)
    return () => clearInterval(interval)
  }, [loadChannels])

  useEffect(() => {
    if (!activeJid) return
    api(`/channels/${encodeURIComponent(activeJid)}/messages?limit=50`)
      .then(msgs => setMessages(msgs.reverse()))
      .catch(() => setMessages([]))
  }, [activeJid])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (activeJid && inputRef.current) inputRef.current.focus()
  }, [activeJid])

  const handleSend = async (e) => {
    e.preventDefault()
    if (!msgInput.trim() || !activeJid) return
    setSendError(null)
    const text = msgInput
    setMsgInput('')

    // Show it straight away under a placeholder id. WhatsApp echoes the message
    // back over the WebSocket carrying its real id, so adopt that id as soon as
    // the send returns — otherwise the echo reads as a different message and
    // the same bubble is drawn twice.
    const tempId = `pending-${Date.now()}`
    setMessages(prev => [...prev, {
      id: tempId,
      jid: activeJid,
      from_jid: 'me',
      body: text,
      type: 'text',
      timestamp: new Date().toISOString(),
      is_from_me: 1,
      reactions: [],
      pending: true,
    }])

    try {
      const res = await api('/send', { method: 'POST', body: { jid: activeJid, message: text } })
      setMessages(prev => {
        // The echo can beat the HTTP response; if it already arrived, the
        // placeholder is simply redundant.
        if (res.messageId && prev.some(m => m.id === res.messageId)) {
          return prev.filter(m => m.id !== tempId)
        }
        return prev.map(m => (
          m.id === tempId ? { ...m, id: res.messageId || m.id, pending: false } : m
        ))
      })
    } catch (err) {
      // Nothing was sent, so stop showing it as though it had been.
      setMessages(prev => prev.filter(m => m.id !== tempId))
      setSendError(err.message)
      setTimeout(() => setSendError(null), 5000)
    }
  }

  const handleCreateTab = async (name) => {
    await api('/tabs', { method: 'POST', body: { name } })
    loadTabs()
  }

  const handleRenameTab = async (id, name) => {
    await api(`/tabs/${id}`, { method: 'PATCH', body: { name } })
    loadTabs()
  }

  const handleDeleteTab = async (id) => {
    await api(`/tabs/${id}`, { method: 'DELETE' })
    if (activeTab === id) setActiveTab(null)
    loadTabs()
    loadChannels()
  }

  const handleDrop = async (e, tabId) => {
    e.preventDefault()
    const jid = e.dataTransfer.getData('text/plain')
    if (!jid) return
    await api(`/channels/${encodeURIComponent(jid)}`, { method: 'PATCH', body: { tab_id: tabId } }).catch(() => {})
    loadChannels()
    loadTabs()
  }

  const activeChannel = channels.find(c => c.jid === activeJid)

  // Group messages by date
  const groupedMessages = messages.reduce((acc, msg) => {
    const date = new Date(msg.timestamp).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    if (!acc.length || acc[acc.length - 1].date !== date) {
      acc.push({ date, messages: [] })
    }
    acc[acc.length - 1].messages.push(msg)
    return acc
  }, [])

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-800 bg-neutral-900/30">
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold text-accent text-base tracking-tight">wpp</span>
          {waStatus !== 'open' && (
            <div className="flex items-center gap-1.5 bg-yellow-950/60 border border-yellow-900/40 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
              <span className="text-yellow-400 text-[11px]">
                {!waLinked ? 'Not linked' : waStatus === 'connecting' ? 'Syncing...' : 'Disconnected'}
              </span>
            </div>
          )}
          {waStatus === 'open' && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              <span className="text-neutral-500 text-[11px]">Connected</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              setSyncingContacts(true)
              try {
                const r = await api('/admin/resolve-contacts', { method: 'POST' })
                setSyncNote(r.gained > 0 ? `+${r.gained} names` : 'no new names')
              } catch (err) {
                setSyncNote(err.message)
              }
              setSyncingContacts(false)
              loadChannels()
              setTimeout(() => setSyncNote(null), 6000)
            }}
            disabled={syncingContacts || waStatus !== 'open'}
            title="Ask WhatsApp to resend your contact names"
            className="text-xs text-neutral-500 hover:text-accent disabled:opacity-40 transition-colors px-2 py-1 rounded hover:bg-neutral-800"
          >
            {syncingContacts ? 'Syncing contacts…' : syncNote || 'Sync contacts'}
          </button>
          {waStatus !== 'open' && (
            <Link to="/connect" className="text-xs text-yellow-400 hover:text-yellow-300 transition-colors px-2 py-1 rounded hover:bg-neutral-800">
              Link Device
            </Link>
          )}
          <Link to="/tokens" className="text-xs text-neutral-500 hover:text-accent transition-colors px-2 py-1 rounded hover:bg-neutral-800">
            API Keys
          </Link>
          <button
            onClick={onLogout}
            className="text-xs text-neutral-500 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-neutral-800"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <TabBar
        tabs={tabs}
        activeTab={activeTab}
        onSelect={setActiveTab}
        onCreate={handleCreateTab}
        onRename={handleRenameTab}
        onDelete={handleDeleteTab}
      />

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Channel sidebar */}
        <div className="w-72 border-r border-neutral-800 flex flex-col flex-shrink-0 bg-neutral-900/20"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => handleDrop(e, activeTab)}
        >
          <SearchBar value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex-1 overflow-y-auto">
            {channels.length === 0 && (
              <div className="px-4 py-8 text-center">
                {initialLoad ? (
                  <>
                    <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-neutral-500 text-xs">Syncing chats...</p>
                    {syncStats.channels > 0 && (
                      <p className="text-neutral-600 text-[11px] mt-1">{syncStats.channels} found</p>
                    )}
                  </>
                ) : (
                  <p className="text-neutral-600 text-xs">
                    {search ? 'No matches' : 'No chats yet'}
                  </p>
                )}
              </div>
            )}
            {channels.map(ch => (
              <ChannelRow
                key={ch.jid}
                channel={ch}
                active={ch.jid === activeJid}
                onClick={() => setActiveJid(ch.jid)}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', ch.jid)}
              />
            ))}
          </div>
        </div>

        {/* Message area */}
        <div className="flex-1 flex flex-col bg-bg">
          {activeJid && activeChannel ? (
            <>
              {/* Channel header */}
              <ChannelHeader channel={activeChannel} onRename={(name) => {
                api(`/channels/${encodeURIComponent(activeChannel.jid)}`, { method: 'PATCH', body: { display_name: name } })
                  .then(() => loadChannels())
                  .catch(() => {})
              }} />

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-3">
                {groupedMessages.map((group) => (
                  <div key={group.date}>
                    <DateSeparator date={group.date} />
                    {group.messages.map((msg, i) => (
                      <MessageBubble
                        key={msg.id}
                        msg={msg}
                        prevMsg={group.messages[i - 1]}
                        isGroupChat={Boolean(activeJid?.endsWith('@g.us'))}
                      />
                    ))}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input area */}
              <div className="border-t border-neutral-800 bg-neutral-900/20">
                {sendError && (
                  <div className="px-5 py-1.5 text-xs text-red-400 bg-red-950/30">{sendError}</div>
                )}
                <form onSubmit={handleSend} className="px-5 py-3 flex items-center gap-3">
                  <input
                    ref={inputRef}
                    type="text"
                    value={msgInput}
                    onChange={(e) => setMsgInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend(e) }}
                    placeholder="Type a message..."
                    className="flex-1 bg-neutral-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-neutral-500 outline-none focus:ring-1 focus:ring-accent/50 transition-all"
                  />
                  <button
                    type="submit"
                    disabled={!msgInput.trim()}
                    className="bg-accent hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-accent text-black rounded-xl px-5 py-2.5 text-sm font-semibold transition-all"
                  >
                    Send
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              {initialLoad && waStatus !== 'open' && waLinked ? (
                <>
                  {/* Sync progress screen */}
                  <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center">
                    <svg className="w-8 h-8 text-accent animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-neutral-300 text-sm font-medium mb-1">Syncing your WhatsApp</p>
                    <p className="text-neutral-500 text-xs">This takes 1-2 minutes on first connect</p>
                  </div>
                  <div className="flex gap-6 mt-2">
                    <div className="text-center">
                      <p className="text-accent text-lg font-semibold font-mono">{syncStats.channels}</p>
                      <p className="text-neutral-600 text-[11px]">Chats</p>
                    </div>
                    <div className="text-center">
                      <p className="text-accent text-lg font-semibold font-mono">{syncStats.messages}</p>
                      <p className="text-neutral-600 text-[11px]">With messages</p>
                    </div>
                  </div>
                  <div className="w-48 h-1 bg-neutral-800 rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-accent/50 rounded-full animate-pulse" style={{ width: '60%' }} />
                  </div>
                </>
              ) : initialLoad ? (
                <>
                  {/* Connected but still loading */}
                  <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center">
                    <svg className="w-8 h-8 text-accent animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                  <p className="text-neutral-400 text-sm">Loading chats...</p>
                  {syncStats.channels > 0 && (
                    <p className="text-neutral-600 text-xs">{syncStats.channels} chats found</p>
                  )}
                </>
              ) : (
                <>
                  {/* Ready — select a chat */}
                  <div className="w-16 h-16 rounded-2xl bg-neutral-800/50 flex items-center justify-center">
                    <svg className="w-8 h-8 text-neutral-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  <p className="text-neutral-500 text-sm">Select a conversation</p>
                  <p className="text-neutral-600 text-xs">{channels.length} chats available</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
