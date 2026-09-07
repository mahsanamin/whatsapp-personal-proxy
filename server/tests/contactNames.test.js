import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../src/db/migrations.js'
import { incomingContact } from '../src/util/contactIdentity.js'
import { saveContactName, repairContactNames } from '../src/db/contactNames.js'

const pn = '15555550101@s.whatsapp.net'
const lid = '15555550201@lid'
function database() {
  const db = new Database(':memory:')
  runMigrations(db)
  db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(lid, pn)
  return db
}

test('outgoing push names never name recipients in DMs or groups', () => {
  for (const remoteJid of [pn, lid, '15555550301@g.us']) {
    assert.equal(incomingContact({ key: { remoteJid, fromMe: true, participant: pn }, pushName: 'Owner' }), null)
  }
})

test('incoming names belong only to the sender; channels are not contacts', () => {
  assert.deepEqual(incomingContact({ key: { remoteJid: pn }, pushName: 'Friend' }), { jid: pn, name: 'Friend' })
  assert.deepEqual(incomingContact({ key: { remoteJid: '15555550301@g.us', participant: lid }, pushName: 'Friend' }), { jid: lid, name: 'Friend' })
  assert.equal(incomingContact({ key: { remoteJid: '15555550301@newsletter' }, pushName: 'News' }), null)
})

test('address book names beat profile names across aliases and manual names survive', () => {
  const db = database()
  try {
    saveContactName(db, pn, 'Saved Friend', 3)
    saveContactName(db, lid, 'Profile Friend', 1)
    assert.deepEqual(db.prepare('SELECT display_name FROM channel_meta').all().map(r => r.display_name), ['Saved Friend', 'Saved Friend'])
    saveContactName(db, pn, 'Custom', 4)
    saveContactName(db, lid, 'Saved Again', 3)
    assert.equal(db.prepare('SELECT display_name FROM channel_meta WHERE jid = ?').get(pn).display_name, 'Custom')
  } finally { db.close() }
})

test('repair restores incoming names, preserves unrelated names, and retains old values', () => {
  const db = database()
  try {
    db.prepare('INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)').run(lid, 'Owner')
    db.prepare('INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)').run(pn, 'Address Book Friend')
    for (const [id, fromMe, pushName] of [['1', false, 'Friend'], ['2', true, 'Owner']]) {
      db.prepare('INSERT INTO messages (id, jid, timestamp, raw_json) VALUES (?, ?, ?, ?)').run(id, lid, id, JSON.stringify({ key: { remoteJid: lid, fromMe }, pushName }))
    }
    assert.equal(repairContactNames(db), 1)
    assert.equal(db.prepare('SELECT display_name FROM channel_meta WHERE jid = ?').get(lid).display_name, 'Friend')
    assert.equal(db.prepare('SELECT display_name FROM channel_meta WHERE jid = ?').get(pn).display_name, 'Address Book Friend')
    assert.equal(db.prepare('SELECT old_name FROM contact_name_repairs WHERE jid = ?').get(lid).old_name, 'Owner')
    assert.equal(repairContactNames(db), 0)
  } finally { db.close() }
})
