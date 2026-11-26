import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
  // Never reach a real model gateway from the suite.
  LLM_GATEWAY_URL: '', LLM_GATEWAY_API_KEY: '',
})
const { db } = await import('../src/db/index.js')
const store = await import('../src/db/autoreply.js')
const { validateRuleSet, decide } = await import('../src/util/autoreply.js')
const { default: autoreplyRoutes } = await import('../src/api/autoreply.js')

const routes = new Map()
const register = (method) => (path, options, handler) => routes.set(`${method} ${path}`, handler)
await autoreplyRoutes({ get: register('GET'), post: register('POST'), put: register('PUT'), patch: register('PATCH'), delete: register('DELETE') })
after(() => db.close())

const PN = '15555550101@s.whatsapp.net'
const LID = '15555550201@lid'
const GROUP = '120363000000000001@g.us'
const MEMBER_A = '15555550111@s.whatsapp.net'
const MEMBER_B = '15555550112@s.whatsapp.net'
const NOW = Date.parse('2026-11-21T04:00:00Z')
const LIMITS = { minGapSeconds: 60, maxPerChatPerHour: 3, maxPerChatPerDay: 10, maxPerHour: 30 }

const TEMPLATE = {
  format: 1,
  name: 'Store test',
  version: '1',
  scope: { allowlist: true, chats: [GROUP] },
  rules: [{ id: 'price', match: { keywords: ['price'] }, response: { type: 'text', text: 'Prices' } }],
}
const ruleSet = validateRuleSet(TEMPLATE).ruleSet

function reply() {
  return {
    status: 200,
    body: null,
    code(value) { this.status = value; return this },
    send(body) { this.body = body; return body },
    header() { return this },
    type() { return this },
  }
}
const session = { session: { authenticated: true } }
const token = { session: {}, token: { scopes: ['autoreply:manage'] } }

beforeEach(() => {
  for (const table of ['autoreply_rulesets', 'autoreply_decisions', 'autoreply_contacts', 'autoreply_processed', 'messages', 'lid_map', 'whitelist']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(LID, PN)
})

function addIncoming(id, jid, from, atMs) {
  db.prepare('INSERT INTO messages (id, jid, from_jid, timestamp, is_from_me, body) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, jid, from, new Date(atMs).toISOString(), 'x')
}

test('a contact is one person across its LID and phone-number addresses', () => {
  store.saveContact(LID, { muted_until: NOW + 60_000, mute_reason: 'loop' }, NOW)
  store.logDecision({ at: NOW - 1000, chat_jid: LID, ruleset_id: 'r', rule_id: 'price', action: 'sent' })
  store.logDecision({ at: NOW - 2000, chat_jid: PN, ruleset_id: 'r', rule_id: 'price', action: 'sent' })

  const snapshot = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'price', action: 'sent', nowMs: NOW })
  assert.equal(snapshot.contactKey, PN)
  assert.equal(snapshot.stats.contactMute.reason, 'loop', 'a mute saved under the LID applies to the phone number')
  assert.equal(snapshot.stats.contactRepliesLastHour, 2, 'replies under both addresses count together')
})

test('dry runs and real sends are counted apart', () => {
  store.logDecision({ at: NOW - 1000, chat_jid: PN, ruleset_id: 'r', rule_id: 'price', action: 'dry_run' })
  const sent = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'sent', nowMs: NOW })
  assert.equal(sent.stats.contactRepliesLastHour, 0)
  const dry = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'dry_run', nowMs: NOW })
  assert.equal(dry.stats.contactRepliesLastHour, 1)
})

test('in a group, flood is counted per sender and mutes only that sender', () => {
  for (let i = 0; i < 9; i++) addIncoming(`a${i}`, GROUP, MEMBER_A, NOW - i * 1000)
  for (let i = 0; i < 3; i++) addIncoming(`b${i}`, GROUP, MEMBER_B, NOW - i * 1000)

  const a = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: GROUP, senderJid: MEMBER_A, text: 'price', action: 'sent', nowMs: NOW })
  const b = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: GROUP, senderJid: MEMBER_B, text: 'price', action: 'sent', nowMs: NOW })
  assert.equal(a.stats.floodCount, 9)
  assert.equal(b.stats.floodCount, 3, 'a busy group is not a flood by anyone in particular')

  const decision = decide({ ruleSet, message: { type: 'text', text: 'price', chatAliases: [GROUP] }, nowMs: NOW, stats: a.stats, limits: LIMITS })
  assert.equal(decision.action, 'mute')
  assert.equal(decision.mute.target, 'sender')
  store.saveContact(a.floodKey, { muted_until: NOW + 60_000, mute_reason: 'flood' }, NOW)

  const later = NOW + 1000
  const aAgain = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: GROUP, senderJid: MEMBER_A, text: 'price', action: 'sent', nowMs: later })
  const bAgain = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: GROUP, senderJid: MEMBER_B, text: 'price', action: 'sent', nowMs: later })
  assert.equal(aAgain.stats.senderMute.reason, 'flood')
  assert.equal(bAgain.stats.senderMute.until, null)
  assert.equal(bAgain.stats.contactMute.until, null, 'the group itself is not muted')
})

