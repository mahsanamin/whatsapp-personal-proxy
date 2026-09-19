import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  BufferJSON,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { canonicalJid, resolveNames, expandJids } from '../db/lidmap.js'
import { saveContactName, repairContactNames } from '../db/contactNames.js'
import { applyUnreadUpdate, unreadState, recordUnreadMessage, applyUnreadReceipt } from '../db/unread.js'
import { incomingContact } from '../util/contactIdentity.js'
import { jidUser } from '../util/jid.js'

const MAX_RETRIES = 10
let retries = 0
let currentSock = null
let sessionDir = config.waSessionPath
let linkedCache = null
let linkedPhoneNumber = null

// Every address that means "the owner". A mention can name the phone-number
// JID or the @lid one, and PERSONAL_NUMBERS covers a second handset.
let myJids = new Set()

function rememberMyJids(creds) {
  const found = new Set()
  for (const value of [creds?.me?.id, creds?.me?.lid]) {
    const user = jidUser(value)
    if (user) found.add(user)
  }
  for (const number of config.personalNumbers) {
    found.add(String(number).replace(/\D/g, ''))
  }
  linkedPhoneNumber = jidUser(creds?.me?.id)
  myJids = found
}

export function isOwnJid(jid) {
  const user = jidUser(jid)
  const liveUser = jidUser(currentSock?.user?.id)
  return Boolean(user && (myJids.has(user) || user === liveUser))
}

export function getPersonalNumbers() {
  const numbers = [...config.personalNumbers]
  if (linkedPhoneNumber && !numbers.some(number => String(number).replace(/\D/g, '') === linkedPhoneNumber)) {
    numbers.push(`+${linkedPhoneNumber}`)
  }
  return numbers
}

export function getLinkedPhoneNumber() {
  return linkedPhoneNumber ? `+${linkedPhoneNumber}` : null
}

function mentionsMe(message) {
  const contexts = [
    message?.extendedTextMessage?.contextInfo,
    message?.imageMessage?.contextInfo,
    message?.videoMessage?.contextInfo,
    message?.documentMessage?.contextInfo,
    message?.audioMessage?.contextInfo,
  ]
  for (const context of contexts) {
    for (const jid of (context?.mentionedJid || [])) {
      if (myJids.has(String(jid).split(':')[0].split('@')[0])) return true
    }
  }
  return false
}

const logger = pino({ level: config.waLogLevel })

