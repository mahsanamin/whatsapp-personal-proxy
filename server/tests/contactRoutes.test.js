import { test, after } from 'node:test'
import assert from 'node:assert/strict'

Object.assign(process.env, {
  PERSONAL_NUMBERS: '+15555550999', ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
})
const { db } = await import('../src/db/index.js')
const { default: channels } = await import('../src/api/channels.js')
const { default: whitelist } = await import('../src/api/whitelist.js')
const { backfillLidMap } = await import('../src/db/lidmap.js')
const routes = new Map()
const app = { requireSession() {}, get(path, options, handler) { routes.set('GET ' + path, handler) }, post(path, options, handler) { routes.set('POST ' + path, handler) }, patch() {}, delete() {} }
await channels(app)
await whitelist(app)
after(() => db.close())
const pn = '15555550101@s.whatsapp.net'
const lid = '15555550201@lid'

test('limited search merges aliases completely and consistently prefers the phone record', async () => {
  db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(lid, pn)
  db.prepare('INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)').run(pn, 'Saved Friend')
  db.prepare('INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)').run(lid, 'Owner')
  for (const [id, jid] of [['1', pn], ['2', lid]]) db.prepare('INSERT INTO messages (id, jid, timestamp, body) VALUES (?, ?, ?, ?)').run(id, jid, id, 'test')
  for (const search of ['Saved Friend', '+1 (555) 555-0101']) {
    const result = await routes.get('GET /channels')({ query: { search, limit: '1' } })
    assert.equal(result.length, 1)
    assert.equal(result[0].jid, pn)
    assert.equal(result[0].display_name, 'Saved Friend')
    assert.equal(result[0].unread_count, 2)
    assert.deepEqual(result[0].alt_jids, [lid])
  }
})

test('whitelist normalizes formatted numbers and rejects invalid destinations', async () => {
  let status
  const reply = { code(value) { status = value; return this }, send(body) { return body } }
  const add = routes.get('POST /whitelist')
  const entry = await add({ body: { jid: '+1 (555) 555-0101' } }, reply)
  assert.equal(entry.jid, pn)
  for (const jid of ['bad@host', '   ', {}, '15555550101@newsletter']) {
    const result = await add({ body: { jid } }, reply)
    assert.equal(status, 400)
    assert.equal(result.code, 'BAD_INPUT')
  }
})

test('backfill never links an outgoing recipient to the owner sender number', () => {
  const recipient = '15555550401@lid'
  const owner = '15555550501@s.whatsapp.net'
  db.prepare('INSERT INTO messages (id, jid, timestamp, raw_json) VALUES (?, ?, ?, ?)').run('out', recipient, '3', JSON.stringify({ key: { remoteJid: recipient, senderPn: owner, fromMe: true } }))
  backfillLidMap()
  assert.equal(db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(recipient), undefined)
})
