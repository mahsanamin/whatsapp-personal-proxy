import { downloadMediaMessage, BufferJSON } from '@whiskeysockets/baileys'
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { getSock, unwrapMessage } from './client.js'
import { db } from '../db/index.js'

// The phone holds its own copy of every photo it sent or received, so a
// re-upload usually can succeed — but only once the phone wakes, re-encrypts
// and uploads. Configurable via MEDIA_REUPLOAD_TIMEOUT_S.

/*
 * Note on the <ack type="server-error"> frames Baileys logs as "unhandled":
 * they are NOT rejections. A media-retry request is itself sent as
 * <receipt type="server-error">, so the ack merely echoes that type back. An
 * earlier version here treated it as a refusal and failed every retry in under
 * a second — the opposite of the intended fix. The real answer arrives later
 * as a separate media-update notification, so waiting is correct.
 */

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new MediaUnavailableError(message, { status: 504 })), ms).unref?.()),
  ])
}

export class MediaUnavailableError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message)
    this.name = 'MediaUnavailableError'
    this.status = status
    this.cause = cause
  }
}

/**
 * WhatsApp's CDN drops media after a while, and a message synced from the
 * phone can carry a URL this device was never able to use. The remedy is
 * updateMediaMessage: it asks the phone to re-upload, and returns a message
 * with fresh media details.
 *
 * The status is read from every place a failure can put it. Baileys throws
 * Boom (err.output.statusCode) while the underlying axios call throws
 * err.response.status — an earlier version checked only the axios shape
 * against a fixed list, so the retry never ran for the Boom errors that
 * Baileys actually raises.
 */
function statusOf(err) {
  return err?.output?.statusCode ?? err?.response?.status ?? err?.status ?? null
}

// Protobuf byte fields arrive as base64 strings on a history sync and survive
// storage that way. Baileys' download path coerces them (getMediaKeys does
// Buffer.from(..., 'base64')), but its retry path does not: getMediaRetryKey
// runs HKDF straight over whatever it is given. Handed the base64 *text*, it
// derives a different key, so the retry receipt is encrypted with the wrong
// one and WhatsApp answers server-error — which reads exactly like expired
// media. Restoring the real bytes first is what makes a re-upload possible.
const BINARY_MEDIA_FIELDS = ['mediaKey', 'fileEncSha256', 'fileSha256', 'thumbnailSha256', 'thumbnailEncSha256']

function restoreBinaryFields(content) {
  if (!content || typeof content !== 'object') return content
  for (const field of BINARY_MEDIA_FIELDS) {
    const value = content[field]
    if (typeof value === 'string' && value.length > 0) {
      try {
        content[field] = Buffer.from(value.replace('data:;base64,', ''), 'base64')
      } catch (_) {
        // Leave it alone; a bad value is better than a thrown request
      }
    }
  }
  return content
}

// Every media kind Baileys can carry, so the right one gets its bytes restored.
const MEDIA_CONTENT_KEYS = [
  'imageMessage', 'videoMessage', 'audioMessage',
  'documentMessage', 'stickerMessage', 'ptvMessage',
]

function restoreMediaBinaries(message) {
  for (const key of MEDIA_CONTENT_KEYS) {
    if (message?.[key]) restoreBinaryFields(message[key])
  }
  return message
}

