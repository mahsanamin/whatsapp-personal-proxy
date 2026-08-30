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