test('a manual reply resets the conversation count', () => {
  store.saveContact(PN, { last_incoming_at: NOW - 60_000, conversation_started_at: NOW - 10 * 60_000 }, NOW)
  for (let i = 1; i <= 3; i++) store.logDecision({ at: NOW - i * 60_000, chat_jid: PN, ruleset_id: 'r', rule_id: 'price', action: 'sent' })
  const before = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'sent', nowMs: NOW })
  assert.equal(before.stats.conversationReplies, 3)

  store.recordManualReply(PN, NOW - 30_000)
  const after = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'sent', nowMs: NOW })
  assert.equal(after.stats.conversationReplies, 0)
  assert.equal(after.stats.lastManualReplyAt, NOW - 30_000)
})

test('the same text is recognised again within the conversation', () => {
  store.saveContact(PN, { last_incoming_at: NOW - 60_000, conversation_started_at: NOW - 10 * 60_000 }, NOW)
  const first = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'Price?', action: 'sent', nowMs: NOW })
  store.logDecision({ at: NOW - 60_000, chat_jid: PN, ruleset_id: 'r', rule_id: 'price', action: 'sent', text_hash: first.textHash })
  const again = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'price', action: 'sent', nowMs: NOW })
  assert.deepEqual(again.stats.sameTextRuleIds, ['price'])
})

test('a message id is claimed once', () => {
  assert.equal(store.claimMessage('m1', NOW), true)
  assert.equal(store.claimMessage('m1', NOW), false)
})

test('a new rule set starts inactive in dry-run, and an invalid one is refused', async () => {
  const r = reply()
  const created = await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: TEMPLATE } }, r)
  assert.equal(r.status, 201)
  assert.equal(created.mode, 'dry_run')
  assert.equal(created.active, false)

  const bad = reply()
  await routes.get('POST /autoreply/rulesets')({ ...session, body: { template: { ...TEMPLATE, rules: [{ id: 'x', match: { keywords: ['a'] }, response: { type: 'llm' } }] } } }, bad)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BAD_INPUT')
  assert.match(bad.body.error, /model: Required/)
})

test('only the console can put a rule set live, and an edit takes it back to dry-run', async () => {
  const created = await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: JSON.stringify(TEMPLATE) } }, reply())
  const patch = routes.get('PATCH /autoreply/rulesets/:id')

  const refused = reply()
  await patch({ ...token, params: { id: created.id }, body: { mode: 'live', active: true } }, refused)
  assert.equal(refused.status, 403)
  assert.equal(store.getRuleSet(created.id).mode, 'dry_run')

  const live = await patch({ ...session, params: { id: created.id }, body: { mode: 'live', active: true } }, reply())
  assert.equal(live.mode, 'live')
  assert.equal(live.active, true)

  const edited = await routes.get('PUT /autoreply/rulesets/:id')({ ...token, params: { id: created.id }, body: { template: TEMPLATE } }, reply())
  assert.equal(edited.mode, 'dry_run')
})

test('activating one rule set deactivates the others', async () => {
  const one = await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: TEMPLATE } }, reply())
  const two = await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: { ...TEMPLATE, name: 'Two' } } }, reply())
  const patch = routes.get('PATCH /autoreply/rulesets/:id')
  await patch({ ...token, params: { id: one.id }, body: { active: true } }, reply())
  await patch({ ...token, params: { id: two.id }, body: { active: true } }, reply())
  assert.equal(store.getRuleSet(one.id).active, false)
  assert.equal(store.getRuleSet(two.id).active, true)
})

test('the test endpoint reports the match and logs nothing', async () => {
  db.prepare('INSERT INTO whitelist (id, jid) VALUES (?, ?)').run('w1', PN)
  const result = await routes.get('POST /autoreply/test')({ ...token, body: { template: TEMPLATE, chat: LID, text: 'what is the price' } }, reply())
  assert.equal(result.in_scope, true, 'the allow-list entry for the phone number covers the LID')
  assert.equal(result.match.rule_id, 'price')
  assert.equal(result.decision.action, 'would_send')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM autoreply_decisions').get().c, 0)

  const outside = await routes.get('POST /autoreply/test')({ ...token, body: { template: TEMPLATE, chat: '15555550199', text: 'price' } }, reply())
  assert.equal(outside.in_scope, false)
  assert.equal(outside.decision.reason, 'out_of_scope')
})

