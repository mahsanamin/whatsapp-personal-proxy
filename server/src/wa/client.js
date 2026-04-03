import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'

const MAX_RETRIES = 10
let retries = 0
let currentSock = null

export async function createWAClient(sessionPath, eventBus) {
  // Close existing socket to prevent duplicate listeners
  if (currentSock) {
    try { currentSock.end() } catch (_) {}
    currentSock = null
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    downloadHistory: false,
    syncFullHistory: false,
    mediaCache: undefined,
    getMessage: async () => undefined,
    logger: pino({ level: 'warn' }),
  })

  currentSock = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Convert QR string to base64 PNG
      const QRCode = (await import('qrcode')).default
      const png = await QRCode.toDataURL(qr)
      eventBus.lastQr = png
      eventBus.emit('wa.qr', png)
    }

    if (connection === 'open') {
      retries = 0
      eventBus.lastQr = null
      eventBus.waStatus = 'open'
      eventBus.emit('wa.status', { status: 'open' })

      // Sync all groups into channel_meta on connect
      try {
        const groups = await sock.groupFetchAllParticipating()
        const upsert = db.prepare(`
          INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)
          ON CONFLICT(jid) DO UPDATE SET display_name = COALESCE(excluded.display_name, channel_meta.display_name)
        `)
        for (const [jid, meta] of Object.entries(groups)) {
          upsert.run(jid, meta.subject)
        }
      } catch (e) {
        // Non-fatal — channel list will still populate from message history
      }
    }

    if (connection === 'connecting') {
      eventBus.waStatus = 'connecting'
      eventBus.emit('wa.status', { status: 'connecting' })
    }

    if (connection === 'close') {
      eventBus.waStatus = 'close'
      eventBus.emit('wa.status', { status: 'close' })

      const code = lastDisconnect?.error?.output?.statusCode

      const isLoggedOut = code === DisconnectReason.loggedOut
      const isForbidden = code === DisconnectReason.forbidden

      if (isLoggedOut || isForbidden) {
        eventBus.emit('wa.logged_out')
        return
      }

      // Retry with exponential backoff
      if (retries < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, retries), 60_000)
        retries++
        setTimeout(() => createWAClient(sessionPath, eventBus), delay)
      } else {
        eventBus.emit('wa.failed', { message: 'Max reconnect attempts reached' })
      }
    }
  })

  // Message ingestion — text + media stubs, NEVER download
  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      try {
        const normalized = normalizeMessage(msg)
        if (!normalized) continue
        saveMessage(normalized)
        eventBus.emit('message.new', normalized)
      } catch (err) {
        // Never crash on a bad message
      }
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      try {
        updateMessageStatus(update)
        eventBus.emit('message.update', update)
      } catch (err) {
        // Non-fatal
      }
    }
  })

  return sock
}

function normalizeMessage(raw) {
  const key = raw.key
  if (!key?.id || !key?.remoteJid) return null

  const jid = key.remoteJid
  const fromJid = key.participant || key.remoteJid

  // Determine type and extract text
  const msg = raw.message
  if (!msg) return null

  let body = null
  let type = 'text'
  let mediaMime = null
  let mediaSize = null
  let mediaSha256 = null
  let mediaKey = null
  let mediaUrl = null

  if (msg.conversation) {
    body = msg.conversation
  } else if (msg.extendedTextMessage) {
    body = msg.extendedTextMessage.text
  } else if (msg.imageMessage) {
    type = 'image'
    body = msg.imageMessage.caption || null
    mediaMime = msg.imageMessage.mimetype
    mediaSize = msg.imageMessage.fileLength
    mediaSha256 = msg.imageMessage.fileSha256 ? Buffer.from(msg.imageMessage.fileSha256).toString('hex') : null
    mediaKey = msg.imageMessage.mediaKey ? Buffer.from(msg.imageMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.imageMessage.url
  } else if (msg.videoMessage) {
    type = 'video'
    body = msg.videoMessage.caption || null
    mediaMime = msg.videoMessage.mimetype
    mediaSize = msg.videoMessage.fileLength
    mediaSha256 = msg.videoMessage.fileSha256 ? Buffer.from(msg.videoMessage.fileSha256).toString('hex') : null
    mediaKey = msg.videoMessage.mediaKey ? Buffer.from(msg.videoMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.videoMessage.url
  } else if (msg.documentMessage) {
    type = 'doc'
    body = msg.documentMessage.fileName || null
    mediaMime = msg.documentMessage.mimetype
    mediaSize = msg.documentMessage.fileLength
    mediaSha256 = msg.documentMessage.fileSha256 ? Buffer.from(msg.documentMessage.fileSha256).toString('hex') : null
    mediaKey = msg.documentMessage.mediaKey ? Buffer.from(msg.documentMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.documentMessage.url
  } else if (msg.audioMessage) {
    type = 'audio'
    mediaMime = msg.audioMessage.mimetype
    mediaSize = msg.audioMessage.fileLength
    mediaSha256 = msg.audioMessage.fileSha256 ? Buffer.from(msg.audioMessage.fileSha256).toString('hex') : null
    mediaKey = msg.audioMessage.mediaKey ? Buffer.from(msg.audioMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.audioMessage.url
  } else if (msg.stickerMessage) {
    type = 'sticker'
    mediaMime = msg.stickerMessage.mimetype
    mediaSha256 = msg.stickerMessage.fileSha256 ? Buffer.from(msg.stickerMessage.fileSha256).toString('hex') : null
    mediaKey = msg.stickerMessage.mediaKey ? Buffer.from(msg.stickerMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.stickerMessage.url
  } else if (msg.reactionMessage) {
    type = 'reaction'
    body = msg.reactionMessage.text
  } else {
    // Unknown message type — store raw but no body
    type = 'unknown'
  }

  const quotedId = msg.extendedTextMessage?.contextInfo?.stanzaId || null
  const timestamp = typeof raw.messageTimestamp === 'number'
    ? new Date(raw.messageTimestamp * 1000).toISOString()
    : new Date().toISOString()

  return {
    id: key.id,
    jid,
    from_jid: fromJid,
    body,
    type,
    media_mime: mediaMime,
    media_size: mediaSize,
    media_sha256: mediaSha256,
    media_key: mediaKey,
    media_url: mediaUrl,
    timestamp,
    is_from_me: key.fromMe ? 1 : 0,
    status: 'sent',
    quoted_id: quotedId,
    raw_json: JSON.stringify(raw, BufferJSON.replacer),
  }
}

function saveMessage(msg) {
  db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, jid, from_jid, body, type, media_mime, media_size, media_sha256, media_key, media_url, timestamp, is_from_me, status, quoted_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.jid, msg.from_jid, msg.body, msg.type,
    msg.media_mime, msg.media_size, msg.media_sha256, msg.media_key, msg.media_url,
    msg.timestamp, msg.is_from_me, msg.status, msg.quoted_id, msg.raw_json,
  )

  // Upsert channel_meta for DMs
  db.prepare(`
    INSERT INTO channel_meta (jid) VALUES (?)
    ON CONFLICT(jid) DO NOTHING
  `).run(msg.jid)
}

function updateMessageStatus(update) {
  if (update.update?.status) {
    const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' }
    const status = statusMap[update.update.status]
    if (status && update.key?.id) {
      db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, update.key.id)
    }
  }
}

export function getSock() {
  return currentSock
}

export function ensureConnected() {
  if (!currentSock?.user) return null
  return currentSock
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (currentSock) {
    try { currentSock.end() } catch (_) {}
  }
  process.exit(0)
})