// A message id can contain characters that are not safe in a filename.
function cacheName(msgRow) {
  const base = String(msgRow.media_sha256 || msgRow.id).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${base}.${mimeToExt(msgRow.media_mime)}`
}

async function readCached(savePath) {
  if (!savePath) return null
  try {
    const info = await stat(savePath)
    // A zero-length file is a failed write, not a cached download. Serving it
    // hands the browser an undecodable image and, because it is cached, does
    // so for good.
    if (!info.isFile() || info.size === 0) return null
    const buffer = await readFile(savePath)
    return buffer.length > 0 ? buffer : null
  } catch (_) {
    return null
  }
}

/**
 * Fetch the bytes for one media message.
 *
 * Nothing is written to disk unless the caller asks for it: viewing a photo in
 * the console should not silently persist every photo the account has ever
 * received. `/media/save` is the explicit "keep a copy" action, and
 * media_saved means exactly that.
 */
export async function downloadMediaOnDemand(msgRow, opts = {}) {
  const savePath = msgRow.media_path || path.join(config.mediaPath, cacheName(msgRow))

  // An already-saved copy is worth reusing whether or not this call saves.
  const cached = await readCached(msgRow.media_saved ? savePath : null)
  if (cached) return { buffer: cached, savePath, fromCache: true }

  if (!msgRow.raw_json) {
    throw new MediaUnavailableError('Message has no stored payload to download from', { status: 404 })
  }

  let raw
  try {
    raw = JSON.parse(msgRow.raw_json, BufferJSON.reviver)
  } catch (err) {
    throw new MediaUnavailableError('Stored message payload is unreadable', { status: 500, cause: err })
  }

  // Baileys looks for the media at the top level of .message. An album child
  // or a disappearing message keeps it one or more envelopes down, and is
  // rejected as "not a media message" unless it is unwrapped first.
  const unwrapped = unwrapMessage(raw.message)
  if (unwrapped && unwrapped !== raw.message) {
    raw = { ...raw, message: unwrapped }
  }
  restoreMediaBinaries(raw.message)

  let buffer
  let firstError = null

  try {
    buffer = await downloadMediaMessage(raw, 'buffer', {})
  } catch (err) {
    firstError = err
  }

  // An empty body is a failure that arrived with a success status; treat it as
  // one rather than caching nothing and serving it forever.
  if (!firstError && (!buffer || buffer.length === 0)) {
    firstError = new MediaUnavailableError('WhatsApp returned an empty file', { status: 502 })
    buffer = null
  }

  if (firstError) {
    const sock = getSock()
    if (!sock) {
      throw new MediaUnavailableError(
        `Media could not be fetched and WhatsApp is not connected: ${firstError.message}`,
        { status: 503, cause: firstError },
      )
    }

    // Ask the phone to re-upload. Attempted on any failure: the status codes
    // that mean "gone" are not reported consistently, and a needless retry
    // costs one round trip while a missed one loses the media entirely.
    //
    // Bounded explicitly: the socket runs with no default query timeout (so a
    // full history sync is not cut short), which would otherwise let a phone
    // that never answers hold this request open indefinitely.
    if (process.env.MEDIA_DEBUG === '1') {
      const c = raw.message?.videoMessage || raw.message?.imageMessage ||
        raw.message?.audioMessage || raw.message?.documentMessage || raw.message?.stickerMessage
      console.error('[media-debug] retry for', msgRow.id,
        '| mediaKey isBuffer =', Buffer.isBuffer(c?.mediaKey),
        '| len =', c?.mediaKey?.length,
        '| keys =', Object.keys(raw.message || {}).join(','))
    }
    try {
      raw = await withTimeout(
        sock.updateMediaMessage(raw),
        config.mediaReuploadTimeoutMs,
        'the phone did not answer the re-upload request in time',
      )
      buffer = await downloadMediaMessage(raw, 'buffer', {})
      if (!buffer || buffer.length === 0) {
        throw new MediaUnavailableError('Re-upload produced an empty file', { status: 502 })
      }
      // The refreshed payload has new media details; keep them so the next
      // request does not have to ask the phone again.
      db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?')
        .run(JSON.stringify(raw, BufferJSON.replacer), msgRow.id)
    } catch (retryErr) {
      if (retryErr instanceof MediaUnavailableError) throw retryErr
      const status = statusOf(retryErr) ?? statusOf(firstError)
      throw new MediaUnavailableError(
        `WhatsApp could not supply this media: ${retryErr.message || firstError.message}`,
        { status: status === 404 || status === 410 ? 404 : 502, cause: retryErr },
      )
    }
  }

  if (opts.saveToDisk) {
    await mkdir(config.mediaPath, { recursive: true })
    await writeFile(savePath, buffer)
    db.prepare('UPDATE messages SET media_saved = 1, media_path = ? WHERE id = ?')
      .run(savePath, msgRow.id)
    return { buffer, savePath, saved: true }
  }

  return { buffer, savePath }
}

function mimeToExt(mime) {
  const baseMime = (mime || '').split(';')[0].trim().toLowerCase()
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }
  return map[baseMime] || 'bin'
}
