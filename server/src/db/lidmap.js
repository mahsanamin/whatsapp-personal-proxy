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