export async function createWAClient(sessionPath, eventBus) {
  // Close existing socket to prevent duplicate listeners
  if (currentSock) {
    try { currentSock.end() } catch (_) {}
    currentSock = null
  }

  sessionDir = sessionPath
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  refreshLinked()
  rememberMyJids(state.creds)

  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Signal key lookups hit the filesystem on every decrypt. Uncached they
      // are slow enough that companion/peer messages fail to decrypt, which is
      // what makes the phone report "Device out of sync".
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('WPP'),
    // The proxy is a secondary device. Marking it online steals push
    // notifications from the phone, which is not what a personal proxy should do.
    markOnlineOnConnect: false,
    // The first connect runs init queries while a full history sync is still in
    // flight; the 60s default times them out on an account with real history.
    defaultQueryTimeoutMs: undefined,
    printQRInTerminal: false,
    syncFullHistory: true,
    mediaCache: undefined,
    getMessage: async (key) => {
      const msg = db.prepare('SELECT raw_json FROM messages WHERE id = ?').get(key.id)
      if (msg?.raw_json) {
        const parsed = JSON.parse(msg.raw_json, BufferJSON.reviver)
        return parsed.message
      }
      return undefined
    },
    logger,
  })

  currentSock = sock
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    refreshLinked()
    rememberMyJids(state.creds)
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Convert QR string to base64 PNG
      const QRCode = (await import('qrcode')).default
      const png = await QRCode.toDataURL(qr)
      eventBus.lastQr = png
      eventBus.qrTimestamp = Date.now()
      eventBus.emit('wa.qr', png)
    }

    if (connection === 'open') {
      retries = 0
      linkedCache = true
      eventBus.lastQr = null
      eventBus.waStatus = 'open'
      eventBus.emit('wa.status', { status: 'open' })

      // Repair any history that was ingested before the mapping fields above
      // were read correctly.
      try {
        const { backfillLidMap } = await import('../db/lidmap.js')
        const contacts = repairContactNames(db)
        const repaired = backfillLidMap()
        repaired.contacts = contacts
        if (repaired.mappings || repaired.names || repaired.contacts) {
          logger.info({ repaired }, 'backfilled LID/phone-number mappings')
        }
      } catch (_) {}

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
        // Non-fatal
      }

      // Resolve group names for unnamed group channels
      try {
        const unnamedGroups = db.prepare(
          "SELECT jid FROM channel_meta WHERE display_name IS NULL AND jid LIKE '%@g.us'"
        ).all()
        for (const { jid } of unnamedGroups) {
          try {
            const meta = await sock.groupMetadata(jid)
            if (meta?.subject) {
              db.prepare('UPDATE channel_meta SET display_name = ? WHERE jid = ?').run(meta.subject, jid)
            }
          } catch (_) {}
        }
      } catch (_) {}
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

      if (isLoggedOut) {
        // The phone unlinked this device: the credentials are dead. Clear them
        // so the console can offer a QR code again instead of insisting it is
        // still linked.
        clearSession()
        eventBus.emit('wa.logged_out')
        return
      }

      if (isForbidden) {
        // Possibly temporary. Do not destroy working credentials over it.
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

  // ─── Contact name resolution system ────────────────────────────────
  // WhatsApp uses @lid JIDs for chats but names come with @s.whatsapp.net JIDs.
  // We maintain a lid_map table to cross-reference, then propagate names.

  const stmts = {
    upsertChannel: db.prepare(`
      INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET display_name = COALESCE(excluded.display_name, channel_meta.display_name)
    `),
    upsertLidMap: db.prepare(`
      INSERT INTO lid_map (lid, pn) VALUES (?, ?)
      ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = datetime('now')
    `),
  }

  // Store a LID-to-PN mapping and propagate any known name
  function storeLidMapping(lid, pn) {
    if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) return
    try {
      stmts.upsertLidMap.run(lid, pn)
      const rows = db.prepare('SELECT jid, display_name, name_rank FROM channel_meta WHERE jid IN (?, ?) AND display_name IS NOT NULL ORDER BY name_rank DESC, CASE WHEN jid = ? THEN 0 ELSE 1 END').all(pn, lid, pn)
      if (rows[0]) saveContactName(db, rows[0].jid, rows[0].display_name, rows[0].name_rank)
    } catch (_) {}
  }

  // Upsert a contact name, also propagating via LID map
  function upsertContact(id, name, rank = 1) {
    saveContactName(db, id, name, rank)
  }

  // Process a contact object from Baileys (contacts.upsert / messaging-history.set)
  function processContact(contact) {
    // Address book name takes priority over pushName
    const name = contact.name || contact.notify || contact.verifiedName
    if (name && contact.id) upsertContact(contact.id, name, contact.name ? 3 : 1)
    if (name && contact.lid) upsertContact(contact.lid, name, contact.name ? 3 : 1)
    if (name && contact.phoneNumber) upsertContact(contact.phoneNumber, name, contact.name ? 3 : 1)
    // Store LID-PN mapping
    if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
      storeLidMapping(contact.lid, contact.id)
    }
    if (contact.lid && contact.phoneNumber) {
      storeLidMapping(contact.lid, contact.phoneNumber)
    }
    if (contact.id?.endsWith('@lid') && contact.phoneNumber) {
      storeLidMapping(contact.id, contact.phoneNumber)
    }
  }

  // Extract the LID/phone-number correspondence from a message key.
  //
  // Baileys 6.7.x carries the counterpart address on the key itself:
  // senderPn/senderLid for direct chats, participantPn/participantLid inside
  // groups. An earlier version of this code looked for remoteJidAlt and
  // participantAlt, which this Baileys never emits — so lid_map stayed empty,
  // names never propagated, and every contact appeared twice in the chat list,
  // once per address.
  function extractMappingFromMessage(msg) {
    const key = msg.key
    if (!key) return

    // Direct chat filed under the LID; the key names the phone number.
    if (!key.fromMe) storeLidMapping(key.remoteJid, key.senderPn)
    // Direct chat filed under the phone number; the key names the LID.
    if (!key.fromMe) storeLidMapping(key.senderLid, key.remoteJid)
    storeLidMapping(key.senderLid, key.senderPn)

    // Inside a group the sender is the participant, addressed either way.
    storeLidMapping(key.participant, key.participantPn)
    storeLidMapping(key.participantLid, key.participant)
    storeLidMapping(key.participantLid, key.participantPn)
  }

  function syncUnread(chat, source = 'live') {
    if (!chat.id) return
    const jids = expandJids(chat.id)
    if (applyUnreadUpdate(db, jids, chat, source)) {
      eventBus.emit('channel.update', { jid: canonicalJid(chat.id), ...unreadState(db, jids) })
    }
  }

  // ─── Chat sync events ─────────────────────────────────────────────
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      try {
        stmts.upsertChannel.run(chat.id, null)
        if (chat.name) upsertContact(chat.id, chat.name, 2)
        // Extract LID-PN from chat object
        if (chat.lidJid && chat.pnJid) storeLidMapping(chat.lidJid, chat.pnJid)
        if (chat.id?.endsWith('@lid') && chat.pnJid) storeLidMapping(chat.id, chat.pnJid)
        syncUnread(chat)
      } catch (_) {}
    }
  })

  sock.ev.on('chats.update', (updates) => {
    for (const chat of updates) {
      try {
        if (chat.id) stmts.upsertChannel.run(chat.id, null)
        if (chat.name) upsertContact(chat.id, chat.name, 2)
        if (chat.lidJid && chat.pnJid) storeLidMapping(chat.lidJid, chat.pnJid)
        syncUnread(chat)
      } catch (_) {}
    }
  })

  // ─── Contact sync events ──────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) processContact(contact)
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const contact of updates) processContact(contact)
  })

  // ─── LID mapping events ───────────────────────────────────────────
  sock.ev.on('lid-mapping.update', (mappings) => {
    for (const { lid, pn } of (Array.isArray(mappings) ? mappings : [mappings])) {
      storeLidMapping(lid, pn)
    }
  })

  // ─── History sync ─────────────────────────────────────────────────
  sock.ev.on('messaging-history.set', ({ messages: msgs, chats, contacts, lidPnMappings }) => {
    // Process LID-PN mappings FIRST so names can propagate
    for (const mapping of (lidPnMappings || [])) {
      storeLidMapping(mapping.lid, mapping.pn)
    }

    for (const chat of (chats || [])) {
      try {
        stmts.upsertChannel.run(chat.id, null)
        if (chat.name) upsertContact(chat.id, chat.name, 2)
        if (chat.lidJid && chat.pnJid) storeLidMapping(chat.lidJid, chat.pnJid)
        if (chat.id?.endsWith('@lid') && chat.pnJid) storeLidMapping(chat.id, chat.pnJid)
        syncUnread(chat, 'history')
      } catch (_) {}
    }

    for (const contact of (contacts || [])) processContact(contact)

    for (const msg of (msgs || [])) {
      try {
        extractMappingFromMessage(msg)
        const contact = incomingContact(msg)
        if (contact) upsertContact(contact.jid, contact.name)
        const normalized = normalizeMessage(msg)
        if (!normalized) continue
        saveMessage(normalized)
        archiveMedia(normalized)
      } catch (_) {}
    }
  })

  // Message ingestion — text + media stubs, NEVER download
  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      try {
        // Extract LID-PN mapping from message keys
        extractMappingFromMessage(msg)

        // Extract pushName to resolve contact names
        const contact = incomingContact(msg)
        if (contact) upsertContact(contact.jid, contact.name)

        const normalized = normalizeMessage(msg)
        if (!normalized) continue
        saveMessage(normalized)
        recordUnreadMessage(db, normalized)
        archiveMedia(normalized)
        // Broadcast the address the chat is filed under as well as the one the
        // message arrived on, so a subscriber can tell they are the same
        // conversation without repeating the lid_map lookup itself.
        eventBus.emit('message.new', {
          ...normalized,
          canonical_jid: canonicalJid(normalized.jid),
          from_name: resolveNames([normalized.from_jid]).get(normalized.from_jid) || null,
        })
      } catch (err) {
        // Never crash on a bad message
      }
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      try {
        updateMessageStatus(update)
        if ([4, 5].includes(update.update?.status) && update.key?.remoteJid && update.key?.id) {
          const jids = expandJids(update.key.remoteJid)
          if (applyUnreadReceipt(db, jids, update.key.id)) {
            eventBus.emit('channel.update', { jid: canonicalJid(update.key.remoteJid), ...unreadState(db, jids) })
          }
        }
        eventBus.emit('message.update', update)
      } catch (err) {
        // Non-fatal
      }
    }
  })

  return sock
}

