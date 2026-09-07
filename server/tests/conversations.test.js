import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import crypto from 'node:crypto'

Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3),
  PERSONAL_NUMBERS: '+15555550999', DB_PATH: ':memory:',
})
const { db } = await import('../src/db/index.js')
const { default: channels } = await import('../src/api/channels.js')
const { default: brief } = await import('../src/api/brief.js')
const { applyUnreadUpdate } = await import('../src/db/unread.js')
const { default: tabs } = await import('../src/api/tabs.js')
const { default: whitelist } = await import('../src/api/whitelist.js')
const { expandJids } = await import('../src/db/lidmap.js')
const { checkSendPermission } = await import('../src/util/sendPermission.js')
const app = Fastify()
app.decorate('eventBus', { emit() {} })
app.decorate('requireSession', async (request, reply) => {
  if (!request.session?.authenticated) return reply.code(401).send({ error: 'Unauthorized' })
})
app.addHook('onRequest', async request => {
  if (request.headers['x-test-console'] === 'yes') request.session = { authenticated: true }
})
await app.register(channels)
await app.register(whitelist)
await app.register(tabs)
await app.register(brief)
const consoleHeaders = { 'x-test-console': 'yes' }
const pn = '15555550101@s.whatsapp.net'
const lid = '15555550201@lid'
const sibling = '15555550202@lid'
const unrelated = '15555550301@s.whatsapp.net'
const url = jid => '/channels/' + encodeURIComponent(jid)

beforeEach(() => {
  for (const table of ['unread_counter_events', 'conversation_unread', 'unread_messages', 'messages', 'channel_meta', 'lid_map', 'whitelist', 'tabs', 'tokens']) db.prepare(`DELETE FROM ${table}`).run()
  for (const alias of [lid, sibling]) db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(alias, pn)
  db.prepare('INSERT INTO channel_meta (jid, display_name) VALUES (?, ?)').run(lid, 'Friend')
})
after(async () => { await app.close(); db.close() })

test('expanding any address finds every sibling without confusing equal numeric IDs', () => {
  assert.deepEqual(new Set(expandJids(lid)), new Set([pn, lid, sibling]))
  assert.deepEqual(expandJids('15555550101@lid'), ['15555550101@lid'])
})

test('chat detail works before a phone-number metadata row exists and includes all history', async () => {
  db.prepare('INSERT INTO messages (id, jid, timestamp, body) VALUES (?, ?, ?, ?)').run('latest', sibling, '2026-01-02T00:00:00.000Z', 'Latest text')
  const response = await app.inject({ url: url(pn), headers: consoleHeaders })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().jid, pn)
  assert.equal(response.json().display_name, 'Friend')
  assert.equal(response.json().last_message.body, 'Latest text')
})

test('archive, rename and tab changes apply atomically to the whole conversation', async () => {
  db.prepare('INSERT INTO tabs (id, name, position) VALUES (?, ?, ?)').run('friends', 'Friends', 0)
  const response = await app.inject({ method: 'PATCH', url: url(pn), headers: consoleHeaders,
    payload: { is_archived: true, is_muted: true, display_name: 'My Friend', tab_id: 'friends' } })
  assert.equal(response.statusCode, 200)
  for (const jid of [pn, lid, sibling]) {
    const row = db.prepare('SELECT * FROM channel_meta WHERE jid = ?').get(jid)
    assert.equal(row.display_name, 'My Friend')
    assert.equal(row.is_archived, 1)
    assert.equal(row.is_muted, 1)
    assert.equal(row.tab_id, 'friends')
  }
  const listed = await app.inject({ url: '/channels?archived=true&tab=friends', headers: consoleHeaders })
  assert.equal(listed.json().length, 1)
  const tabs = await app.inject({ url: '/tabs', headers: consoleHeaders })
  assert.equal(tabs.json()[0].channel_count, 1)
})

test('bad metadata and unknown tabs are rejected without partial updates', async () => {
  for (const payload of [{ is_muted: {} }, { display_name: [] }, { notes: {} }, { tab_id: 'missing', display_name: 'Wrong' }]) {
    const response = await app.inject({ method: 'PATCH', url: url(lid), headers: consoleHeaders, payload })
    assert.equal(response.statusCode, 400)
    assert.equal(db.prepare('SELECT display_name FROM channel_meta WHERE jid = ?').get(lid).display_name, 'Friend')
  }
})

