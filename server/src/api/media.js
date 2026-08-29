import { requireAnyCredential } from '../middleware/token.js'
import { loadRawMessage } from '../util/messageRef.js'
import { refuseIfNotAllowed } from '../util/sendPermission.js'
import { toJid, isGroup } from '../util/jid.js'
import { ensureConnected, recordSentMessage } from '../wa/client.js'
import { config } from '../config.js'

// WhatsApp's own ceiling is ~16MB for inline media and ~100MB for documents.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const KINDS = new Set(['image', 'video', 'audio', 'document', 'sticker'])

// Guess the kind from the mime type so a caller can just send bytes.
function kindFromMime(mime = '') {
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

/**
 * Build the Baileys content for one upload.
 *
 * A voice note is an audio message with ptt set; WhatsApp renders it as a
 * waveform with a play button rather than an attached file. It wants
 * Opus-in-Ogg — other codecs upload but some clients will not play them
 * inline, so the mime type is passed through rather than guessed at.
 */
function buildContent({ kind, buffer, mimetype, filename, caption, voice, gif }) {
  switch (kind) {
    case 'image':
      return { image: buffer, mimetype, ...(caption ? { caption } : {}) }
    case 'video':
      return { video: buffer, mimetype, ...(caption ? { caption } : {}), ...(gif ? { gifPlayback: true } : {}) }
    case 'audio':
      return {
        audio: buffer,
        mimetype: mimetype || (voice ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
        ptt: Boolean(voice),
      }
    case 'sticker':
      return { sticker: buffer }
    default:
      return {
        document: buffer,
        mimetype: mimetype || 'application/octet-stream',
        fileName: filename || 'file',
        ...(caption ? { caption } : {}),
      }
  }
}

export default async function mediaRoutes(fastify) {
  // Accept any binary body. Sending raw bytes with the metadata in the query
  // string keeps the CLI dependency-free — no multipart encoder, no extra
  // server package.
  //
  // Fastify's built-in text/plain and application/json parsers would otherwise
  // win over the wildcard and hand us a string or an object instead of the
  // file: a .txt upload arrived empty and a .json one would have been parsed.
  // Content-type parsers are encapsulated, so dropping them here does not
  // affect the JSON routes registered elsewhere.
  fastify.removeContentTypeParser(['text/plain', 'application/json'])
  fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (req, body, done) => {
    done(null, body)
  })

  fastify.post('/media/send', {
    preHandler: requireAnyCredential,
    bodyLimit: MAX_UPLOAD_BYTES,
    config: config.rateLimitSend > 0
      ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const { to, caption, filename, voice, gif, reply_to: replyTo } = request.query
    const kindParam = request.query.kind

    const jid = toJid(to)
    if (!jid) {
      return reply.code(400).send({ error: 'Query parameter "to" must be a number or JID', code: 'BAD_INPUT' })
    }
    if (refuseIfNotAllowed(request, reply, jid)) return

    const buffer = request.body
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return reply.code(400).send({ error: 'Request body must contain the file bytes', code: 'BAD_INPUT' })
    }

    const mimetype = request.headers['content-type'] === 'application/octet-stream'
      ? (request.query.mimetype || 'application/octet-stream')
      : (request.query.mimetype || request.headers['content-type'] || 'application/octet-stream')

    const isVoice = voice === 'true' || voice === '1'
    let kind = kindParam || kindFromMime(mimetype)
    if (isVoice) kind = 'audio'
    if (!KINDS.has(kind)) {
      return reply.code(400).send({
        error: `Unknown kind "${kind}". Use one of: ${[...KINDS].join(', ')}`,
        code: 'BAD_INPUT',
      })
    }

    const sock = ensureConnected()
    if (!sock) {
      return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
    }

    const content = buildContent({
      kind,
      buffer,
      mimetype,
      filename,
      caption,
      voice: isVoice,
      gif: gif === 'true' || gif === '1',
    })

    const options = {}
    if (replyTo) {
      const quoted = loadRawMessage(replyTo)
      if (!quoted) {
        return reply.code(404).send({ error: 'Message to reply to was not found', code: 'NOT_FOUND' })
      }
      options.quoted = quoted
    }

    try {
      const result = await sock.sendMessage(jid, content, options)
      recordSentMessage(result)
      return {
        ok: true,
        messageId: result.key.id,
        to: jid,
        kind,
        bytes: buffer.length,
        mimetype,
        ...(isVoice ? { voice_note: true } : {}),
      }
    } catch (err) {
      request.log.error({ err }, 'media send failed')
      return reply.code(502).send({ error: `WhatsApp rejected the upload: ${err.message}`, code: 'SEND_FAILED' })
    }
  })
}
