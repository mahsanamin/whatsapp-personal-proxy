import { db } from './index.js'

/**
 * Restore real send times from the stored payloads.
 *
 * messageTimestamp is a 64-bit protobuf value that arrives as a string (history
 * sync) or a Long (live), never a plain number. Ingestion tested for `number`
 * and fell back to Date.now(), so every message imported before that was fixed
 * carries the moment it was ingested instead of when it was sent — years of
 * history collapsed onto the instant the account was linked, in an order that
 * means nothing.
 *
 * The real value was written to raw_json all along, so the damage is
 * repairable in place without re-syncing. Idempotent: once corrected, rows stop
 * matching and nothing is rewritten.
 */
export function repairMessageTimestamps() {
  try {
    const result = db.prepare(`
      UPDATE messages
      SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ',
                               CAST(json_extract(raw_json, '$.messageTimestamp') AS INTEGER),
                               'unixepoch')
      WHERE json_extract(raw_json, '$.messageTimestamp') IS NOT NULL
        AND CAST(json_extract(raw_json, '$.messageTimestamp') AS INTEGER) > 0
        AND timestamp <> strftime('%Y-%m-%dT%H:%M:%fZ',
                                  CAST(json_extract(raw_json, '$.messageTimestamp') AS INTEGER),
                                  'unixepoch')
    `).run()
    return { repaired: result.changes }
  } catch (err) {
    return { repaired: 0, error: err.message }
  }
}

/**
 * Re-classify messages that ingestion could not read.
 *
 * Content nested inside an envelope — an album child, a disappearing message —
 * used to fall through to type 'unknown' with no media details, so albums were
 * invisible. The payload was stored regardless, so re-running the parser over
 * those rows recovers them in place: no re-sync, and the media becomes
 * downloadable because its key is finally extracted.
 */
export async function repairUnknownMessages() {
  let repaired = 0
  let stillUnknown = 0

  let normalizeMessage
  try {
    ({ normalizeMessage } = await import('../wa/client.js'))
  } catch (err) {
    return { repaired: 0, error: err.message }
  }

  // Albums are included, not just unknowns: a row converted by an earlier run
  // keeps whatever label that run produced, so a corrected description would
  // otherwise never reach the rows already migrated.
  const rows = db.prepare(
    "SELECT id, type, body, raw_json FROM messages WHERE type IN ('unknown', 'album') AND raw_json IS NOT NULL"
  ).all()
  if (rows.length === 0) return { repaired: 0, stillUnknown: 0 }

  const { BufferJSON } = await import('@whiskeysockets/baileys')
  const update = db.prepare(`
    UPDATE messages
    SET type = ?, body = ?, media_mime = ?, media_size = ?, media_sha256 = ?,
        media_key = ?, media_url = ?
    WHERE id = ?
  `)

  const apply = db.transaction((items) => {
    for (const { row, next } of items) {
      update.run(
        next.type, next.body, next.media_mime, next.media_size,
        next.media_sha256, next.media_key, next.media_url, row.id,
      )
    }
  })

  const pending = []
  for (const row of rows) {
    try {
      const next = normalizeMessage(JSON.parse(row.raw_json, BufferJSON.reviver))
      if (!next || next.type === 'unknown') { stillUnknown++; continue }
      if (next.type === row.type && next.body === row.body) continue
      pending.push({ row, next })
      repaired++
    } catch (_) {
      stillUnknown++
    }
  }

  if (pending.length > 0) apply(pending)
  return { repaired, stillUnknown }
}