test('stale read requests do not resurrect unread messages and timestamps are validated', async () => {
  db.prepare('INSERT INTO messages (id, jid, timestamp) VALUES (?, ?, ?)').run('m', sibling, '2026-01-02T00:00:00.000Z')
  for (const up_to of ['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z']) {
    const response = await app.inject({ method: 'POST', url: url(lid) + '/read', headers: consoleHeaders, payload: { up_to } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().unread_count, 0)
    assert.equal(response.json().read_up_to, '2026-01-03T00:00:00.000Z')
  }
  const bad = await app.inject({ method: 'POST', url: url(lid) + '/read', headers: consoleHeaders, payload: { up_to: 'not a timestamp' } })
  assert.equal(bad.statusCode, 400)
})

test('allowing one address covers its verified aliases, with duplicate and scope protection', async () => {
  const response = await app.inject({ method: 'POST', url: '/whitelist', headers: consoleHeaders, payload: { jid: lid, label: 'Friend' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().jid, pn)
  const caller = { token: { scopes: ['others:send'] } }
  for (const jid of [pn, lid, sibling]) assert.equal(checkSendPermission(caller, jid), null)
  assert.equal(checkSendPermission(caller, unrelated).code, 'NOT_WHITELISTED')
  assert.equal(checkSendPermission({ token: { scopes: [] } }, lid).code, 'MISSING_SCOPE')
  const duplicate = await app.inject({ method: 'POST', url: '/whitelist', headers: consoleHeaders, payload: { jid: sibling } })
  assert.equal(duplicate.statusCode, 409)
  db.prepare('DELETE FROM whitelist').run()
  assert.equal(checkSendPermission(caller, lid).code, 'NOT_WHITELISTED')
})

test('read-only tokens cannot modify the allow list or channel metadata', async () => {
  const token = 'test-scoped-token'
  db.prepare('INSERT INTO tokens (id, name, token_hash, scopes) VALUES (?, ?, ?, ?)').run('t', 'Test', crypto.createHash('sha256').update(token).digest('hex'), JSON.stringify(['channels:read']))
  const headers = { authorization: 'Bearer ' + token }
  assert.equal((await app.inject({ method: 'POST', url: '/whitelist', headers, payload: { jid: pn } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'PATCH', url: url(lid), headers, payload: { display_name: 'Wrong' } })).statusCode, 401)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whitelist').get().n, 0)
})

test('legacy LID allow-list entries still permit the phone address and block duplicates', async () => {
  db.prepare('INSERT INTO whitelist (id, jid) VALUES (?, ?)').run('legacy', lid)
  assert.equal(checkSendPermission({ token: { scopes: ['others:send'] } }, pn), null)
  const response = await app.inject({ method: 'POST', url: '/whitelist', headers: consoleHeaders, payload: { jid: pn } })
  assert.equal(response.statusCode, 409)
})

test('invalid allow-list labels return a client error', async () => {
  const response = await app.inject({ method: 'POST', url: '/whitelist', headers: consoleHeaders, payload: { jid: pn, label: {} } })
  assert.equal(response.statusCode, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whitelist').get().n, 0)
})

test('sidebar and brief do not turn unsynced history into unread counts', async () => {
  db.prepare('INSERT INTO messages (id, jid, timestamp, body) VALUES (?, ?, ?, ?)').run('archive', lid, '2020-01-01T00:00:00.000Z', 'Old history')
  const channels = await app.inject({ url: '/channels', headers: consoleHeaders })
  assert.equal(channels.json()[0].unread_count, null)
  const unknown = await app.inject({ url: '/brief', headers: consoleHeaders })
  assert.equal(unknown.json().chats.length, 0)
  applyUnreadUpdate(db, [pn, lid], { unreadCount: 3 }, 'history')
  const known = await app.inject({ url: '/brief', headers: consoleHeaders })
  assert.equal(known.json().chats[0].unread_count, 3)
})
