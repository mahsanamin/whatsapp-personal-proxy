import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'
import { downloadMediaOnDemand, MediaUnavailableError } from '../wa/media.js'
import { expandJids, resolveNames } from '../db/lidmap.js'
import { toJid, channelType } from '../util/jid.js'

// Attach reactions to their target message and drop the standalone
// reaction rows, which are noise in a transcript.
function withReactions(messages) {
  const msgIds = messages.filter(m => m.type !== 'reaction').map(m => m.id)
  const reactions = msgIds.length > 0
    ? db.prepare(
        `SELECT body, quoted_id, from_jid FROM messages WHERE type = 'reaction' AND quoted_id IN (${msgIds.map(() => '?').join(',')})`,
      ).all(...msgIds)
    : []

  const reactionMap = {}
  for (const r of reactions) {
    if (!reactionMap[r.quoted_id]) reactionMap[r.quoted_id] = []
    reactionMap[r.quoted_id].push({ emoji: r.body, from: r.from_jid })
  }

  const visible = messages.filter(m => m.type !== 'reaction')

  // An album is only a count; its photos arrive as separate messages that the
  // container does not reference. If those were never stored there is nothing
  // to link to and nothing to fetch, so say how many actually survived rather
  // than showing a bare "Album — 4 items" that looks like a loading failure.
  const albums = visible.filter(m => m.type === 'album')
  if (albums.length > 0) {
    const countChildren = db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE jid = ? AND media_key IS NOT NULL AND timestamp BETWEEN ? AND ?
    `)
    // The window is computed here, not in SQL: stored timestamps are ISO
    // strings ending in Z, which SQLite's datetime() does not parse — it
    // returns null and the comparison silently matches nothing.
    for (const album of albums) {
      try {
        const at = new Date(album.timestamp).getTime()
        album.children_available = countChildren.get(
          album.jid,
          new Date(at - 90_000).toISOString(),
          new Date(at + 90_000).toISOString(),
        ).c
      } catch (_) {
        album.children_available = null
      }
    }
  }

  // Attach the sender's name so callers do not each have to reimplement the
  // lid_map lookup to avoid showing a raw JID.
  const names = resolveNames(visible.map(m => m.from_jid))

  return visible.map(m => ({
    ...m,
    from_name: names.get(m.from_jid) || null,
    reactions: reactionMap[m.id] || [],
  }))
}

const MESSAGE_COLUMNS =
  'id, jid, from_jid, body, type, timestamp, is_from_me, media_mime, media_size, media_saved, quoted_id'

export default async function messageRoutes(fastify) {
  fastify.get('/channels/:jid/messages', {
    preHandler: requireScope('channels:read'),
  }, async (request) => {
    const requested = toJid(request.params.jid) || request.params.jid
    const { limit = 50, before, after, type } = request.query

    // A DM can be filed under the phone-number JID, the @lid one, or both.
    // Read across every JID that maps to the same conversation.
    const jids = expandJids(requested)

    let sql = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE jid IN (${jids.map(() => '?').join(',')})`
    const params = [...jids]

    if (before) {
      sql += ' AND timestamp < ?'
      params.push(before)
    }

    if (after) {
      sql += ' AND timestamp > ?'
      params.push(after)
    }

    if (type) {
      sql += ' AND type = ?'
      params.push(type)
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(Math.min(parseInt(limit, 10) || 50, 200))

    return withReactions(db.prepare(sql).all(...params))
  })

  // Full-text-ish search over stored message bodies. Scoped to one chat with
  // ?jid=, otherwise across everything the mirror has seen.
  fastify.get('/messages/search', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { q, jid, limit = 50, type } = request.query

    if (!q || !q.trim()) {
      return reply.code(400).send({ error: 'Query parameter "q" required', code: 'BAD_INPUT' })
    }

    let sql = `
      SELECT m.${MESSAGE_COLUMNS.split(', ').join(', m.')},
             cm.display_name AS channel_name
      FROM messages m
      LEFT JOIN channel_meta cm ON cm.jid = m.jid
      WHERE m.body LIKE ? AND m.type != 'reaction'
    `
    const params = [`%${q}%`]

    if (jid) {
      const jids = expandJids(toJid(jid) || jid)
      sql += ` AND m.jid IN (${jids.map(() => '?').join(',')})`
      params.push(...jids)
    }

    if (type) {
      sql += ' AND m.type = ?'
      params.push(type)
    }

    sql += ' ORDER BY m.timestamp DESC LIMIT ?'
    params.push(Math.min(parseInt(limit, 10) || 50, 200))

    return db.prepare(sql).all(...params).map(row => ({
      ...row,
      channel_type: channelType(row.jid),
    }))
  })

  // Stream media on demand — cached to disk
  fastify.get('/channels/:jid/messages/:id/media', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { id } = request.params
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    }

    if (!msg.media_key) {
      return reply.code(400).send({ error: 'Message has no media', code: 'NO_MEDIA' })
    }

    try {
      const { buffer } = await downloadMediaOnDemand(msg)
      const mime = msg.media_mime || 'application/octet-stream'
      const totalSize = buffer.length
      const range = request.headers.range

      reply.header('Accept-Ranges', 'bytes')
      reply.header('Content-Type', mime)
      reply.header('Content-Disposition', 'inline')
      reply.header('Cache-Control', 'public, max-age=86400')

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        // "bytes=-500" asks for the LAST 500 bytes. Reading parts[0] as 0 and
        // parts[1] as the end returns the wrong slice under a header that
        // claims it is the right one.
        const suffix = parts[0] === ''
        const start = suffix
          ? Math.max(0, totalSize - (parseInt(parts[1], 10) || 0))
          : parseInt(parts[0], 10) || 0
        const end = suffix || !parts[1]
          ? totalSize - 1
          : Math.min(parseInt(parts[1], 10), totalSize - 1)

        if (!Number.isFinite(start) || start >= totalSize || start > end) {
          reply.header('Content-Range', `bytes */${totalSize}`)
          return reply.code(416).send('Requested range not satisfiable')
        }

        const chunk = buffer.subarray(start, end + 1)
        reply.code(206)
        reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`)
        reply.header('Content-Length', chunk.length)
        return reply.send(chunk)
      }

      reply.header('Content-Length', totalSize)
      return reply.send(buffer)
    } catch (err) {
      // Say what actually went wrong. A blanket 500 gave the console nothing
      // to show and left the reason only in the server log.
      request.log.error({ err: err.message, cause: err.cause?.message, id }, 'media download failed')
      const status = err instanceof MediaUnavailableError ? (err.status ?? 502) : 502
      return reply.code(status).send({
        error: err.message || 'Failed to download media',
        code: 'MEDIA_DOWNLOAD_FAILED',
      })
    }
  })

  // Save media to disk explicitly
  fastify.post('/channels/:jid/messages/:id/media/save', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const { id } = request.params
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    }

    if (!msg.media_key) {
      return reply.code(400).send({ error: 'Message has no media', code: 'NO_MEDIA' })
    }

    if (msg.media_saved) {
      return { ok: true, path: msg.media_path }
    }

    try {
      const { savePath } = await downloadMediaOnDemand(msg, { saveToDisk: true })

      db.prepare(
        'UPDATE messages SET media_saved = 1, media_path = ? WHERE id = ?'
      ).run(savePath, id)

      return { ok: true, path: savePath }
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to save media', code: 'MEDIA_SAVE_FAILED' })
    }
  })
}
