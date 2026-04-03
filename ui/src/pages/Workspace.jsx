import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api/client'
import { useWebSocket } from '../ws/useWebSocket'

function ChannelRow({ channel, active, onClick }) {
  const [flash, setFlash] = useState(false)

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-border hover:bg-neutral-900 transition-colors ${
        active ? 'bg-neutral-900 border-l-2 border-l-accent' : ''
      } ${flash ? 'bg-emerald-950' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm truncate">{channel.display_name || channel.jid}</span>
        <span className="text-xs text-neutral-600">
          {channel.last_message?.timestamp
            ? new Date(channel.last_message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''}
        </span>
      </div>
      {channel.last_message?.body && (
        <p className="text-xs text-neutral-500 truncate mt-0.5">{channel.last_message.body}</p>
      )}
      {channel.unread_count > 0 && (
        <span className="inline-block mt-1 bg-accent text-black text-xs font-mono px-1.5 rounded-sm">
          {channel.unread_count}
        </span>
      )}
    </button>
  )
}

function MessageBubble({ msg }) {
  const isMe = msg.is_from_me
  const isMedia = msg.type !== 'text' && msg.type !== 'reaction' && msg.type !== 'unknown'
  const typeIcon = { image: 'Photo', video: 'Video', doc: 'Document', audio: 'Audio', sticker: 'Sticker' }

  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'} mb-2`}>
      <div className={`max-w-[70%] px-3 py-2 text-sm ${
        isMe ? 'bg-emerald-950 border border-emerald-900' : 'bg-neutral-900 border border-border'
      }`}>
        {!isMe && msg.from_jid && (
          <div className="text-xs text-accent font-mono mb-1">{msg.from_jid.split('@')[0]}</div>
        )}
        {isMedia && !msg.body && (
          <div className="flex items-center gap-2 text-neutral-400">
            <span className="text-xs font-mono">[{typeIcon[msg.type] || msg.type}]</span>
            {msg.media_size && <span className="text-xs">{(msg.media_size / 1024).toFixed(0)}KB</span>}
            <a
              href={`/api/channels/${encodeURIComponent(msg.jid)}/messages/${msg.id}/media`}
              target="_blank"
              rel="noreferrer"
              className="text-accent text-xs hover:underline"
            >
              Download
            </a>
          </div>
        )}
        {msg.body && <p className="whitespace-pre-wrap break-words">{msg.body}</p>}
        <div className="text-xs text-neutral-600 mt-1 text-right">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

export default function Workspace() {
  const navigate = useNavigate()
  const [channels, setChannels] = useState([])
  const [tabs, setTabs] = useState([])
  const [activeTab, setActiveTab] = useState(null)
  const [activeJid, setActiveJid] = useState(null)
  const [messages, setMessages] = useState([])
  const [msgInput, setMsgInput] = useState('')
  const [waStatus, setWaStatus] = useState('close')
  const [collapsedTabs, setCollapsedTabs] = useState({})
  const messagesEndRef = useRef(null)

  const { connected } = useWebSocket({
    onMessage: (data) => {
      if (data.jid === activeJid) {
        setMessages(prev => [...prev, data])
      }
      // Refresh channel list for unread counts
      loadChannels()
    },
    onStatus: (data) => setWaStatus(data.status),
  })

  const loadChannels = useCallback(() => {
    api('/channels' + (activeTab ? `?tab=${activeTab}` : '')).catch(() => []).then(setChannels)
  }, [activeTab])

  useEffect(() => {
    api('/auth/wa/status').then(data => {
      setWaStatus(data.status)
      if (data.status !== 'open') navigate('/connect')
    }).catch(() => navigate('/login'))

    api('/tabs').catch(() => []).then(setTabs)
    loadChannels()
  }, [])

  useEffect(() => { loadChannels() }, [activeTab, loadChannels])

  useEffect(() => {
    if (!activeJid) return
    api(`/channels/${encodeURIComponent(activeJid)}/messages?limit=50`)
      .then(msgs => setMessages(msgs.reverse()))
      .catch(() => setMessages([]))
  }, [activeJid])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async (e) => {
    e.preventDefault()
    if (!msgInput.trim() || !activeJid) return

    try {
      // Determine send endpoint
      if (activeJid.endsWith('@g.us')) {
        await api('/groups/send', { method: 'POST', body: { jid: activeJid, message: msgInput } })
      } else {
        await api('/personal/send', { method: 'POST', body: { to: activeJid.replace('@s.whatsapp.net', ''), message: msgInput } })
      }
      setMsgInput('')
    } catch (err) {
      // If personal send fails (not in personal numbers), try others
      if (err.code === 'NOT_PERSONAL_NUMBER') {
        try {
          await api('/others/send', { method: 'POST', body: { to: activeJid.replace('@s.whatsapp.net', ''), message: msgInput } })
          setMsgInput('')
        } catch (_) {}
      }
    }
  }

  const toggleTab = (tabId) => {
    setCollapsedTabs(prev => ({ ...prev, [tabId]: !prev[tabId] }))
  }

  const channelsByTab = (tabId) => channels.filter(c => c.tab_id === tabId)
  const inboxChannels = channels.filter(c => !c.tab_id)

  const handleDrop = async (e, tabId) => {
    e.preventDefault()
    const jid = e.dataTransfer.getData('text/plain')
    if (!jid) return
    try {
      await api(`/channels/${encodeURIComponent(jid)}`, {
        method: 'PATCH',
        body: { tab_id: tabId },
      })
      loadChannels()
    } catch (_) {}
  }

  return (
    <div className="flex h-screen bg-bg">
      {/* Sidebar */}
      <div className="w-56 border-r border-border flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="px-3 py-3 border-b border-border flex items-center justify-between">
          <span className="font-mono font-semibold text-accent text-sm">wpp</span>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${waStatus === 'open' ? 'bg-accent' : waStatus === 'connecting' ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <Link to="/tokens" className="text-xs text-neutral-500 hover:text-white font-mono">Tokens</Link>
          </div>
        </div>

        {/* Tabs + channels */}
        <div className="flex-1 overflow-y-auto">
          {tabs.map(tab => (
            <div
              key={tab.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDrop(e, tab.id)}
            >
              <button
                onClick={() => toggleTab(tab.id)}
                className="w-full text-left px-3 py-2 text-xs font-mono text-neutral-400 hover:text-white border-b border-border flex items-center gap-1"
              >
                <span>{collapsedTabs[tab.id] ? '>' : 'v'}</span>
                <span style={{ color: tab.color }}>{tab.name}</span>
                <span className="ml-auto text-neutral-600">{channelsByTab(tab.id).length}</span>
              </button>
              {!collapsedTabs[tab.id] && channelsByTab(tab.id).map(ch => (
                <div
                  key={ch.jid}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', ch.jid)}
                >
                  <ChannelRow channel={ch} active={ch.jid === activeJid} onClick={() => setActiveJid(ch.jid)} />
                </div>
              ))}
            </div>
          ))}

          {/* Inbox - unassigned */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, null)}
          >
            <button
              onClick={() => toggleTab('__inbox')}
              className="w-full text-left px-3 py-2 text-xs font-mono text-neutral-400 hover:text-white border-b border-border flex items-center gap-1"
            >
              <span>{collapsedTabs.__inbox ? '>' : 'v'}</span>
              <span>Inbox</span>
              <span className="ml-auto text-neutral-600">{inboxChannels.length}</span>
            </button>
            {!collapsedTabs.__inbox && inboxChannels.map(ch => (
              <div
                key={ch.jid}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', ch.jid)}
              >
                <ChannelRow channel={ch} active={ch.jid === activeJid} onClick={() => setActiveJid(ch.jid)} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 flex flex-col">
        {activeJid ? (
          <>
            {/* Channel header */}
            <div className="px-4 py-3 border-b border-border">
              <span className="font-mono text-sm">
                {channels.find(c => c.jid === activeJid)?.display_name || activeJid}
              </span>
              <span className="text-xs text-neutral-600 font-mono ml-2">{activeJid}</span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {messages.map(msg => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSend} className="px-4 py-3 border-t border-border flex gap-2">
              <input
                type="text"
                value={msgInput}
                onChange={(e) => setMsgInput(e.target.value)}
                placeholder="Send a message..."
                className="flex-1 bg-bg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                type="submit"
                className="bg-accent text-black px-4 py-2 text-sm font-mono font-semibold hover:bg-emerald-400"
              >
                Send
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-600 font-mono text-sm">
            Select a channel
          </div>
        )}
      </div>
    </div>
  )
}
