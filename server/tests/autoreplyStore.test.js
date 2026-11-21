import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
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
  await routes.get('POST /autoreply/rulesets')({ ...token, body: { template: { ...TEMPLATE, rules: [{ id: 'x', match: { keywords: ['a'] }, response: { type: 'llm' } }] } } }, bad)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BAD_INPUT')
  assert.match(bad.body.error, /not available yet/)
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