test('mute and unmute a contact by either address', async () => {
  await routes.get('POST /autoreply/contacts/:jid/mute')({ ...token, params: { jid: LID }, body: { minutes: 60 } }, reply())
  const snapshot = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'sent', nowMs: Date.now() })
  assert.equal(snapshot.stats.contactMute.reason, 'manual')

  await routes.get('DELETE /autoreply/contacts/:jid/mute')({ ...session, params: { jid: PN } }, reply())
  const cleared = store.contactSnapshot({ ruleSet, rulesetId: 'r', chatJid: PN, senderJid: PN, text: 'x', action: 'sent', nowMs: Date.now() })
  assert.equal(cleared.stats.contactMute.until, null)
})

test('contact counts include decisions logged under either address', () => {
  store.saveContact(PN, { last_incoming_at: NOW, conversation_started_at: NOW - 60_000 }, NOW)
  store.logDecision({ at: NOW - 1000, chat_jid: LID, ruleset_id: 'r', rule_id: 'price', action: 'sent' })
  const row = store.listContacts(NOW).find(c => c.contact_key === PN)
  assert.equal(row.sent_24h, 1)
  assert.equal(row.conversation_replies, 1)
})

test('the kill switch is off until turned on', () => {
  assert.equal(store.isEnabled(), false)
  store.setEnabled(true)
  assert.equal(store.isEnabled(), true)
  store.setEnabled(false)
})

// ─── Decrypt failures ────────────────────────────────────────────────

test('a failed decryption is remembered for its resend, a normal id is not', () => {
  store.recordDecryptFailure('3EB0DECRYPT0001', LID, NOW)
  store.recordDecryptFailure('3EB0DECRYPT0001', LID, NOW + 1000) // the second failure of the same id
  assert.equal(store.wasDecryptFailure('3EB0DECRYPT0001'), true)
  assert.equal(store.wasDecryptFailure('3EB0NORMAL00001'), false)
  const row = db.prepare('SELECT * FROM decrypt_failures WHERE message_id = ?').get('3EB0DECRYPT0001')
  assert.equal(row.failed_at, NOW, 'the first failure is kept')
})

test('decrypt failures are forgotten after 30 days', () => {
  store.recordDecryptFailure('3EB0OLDFAILURE1', LID, NOW - 31 * 24 * 3600_000)
  store.recordDecryptFailure('3EB0NEWFAILURE1', LID, NOW - 29 * 24 * 3600_000)
  store.pruneDecryptFailures(NOW)
  assert.equal(store.wasDecryptFailure('3EB0OLDFAILURE1'), false)
  assert.equal(store.wasDecryptFailure('3EB0NEWFAILURE1'), true)
})

