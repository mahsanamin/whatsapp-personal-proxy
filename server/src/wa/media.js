import { downloadMediaMessage, BufferJSON } from '@whiskeysockets/baileys'
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { getSock, unwrapMessage } from './client.js'
import { db } from '../db/index.js'

// The phone holds its own copy of every photo it sent or received, so a
// re-upload usually can succeed — but only once the phone wakes, re-encrypts
// and uploads. Configurable via MEDIA_REUPLOAD_TIMEOUT_S.

/**
 * Watch for WhatsApp rejecting a media retry.
 *
 * The reply to a retry request is an <ack class="receipt" type="server-error">
 * carrying the message id. Baileys waits only for the media-update
 * notification and logs that ack as "unhandled", so a refusal reads exactly
 * like a phone that never answered — the request sat until it timed out.
 * Listening for it turns a two-minute hang into an immediate, accurate answer.
 */
function watchForRejection(sock, messageId) {
  let cleanup = () => {}
  const rejected = new Promise((_, reject) => {
    const onAck = (node) => {
      if (node?.attrs?.id !== messageId) return
      if (node?.attrs?.type !== 'server-error') return
      reject(new MediaUnavailableError(
        'WhatsApp refused to re-upload this media (server-error). The copy on ' +
        'its servers has expired and the phone did not supply a replacement.',
        { status: 404 },
      ))
    }
    try {
      sock.ws.on('CB:ack', onAck)
      cleanup = () => { try { sock.ws.off('CB:ack', onAck) } catch (_) {} }
    } catch (_) {
      // If the raw frame stream is unavailable, fall back to the timeout.
    }
  })
  return { rejected, cleanup }
}

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
    const watcher = watchForRejection(sock, msgRow.id)
    try {
      raw = await Promise.race([
        withTimeout(
          sock.updateMediaMessage(raw),
          config.mediaReuploadTimeoutMs,
          'the phone did not answer the re-upload request in time',
        ),
        watcher.rejected,
      ])
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
    } finally {
      watcher.cleanup()
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
