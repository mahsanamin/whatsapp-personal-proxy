import { incomingContact } from '../util/contactIdentity.js'

// Higher-confidence names survive later profile-name and history events.
export function saveContactName(db, jid, name, rank = 1) {
  if (typeof jid !== 'string' || typeof name !== 'string' || !name.trim()) return
  jid = jid.replace(/:\d+@/, '@')
  const aliases = new Set([jid])
  for (const row of db.prepare('SELECT lid, pn FROM lid_map WHERE lid = ? OR pn = ?').all(jid, jid)) {
    aliases.add(row.lid)
    aliases.add(row.pn)
  }
  const upsert = db.prepare(`
    INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET display_name = excluded.display_name, name_rank = excluded.name_rank
    WHERE channel_meta.display_name IS NULL OR excluded.name_rank >= channel_meta.name_rank
  `)
  for (const alias of aliases) upsert.run(alias, name.trim(), rank)
}

// Keep the previous value locally, so repairs remain reversible.
export function repairContactNames(db) {
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS completed_repairs (
      name TEXT PRIMARY KEY, completed_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    if (db.prepare('SELECT name FROM completed_repairs WHERE name = ?').get('contact-names-v1')) return 0
    db.exec(`CREATE TABLE IF NOT EXISTS contact_name_repairs (
      jid TEXT PRIMARY KEY, old_name TEXT, repaired_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    const suspects = new Map()
    const incoming = []
    for (const row of db.prepare('SELECT raw_json FROM messages WHERE raw_json IS NOT NULL ORDER BY timestamp, id').iterate()) {
      let raw
      try { raw = JSON.parse(row.raw_json) } catch (_) { continue }
      if (raw.key?.fromMe && typeof raw.pushName === 'string' && typeof raw.key.remoteJid === 'string') {
        const jid = raw.key.remoteJid
        const aliases = new Set([jid])
        for (const pair of db.prepare('SELECT lid, pn FROM lid_map WHERE lid = ? OR pn = ?').all(jid, jid)) {
          aliases.add(pair.lid)
          aliases.add(pair.pn)
        }
        for (const alias of aliases) {
          if (!suspects.has(alias)) suspects.set(alias, new Set())
          suspects.get(alias).add(raw.pushName.trim())
        }
      }
      const contact = incomingContact(raw)
      if (contact) incoming.push(contact)
    }
    let repaired = 0
    for (const row of db.prepare('SELECT jid, display_name FROM channel_meta WHERE name_rank = 0').all()) {
      if (!suspects.get(row.jid)?.has(row.display_name) || !/@(lid|s\.whatsapp\.net)$/.test(row.jid)) continue
      db.prepare('INSERT OR IGNORE INTO contact_name_repairs (jid, old_name) VALUES (?, ?)').run(row.jid, row.display_name)
      db.prepare('UPDATE channel_meta SET display_name = NULL, name_rank = 1 WHERE jid = ?').run(row.jid)
      repaired++
    }
    for (const contact of incoming) {
      const aliases = [contact.jid]
      for (const pair of db.prepare('SELECT lid, pn FROM lid_map WHERE lid = ? OR pn = ?').all(contact.jid, contact.jid)) aliases.push(pair.lid, pair.pn)
      for (const jid of new Set(aliases)) {
        db.prepare(`UPDATE channel_meta SET display_name = ?, name_rank = 1
          WHERE jid = ? AND (display_name IS NULL OR
            (name_rank <= 1 AND EXISTS (SELECT 1 FROM contact_name_repairs WHERE jid = channel_meta.jid)))`).run(contact.name, jid)
      }
    }
    // Unproven legacy names may be address-book names: preserve them until a
    // fresh contact or chat event supplies stronger evidence.
    db.prepare('UPDATE channel_meta SET name_rank = 2 WHERE name_rank = 0 AND display_name IS NOT NULL').run()
    db.prepare('INSERT INTO completed_repairs (name) VALUES (?)').run('contact-names-v1')
    return repaired
  })()
}
