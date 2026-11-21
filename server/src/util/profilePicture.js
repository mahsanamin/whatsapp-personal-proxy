// Profile pictures are fetched on demand and cached, including the answer
// "this contact has no picture we may see". Both last a day: pictures rarely
// change, and WhatsApp announces a change (contacts.update with imgUrl), which
// drops the cached row early. The day only bounds how stale a missed
// announcement can leave us. A transient failure gets a short retry window so
// a WhatsApp hiccup does not hide a picture for a whole day.
export const PICTURE_TTL_MS = 24 * 60 * 60 * 1000
export const PICTURE_ERROR_TTL_MS = 10 * 60 * 1000

// A preview is ~96px and a few KB. Anything far larger is not an avatar.
export const MAX_PICTURE_BYTES = 1024 * 1024

// WhatsApp answers a privacy-hidden or absent picture with an error node,
// which Baileys raises as a Boom carrying the node's code in `data`.
const NO_PICTURE_CODES = new Set([401, 403, 404])
const NO_PICTURE_TEXT = /not-authorized|item-not-found|forbidden|not-found/i

/** 'none' when WhatsApp says there is no picture we may see, else 'error'. */
export function classifyPictureError(err) {
  const code = Number(err?.data ?? err?.output?.statusCode)
  if (NO_PICTURE_CODES.has(code)) return 'none'
  if (NO_PICTURE_TEXT.test(String(err?.message || ''))) return 'none'
  return 'error'
}

/** Whether a cached row may be served without asking WhatsApp again. */
export function isPictureFresh(row, now = Date.now()) {
  if (!row || !Number.isFinite(row.fetched_at)) return false
  const ttl = row.status === 'error' ? PICTURE_ERROR_TTL_MS : PICTURE_TTL_MS
  return now - row.fetched_at < ttl
}

// The URL comes from WhatsApp, but it is still a URL the server will fetch.
// Restricting it to WhatsApp's own HTTPS hosts keeps a malformed or spoofed
// answer from turning this route into a way to make the server call elsewhere.
export function isAllowedPictureUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch (_) {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === 'whatsapp.net' || host.endsWith('.whatsapp.net')
}

// People (phone-number or device-linked) and groups have pictures. Anything
// else would only fill the cache with rows WhatsApp can never answer.
const PICTURE_JID = /^\d+(?:-\d+)?@(?:s\.whatsapp\.net|lid|g\.us)$/

export function isPictureJid(jid) {
  return typeof jid === 'string' && PICTURE_JID.test(jid)
}

// Raster formats only. The bytes are served from the console's own origin, so
// an SVG (which can carry script) or anything non-image must never be stored.
const PICTURE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** The normalised mime type if it is one we will store and serve, else null. */
export function pictureMime(contentType) {
  if (typeof contentType !== 'string') return null
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return PICTURE_MIMES.has(mime) ? mime : null
}

/**
 * Run at most `max` tasks at once; the rest wait in order. A chat list can ask
 * for many pictures together, and WhatsApp should see a trickle, not a burst.
 */
export function createLimiter(max) {
  let active = 0
  const queue = []

  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { task, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }

  const limit = (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    next()
  })
  limit.active = () => active
  limit.pending = () => queue.length
  return limit
}