/**
 * Protobuf numbers arrive as Long objects ({low, high, unsigned}), not JS
 * numbers, and better-sqlite3 refuses to bind an object. fileLength is one, so
 * every image, video, audio and document threw on insert and was swallowed by
 * the catch around ingestion — which is why the mirror held text and stickers
 * (the one media branch that never sets a size) and nothing else.
 */
function toNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value.toNumber === 'function') {
    try { return value.toNumber() } catch (_) { return null }
  }
  if (typeof value.low === 'number') {
    return value.low + (value.high || 0) * 4294967296
  }
  return null
}

/**
 * WhatsApp nests real content inside envelopes: an album's photos arrive as
 * associatedChildMessage, a disappearing message as ephemeralMessage, and so
 * on. Reading only the top level classified all of them as 'unknown' and threw
 * away their media keys, so albums — several photos or videos sent together —
 * never appeared at all.
 */
const MESSAGE_ENVELOPES = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'associatedChildMessage',
  'editedMessage',
  'deviceSentMessage',
]

export function unwrapMessage(message) {
  let current = message
  // Envelopes nest: a disappearing album child is wrapped twice.
  for (let depth = 0; current && depth < 5; depth++) {
    const envelope = MESSAGE_ENVELOPES.find(name => current?.[name]?.message)
    if (!envelope) break
    current = current[envelope].message
  }
  return current
}