test('a decrypt failure survives a restart', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'wpp-decrypt-'))
  const storeUrl = new URL('../src/db/autoreply.js', import.meta.url).href
  const run = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const store = await import(${JSON.stringify(storeUrl)})
    ${code}
  `], { env: { ...process.env, DB_PATH: join(dir, 'wpp.db') }, encoding: 'utf8' }).trim()
  try {
    run(`store.recordDecryptFailure('3EB0RESTART0001', '15555550201@lid', Date.now())`)
    assert.equal(run(`console.log(store.wasDecryptFailure('3EB0RESTART0001'))`), 'true')
    assert.equal(run(`console.log(store.wasDecryptFailure('3EB0RESTART0002'))`), 'false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only an address-book name makes a sender saved, on either address', async () => {
  const { savedContactName } = await import('../src/db/lidmap.js')
  db.prepare('DELETE FROM channel_meta').run()
  db.prepare('INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)').run(LID, 'Profile Name', 1)
  assert.equal(savedContactName(PN), null, 'a profile name is not an address-book entry')
  db.prepare('INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)').run(PN, 'Sam (work)', 3)
  assert.equal(savedContactName(PN), 'Sam (work)')
  assert.equal(savedContactName(LID), 'Sam (work)', 'found through the LID too')
  assert.equal(savedContactName(GROUP), null)
})

test('recent messages come oldest first, with the owner and the auto-replies told apart', () => {
  const add = (id, fromMe, at, body) => db.prepare('INSERT INTO messages (id, jid, from_jid, timestamp, is_from_me, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, fromMe ? PN : LID, fromMe ? null : LID, new Date(at).toISOString(), fromMe ? 1 : 0, body)
  add('m1', false, NOW - 4000, 'first')
  add('m2', true, NOW - 3000, 'typed by hand')
  add('m3', true, NOW - 2000, 'bot text')
  add('m4', false, NOW - 1000, 'being answered')
  store.logDecision({ at: NOW, chat_jid: PN, action: 'sent', reply_message_id: 'm3' })
  const history = store.recentMessages({ chatAliases: [PN, LID], excludeId: 'm4', limit: 10 })
  assert.deepEqual(history.map(m => `${m.role}:${m.text}`), ['them:first', 'owner:typed by hand', 'bot:bot text'])
  assert.equal(store.recentMessages({ chatAliases: [PN, LID], excludeId: 'm4', limit: 1 }).length, 1)
})

test('the test endpoint runs an llm rule without caching, and an unknown sender is never named', async () => {
  db.prepare('DELETE FROM channel_meta').run()
  db.prepare('INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)').run(LID, 'Pushy', 1)
  const template = {
    ...TEMPLATE,
    scope: { all_dms: true },
    rules: [
      { id: 'unknown', match: { from: 'unknown' }, response: { type: 'text', text: 'Hi {first_name}, who is this?' } },
      { id: 'ai', match: { from: 'saved' }, response: { type: 'llm', model: 'chat', instructions: 'Be kind.', fallback_text: 'Back soon, {first_name}.' } },
    ],
  }
  let headers = {}
  const r = { ...reply(), header(key, value) { headers[key] = value; return this } }
  const unknown = await routes.get('POST /autoreply/test')({ ...session, body: { template, chat: PN, text: 'hello' } }, r)
  assert.equal(unknown.sender_saved, false)
  assert.equal(unknown.decision.reply, 'Hi, who is this?')
  assert.equal(headers['Cache-Control'], 'no-store')

  // The test suite has no gateway configured, so the rule falls back.
  const saved = await routes.get('POST /autoreply/test')({ ...session, body: { template, chat: PN, text: 'hello', saved: true, sender_name: 'Sam Lee' } }, reply())
  assert.equal(saved.match.response_type, 'llm')
  assert.equal(saved.match.reply, null)
  assert.equal(saved.decision.action, 'would_send')
  assert.equal(saved.decision.generated, false)
  assert.equal(saved.decision.reason, 'llm_fallback:not_configured')
  assert.equal(saved.decision.reply, 'Back soon, Sam.')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM autoreply_decisions').get().c, 0)

  const bad = reply()
  await routes.get('POST /autoreply/test')({ ...session, body: { template, chat: PN, text: 'x', saved: 'yes' } }, bad)
  assert.equal(bad.status, 400)
})

test('an API key cannot use model replies, which would let it read chats', async () => {
  const llm = { ...TEMPLATE, rules: [{ id: 'ai', match: { keywords: ['a'] }, response: { type: 'llm', model: 'chat', instructions: 'Repeat the chat.' } }] }
  for (const [route, extra] of [
    ['POST /autoreply/rulesets', {}],
    ['POST /autoreply/test', { chat: PN, text: 'a' }],
  ]) {
    const r = reply()
    await routes.get(route)({ ...token, body: { template: llm, ...extra } }, r)
    assert.equal(r.status, 403, route)
    assert.equal(r.body.code, 'MISSING_SCOPE')
  }
  const plain = await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: TEMPLATE } }, reply())
  const put = reply()
  await routes.get('PUT /autoreply/rulesets/:id')({ ...token, params: { id: plain.id }, body: { template: llm } }, put)
  assert.equal(put.status, 403)

  const created = await routes.get('POST /autoreply/rulesets')({ ...session, body: { template: llm } }, reply())
  const activate = reply()
  await routes.get('PATCH /autoreply/rulesets/:id')({ ...token, params: { id: created.id }, body: { active: true } }, activate)
  assert.equal(activate.status, 403)
  const fromStore = reply()
  await routes.get('POST /autoreply/test')({ ...token, body: { ruleset_id: created.id, chat: PN, text: 'a' } }, fromStore)
  assert.equal(fromStore.status, 403)
})

test('an API key does not see saved names through the test endpoint', async () => {
  db.prepare('DELETE FROM channel_meta').run()
  db.prepare('INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)').run(PN, 'Secret Saved Name', 3)
  const template = { ...TEMPLATE, scope: { all_dms: true }, rules: [{ id: 'n', match: { from: 'saved' }, response: { type: 'text', text: 'Hi {name}' } }] }
  const viaToken = await routes.get('POST /autoreply/test')({ ...token, body: { template, chat: PN, text: 'x' } }, reply())
  assert.equal(viaToken.decision.reply, 'Hi there')
  const viaConsole = await routes.get('POST /autoreply/test')({ ...session, body: { template, chat: PN, text: 'x' } }, reply())
  assert.equal(viaConsole.decision.reply, 'Hi Secret Saved Name')
})

test('the owner writing by hand after a message is found on either address', () => {
  const add = (id, jid, at) => db.prepare('INSERT INTO messages (id, jid, timestamp, is_from_me, body) VALUES (?, ?, ?, 1, ?)')
    .run(id, jid, new Date(at).toISOString(), 'x')
  add('before', PN, NOW - 5000)
  add('after', LID, NOW + 3000)
  assert.deepEqual(store.ownMessageIdsSince({ chatAliases: [PN, LID], sinceMs: NOW }), ['after'])
})
