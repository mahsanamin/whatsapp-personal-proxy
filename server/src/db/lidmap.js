import { db } from './index.js'
import { PN_SUFFIX, LID_SUFFIX } from '../util/jid.js'

/**
 * WhatsApp multi-device addresses the same person by two JIDs: a phone-number
 * JID (@s.whatsapp.net) and a device-linked one (@lid). Messages land under
 * whichever the sender used, so reading "the DM with +971..." has to look under
 * both. lid_map is the cross-reference; this expands one JID into every JID
 * that refers to the same conversation.
 */
export function expandJids(jid) {
  if (typeof jid !== 'string' || !jid) return []
  const out = new Set([jid])

  try {
    if (jid.endsWith(LID_SUFFIX)) {
      const row = db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(jid)
      if (row?.pn) out.add(row.pn)
    } else if (jid.endsWith(PN_SUFFIX)) {
      for (const row of db.prepare('SELECT lid FROM lid_map WHERE pn = ?').all(jid)) {
        if (row?.lid) out.add(row.lid)
      }
    }
  } catch (_) {
    // lid_map is a lookup aid; a failure here must not break a read
  }

  return [...out]
}

/**
 * The address a conversation should be filed under. The phone-number JID wins:
 * it is stable, human-readable, and the one a person can actually type.
 */
export function canonicalJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith(LID_SUFFIX)) return jid
  try {
    const row = db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(jid)
    return row?.pn || jid
  } catch (_) {
    return jid
  }
}

/** canonicalJid for many rows at once, without a query per row. */
export function canonicalJidMap(jids) {
  const lids = jids.filter(j => typeof j === 'string' && j.endsWith(LID_SUFFIX))
  const map = new Map()
  if (lids.length === 0) return map
  try {
    const rows = db.prepare(
      `SELECT lid, pn FROM lid_map WHERE lid IN (${lids.map(() => '?').join(',')})`
    ).all(...lids)
    for (const row of rows) {
      if (row.pn) map.set(row.lid, row.pn)
    }
  } catch (_) {}
  return map
}

/**
 * Rebuild lid_map from message keys already on disk, and propagate contact
 * names across every pair it learns.
 *
 * Needed because the ingest path originally read key fields that this Baileys
 * version does not emit, so history synced before that fix has the mapping
 * sitting unused inside raw_json. Cheap and idempotent: safe on every connect.
 */
export function backfillLidMap() {
  let mappings = 0
  let names = 0

  const upsert = db.prepare(`
    INSERT INTO lid_map (lid, pn) VALUES (?, ?)
    ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = datetime('now')
  `)

  // Both shapes a key can carry: a direct chat (senderPn/senderLid) and a
  // group participant (participantPn/participantLid).
  const pairs = db.prepare(`
    SELECT DISTINCT lid, pn FROM (
      SELECT json_extract(raw_json, '$.key.remoteJid')      AS lid,
             json_extract(raw_json, '$.key.senderPn')       AS pn FROM messages
      UNION
      SELECT json_extract(raw_json, '$.key.senderLid')      AS lid,
             json_extract(raw_json, '$.key.senderPn')       AS pn FROM messages
      UNION
      SELECT json_extract(raw_json, '$.key.participant')    AS lid,
             json_extract(raw_json, '$.key.participantPn')  AS pn FROM messages
      UNION
      SELECT json_extract(raw_json, '$.key.participantLid') AS lid,
             json_extract(raw_json, '$.key.participantPn')  AS pn FROM messages
    )
    WHERE lid LIKE '%@lid' AND pn LIKE '%@s.whatsapp.net'
  `).all()

  const apply = db.transaction((rows) => {
    for (const { lid, pn } of rows) {
      upsert.run(lid, pn)
      mappings++
    }
  })

  try {
    apply(pairs)
  } catch (_) {
    return { mappings: 0, names: 0 }
  }

  // A name learned on either address belongs to both.
  try {
    names += db.prepare(`
      UPDATE channel_meta SET display_name = (
        SELECT c.display_name FROM lid_map m
        JOIN channel_meta c ON c.jid = m.lid
        WHERE m.pn = channel_meta.jid AND c.display_name IS NOT NULL
      )
      WHERE display_name IS NULL
        AND EXISTS (
          SELECT 1 FROM lid_map m JOIN channel_meta c ON c.jid = m.lid
          WHERE m.pn = channel_meta.jid AND c.display_name IS NOT NULL
        )
    `).run().changes

    names += db.prepare(`
      UPDATE channel_meta SET display_name = (
        SELECT c.display_name FROM lid_map m
        JOIN channel_meta c ON c.jid = m.pn
        WHERE m.lid = channel_meta.jid AND c.display_name IS NOT NULL
      )
      WHERE display_name IS NULL
        AND EXISTS (
          SELECT 1 FROM lid_map m JOIN channel_meta c ON c.jid = m.pn
          WHERE m.lid = channel_meta.jid AND c.display_name IS NOT NULL
        )
    `).run().changes
  } catch (_) {}

  return { mappings, names }
}
