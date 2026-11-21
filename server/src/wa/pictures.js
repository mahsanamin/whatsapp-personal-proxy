import { db } from '../db/index.js'
import { canonicalJid, expandJids } from '../db/lidmap.js'
import {
  MAX_PICTURE_BYTES,
  classifyPictureError,
  createLimiter,
  isAllowedPictureUrl,
  isPictureFresh,
  pictureMime,
} from '../util/profilePicture.js'

// WhatsApp rate-limits IQ queries per account. Four at a time keeps a chat
// list that scrolls past many avatars from looking like a scrape.
const limit = createLimiter(4)
const QUERY_TIMEOUT_MS = 10_000
const inflight = new Map()

const stmts = {
  get: db.prepare('SELECT jid, status, image, mime, fetched_at FROM profile_pictures WHERE jid = ?'),
  put: db.prepare(`
    INSERT INTO profile_pictures (jid, status, image, mime, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      status = excluded.status, image = excluded.image,
      mime = excluded.mime, fetched_at = excluded.fetched_at
  `),
  remove: db.prepare('DELETE FROM profile_pictures WHERE jid = ?'),
}

/** The cached row for a chat, fresh or not. */
export function cachedPicture(jid) {
  return stmts.get.get(canonicalJid(jid)) || null
}

/**
 * Return the picture row for a chat, asking WhatsApp only when the cache is
 * stale. With no socket the cached row (or null) is returned as it is, so a
 * picture fetched yesterday still shows while WhatsApp is reconnecting.
 */
export async function getProfilePicture(sock, jid) {
  const key = canonicalJid(jid)
  const cached = stmts.get.get(key) || null
  if (isPictureFresh(cached) || !sock) return cached

  // Two rows rendering the same avatar must not cost two queries.
  if (!inflight.has(key)) {
    inflight.set(key, refresh(sock, key, cached).finally(() => inflight.delete(key)))
  }
  return inflight.get(key)
}

/** Drop the cached picture so the next display asks WhatsApp again. */
export function forgetProfilePicture(jid) {
  if (typeof jid !== 'string' || !jid) return
  try {
    for (const alias of new Set([canonicalJid(jid), ...expandJids(jid)])) stmts.remove.run(alias)
  } catch (_) {
    // Invalidation runs inside event handlers; a failure here only means a
    // picture refreshes on its TTL instead of right away.
  }
}

async function refresh(sock, key, cached) {
  const result = await limit(() => fetchFirstAvailable(sock, key))
  const now = Date.now()

  // A transient failure keeps the old bytes, so the avatar does not vanish
  // during a WhatsApp hiccup, while 'error' schedules a retry soon.
  const row = result.status === 'error'
    ? { jid: key, status: 'error', image: cached?.image ?? null, mime: cached?.mime ?? null, fetched_at: now }
    : { jid: key, ...result, fetched_at: now }

  try {
    stmts.put.run(row.jid, row.status, row.image, row.mime, row.fetched_at)
  } catch (_) {}
  return row
}

// A chat keyed by @lid can have its picture answered only under the phone
// number, or the reverse, so try every address until one has a picture.
async function fetchFirstAvailable(sock, key) {
  const candidates = [key, ...expandJids(key).filter(alias => alias !== key)]
  let transient = false

  for (const jid of candidates) {
    let url
    try {
      url = await sock.profilePictureUrl(jid, 'preview', QUERY_TIMEOUT_MS)
    } catch (err) {
      if (classifyPictureError(err) === 'error') transient = true
      continue
    }
    if (!url) continue

    try {
      return { status: 'ok', ...(await download(url)) }
    } catch (_) {
      transient = true
    }
  }

  return transient
    ? { status: 'error', image: null, mime: null }
    : { status: 'none', image: null, mime: null }
}

async function download(url) {
  if (!isAllowedPictureUrl(url)) throw new Error('Picture URL is not a WhatsApp host')

  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Picture download failed: HTTP ${res.status}`)

  const mime = pictureMime(res.headers.get('content-type'))
  if (!mime) throw new Error('Picture response is not a supported image type')
  if (Number(res.headers.get('content-length')) > MAX_PICTURE_BYTES) throw new Error('Picture too large')

  // Count bytes as they arrive; content-length can be absent or wrong.
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_PICTURE_BYTES) throw new Error('Picture too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('Picture response was empty')
  return { image: Buffer.concat(chunks), mime }
}