export function normalizeMessage(raw) {
  const key = raw.key
  if (!key?.id || !key?.remoteJid) return null

  const jid = key.remoteJid
  const fromJid = key.participant || key.remoteJid

  // Skip status broadcasts
  if (jid === 'status@broadcast') return null

  // Determine type and extract text
  const msg = unwrapMessage(raw.message)
  if (!msg) return null

  // Skip protocol/system messages (security notifications, app state sync, etc.)
  if (msg.protocolMessage || msg.senderKeyDistributionMessage || msg.messageContextInfo) {
    // If it's ONLY these keys with no actual content, skip
    const contentKeys = Object.keys(msg).filter(k =>
      k !== 'protocolMessage' && k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo'
    )
    if (contentKeys.length === 0) return null
  }

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
    mediaSize = toNumber(msg.imageMessage.fileLength)
    mediaSha256 = msg.imageMessage.fileSha256 ? Buffer.from(msg.imageMessage.fileSha256).toString('hex') : null
    mediaKey = msg.imageMessage.mediaKey ? Buffer.from(msg.imageMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.imageMessage.url
  } else if (msg.videoMessage) {
    type = 'video'
    body = msg.videoMessage.caption || null
    mediaMime = msg.videoMessage.mimetype
    mediaSize = toNumber(msg.videoMessage.fileLength)
    mediaSha256 = msg.videoMessage.fileSha256 ? Buffer.from(msg.videoMessage.fileSha256).toString('hex') : null
    mediaKey = msg.videoMessage.mediaKey ? Buffer.from(msg.videoMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.videoMessage.url
  } else if (msg.documentMessage) {
    type = 'doc'
    body = msg.documentMessage.fileName || null
    mediaMime = msg.documentMessage.mimetype
    mediaSize = toNumber(msg.documentMessage.fileLength)
    mediaSha256 = msg.documentMessage.fileSha256 ? Buffer.from(msg.documentMessage.fileSha256).toString('hex') : null
    mediaKey = msg.documentMessage.mediaKey ? Buffer.from(msg.documentMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.documentMessage.url
  } else if (msg.audioMessage) {
    // WhatsApp shows a voice note as a waveform and an audio file as an
    // attachment. They are different things to a reader, so name them apart.
    type = msg.audioMessage.ptt ? 'voice' : 'audio'
    mediaMime = msg.audioMessage.mimetype
    mediaSize = toNumber(msg.audioMessage.fileLength)
    mediaSha256 = msg.audioMessage.fileSha256 ? Buffer.from(msg.audioMessage.fileSha256).toString('hex') : null
    mediaKey = msg.audioMessage.mediaKey ? Buffer.from(msg.audioMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.audioMessage.url
  } else if (msg.stickerMessage) {
    type = 'sticker'
    mediaMime = msg.stickerMessage.mimetype
    mediaSha256 = msg.stickerMessage.fileSha256 ? Buffer.from(msg.stickerMessage.fileSha256).toString('hex') : null
    mediaKey = msg.stickerMessage.mediaKey ? Buffer.from(msg.stickerMessage.mediaKey).toString('base64') : null
    mediaUrl = msg.stickerMessage.url
  } else if (msg.albumMessage) {
    // The container for a set of photos sent together. It carries no media of
    // its own — each item arrives as a separate associatedChildMessage — but
    // recording it means an album whose children are missing still shows up
    // instead of vanishing.
    type = 'album'
    // expectedImageCount counts every visual tile, videos included — an album
    // of five one-second clips reports five images — so say "items" rather
    // than claim a kind the count cannot actually distinguish.
    const items = (toNumber(msg.albumMessage.expectedImageCount) || 0) +
      (toNumber(msg.albumMessage.expectedVideoCount) || 0)
    body = items ? `Album — ${items} item${items === 1 ? '' : 's'}` : 'Album'
  } else if (msg.locationMessage || msg.liveLocationMessage) {
    const loc = msg.locationMessage || msg.liveLocationMessage
    type = 'location'
    body = loc.name || loc.address ||
      (loc.degreesLatitude != null ? `${loc.degreesLatitude}, ${loc.degreesLongitude}` : null)
  } else if (msg.contactMessage || msg.contactsArrayMessage) {
    type = 'contact'
    body = msg.contactMessage?.displayName ||
      (msg.contactsArrayMessage?.contacts || []).map(c => c.displayName).filter(Boolean).join(', ') || null
  } else if (msg.reactionMessage) {
    type = 'reaction'
    body = msg.reactionMessage.text
    // reactionMessage target stored below in quotedId
  } else {
    // Unknown message type — store raw but no body
    type = 'unknown'
  }

  const quotedId = msg.reactionMessage?.key?.id || msg.extendedTextMessage?.contextInfo?.stanzaId || null
  const mentioned = key.fromMe ? 0 : (mentionsMe(msg) ? 1 : 0)
  // messageTimestamp is a protobuf 64-bit value: it arrives as a string on a
  // history sync and as a Long on live messages, never as a plain number. The
  // old `typeof === 'number'` test therefore failed for every message and
  // stamped them all with the moment they were ingested, collapsing years of
  // history onto the instant the account was linked.
  const sentAt = toNumber(raw.messageTimestamp)
  const timestamp = sentAt
    ? new Date(sentAt * 1000).toISOString()
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
    mentions_me: mentioned,
    raw_json: JSON.stringify(raw, BufferJSON.replacer),
  }
}

/**
 * Keep a copy while WhatsApp still has one.
 *
 * Media lives on WhatsApp's CDN for a limited time; after that a download
 * returns 403 and the only recourse is asking the phone to re-upload, which it
 * frequently declines or ignores. Anything not archived on arrival is likely to
 * be unrecoverable later, so this is opt-in but strongly recommended for an
 * account whose media matters.
 *
 * Deliberately fire-and-forget: archiving must never delay or fail ingestion.
 */
function archiveMedia(msg) {
  if (!config.mediaAutoDownload) return
  if (!msg.media_key) return
  if (config.mediaAutoDownloadMaxBytes > 0 &&
      msg.media_size > config.mediaAutoDownloadMaxBytes) return

  setImmediate(async () => {
    try {
      const { downloadMediaOnDemand } = await import('./media.js')
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id)
      if (!row || row.media_saved) return
      await downloadMediaOnDemand(row, { saveToDisk: true })
    } catch (err) {
      logger.warn({ id: msg.id, type: msg.type, err: err.message }, 'could not archive media on arrival')
    }
  })
}

function saveMessage(msg) {
  try {
    insertMessage(msg)
  } catch (err) {
    // Losing a message silently is how the media bug above survived so long.
    logger.warn({ err: err.message, id: msg.id, type: msg.type }, 'failed to store message')
    throw err
  }
}

function insertMessage(msg) {
  db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, jid, from_jid, body, type, media_mime, media_size, media_sha256, media_key, media_url, timestamp, is_from_me, status, quoted_id, mentions_me, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.jid, msg.from_jid, msg.body, msg.type,
    msg.media_mime, msg.media_size, msg.media_sha256, msg.media_key, msg.media_url,
    msg.timestamp, msg.is_from_me, msg.status, msg.quoted_id, msg.mentions_me ?? 0, msg.raw_json,
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

function refreshLinked() {
  try {
    const credsPath = path.join(sessionDir, 'creds.json')
    if (!existsSync(credsPath)) {
      linkedCache = false
      return linkedCache
    }
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
    linkedCache = Boolean(creds?.registered || creds?.me?.id)
  } catch (_) {
    linkedCache = false
  }
  return linkedCache
}

/** Delete the stored WhatsApp credentials so a fresh pairing can start. */
export function clearSession() {
  try {
    rmSync(sessionDir, { recursive: true, force: true })
    mkdirSync(sessionDir, { recursive: true })
  } catch (_) {}
  linkedCache = false
}

/**
 * Persist a message we just sent, immediately.
 *
 * Sent messages otherwise only land when WhatsApp echoes them back through
 * messages.upsert, which is a moment later — long enough that replying to or
 * reacting to a message you just sent failed with NOT_FOUND. Writing it here
 * makes the id usable the instant the send returns. The later echo rewrites
 * the same primary key, so nothing is duplicated.
 */
export function recordSentMessage(raw) {
  try {
    const normalized = normalizeMessage(raw)
    if (!normalized) return null
    saveMessage(normalized)
    return normalized
  } catch (_) {
    return null
  }
}

export function getSock() {
  return currentSock
}

/**
 * Has a phone completed pairing? Deliberately read from the credentials on
 * disk, not from the live socket: pairing is always followed by a mandatory
 * restart (stream error 515) during which there is no socket at all, and
 * deriving this from the socket made a freshly linked account look unlinked
 * and bounced the user back to the QR page mid-sync.
 */
export function isLinked() {
  return linkedCache ?? refreshLinked()
}

export function ensureConnected() {
  if (!currentSock?.user) return null
  return currentSock
}

export function resetRetries() {
  retries = 0
}


// Graceful shutdown
process.on('SIGTERM', async () => {
  if (currentSock) {
    try { currentSock.end() } catch (_) {}
  }
  process.exit(0)
})
