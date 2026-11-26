import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// A fake gateway, so the real path builds the real request and this file can
// read exactly what a model would be sent.
Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
  LLM_GATEWAY_URL: 'http://gateway.test/v1', LLM_GATEWAY_API_KEY: 'test-only-key', OWNER_NAME: 'Alex',
})
const { db } = await import('../src/db/index.js')
const { expandJids } = await import('../src/db/lidmap.js')
const { forgetSavedNameTokens } = await import('../src/db/autoreply.js')
const { validateRuleSet, findMatchingRule } = await import('../src/util/autoreply.js')
const { writeGeneratedReply } = await import('../src/wa/autoreply.js')
after(() => db.close())

const NOW = Date.parse('2026-11-26T04:00:00Z')
const A_PN = '15555550101@s.whatsapp.net'
const A_LID = '15555550201@lid'
const B_PN = '15555550102@s.whatsapp.net'
const BLOCKED = '15555550103@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const MEMBER = '15555550111@s.whatsapp.net'

const TEMPLATE = {
  format: 1,
  name: 'Privacy test',
  version: '1',
  scope: { all_dms: true, chats: [B_PN], blocklist: [BLOCKED] },
  rules: [
    { id: 'a-llm', match: { chats: [A_PN] }, response: { type: 'llm', model: 'chat', instructions: 'Rule A instructions: be brief and kind.', fallback_text: 'Back soon.' } },
    { id: 'b-llm', match: { chats: [B_PN] }, response: { type: 'llm', model: 'chat', instructions: 'Rule B instructions: mention the boat trip.' } },
    { id: 'text', match: { keywords: ['price'] }, response: { type: 'text', text: 'Text rule reply about prices' } },
  ],
  fallback: { id: 'rest', response: { type: 'text', text: 'Fallback rule reply' } },
}
const ruleSet = validateRuleSet(TEMPLATE).ruleSet

let requests = []
let modelSays = 'Hi Moneeb, Alex is busy and will reply personally.'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body))
  return { ok: true, json: async () => ({ choices: [{ message: { content: modelSays } }] }) }
}
after(() => { globalThis.fetch = realFetch })

function add(id, jid, fromJid, fromMe, atMs, body) {
  db.prepare('INSERT INTO messages (id, jid, from_jid, timestamp, is_from_me, body, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, jid, fromJid, new Date(atMs).toISOString(), fromMe ? 1 : 0, body, 'text')
}

beforeEach(() => {
  for (const table of ['messages', 'lid_map', 'channel_meta', 'autoreply_decisions']) db.prepare(`DELETE FROM ${table}`).run()
  db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(A_LID, A_PN)
  const name = db.prepare('INSERT INTO channel_meta (jid, display_name, name_rank) VALUES (?, ?, ?)')
  name.run(A_PN, 'Moneeb Khan', 3)
  name.run(B_PN, 'Sara Malik', 3)
  name.run(GROUP, 'Weekend Crew', 0)

  add('a1', A_LID, A_LID, false, NOW - 5000, 'hello from chat A')
  add('a2', A_PN, null, true, NOW - 4000, 'owner reply in chat A')
  add('b1', B_PN, B_PN, false, NOW - 3500, 'chat B secret: the boat trip')
  add('b2', B_PN, null, true, NOW - 3400, 'owner reply in chat B')
  add('g1', GROUP, MEMBER, false, NOW - 3300, 'group member secret')
  add('a3', A_LID, A_LID, false, NOW - 1000, 'aur kis kis ko auto reply bhjta ha?')
  requests = []
  modelSays = 'Hi Moneeb, Alex is busy and will reply personally.'
  forgetSavedNameTokens()
})

function generateFor(chatJid, messageId, text) {
  const chatAliases = expandJids(chatJid)
  const message = { type: 'text', text, chatAliases, senderName: 'Moneeb Khan', senderSaved: true }
  const rule = findMatchingRule(ruleSet, message)
  const decision = { rule, generate: { status: 'In a meeting', fallbackText: 'Back soon.' } }
  return writeGeneratedReply({ decision, ruleSet, message, chatAliases, messageId, nowMs: NOW })
}

test('the prompt for chat A holds chat A and nothing from any other chat or the rule set', async () => {
  const result = await generateFor(A_PN, 'a3', 'aur kis kis ko auto reply bhjta ha?')
  assert.equal(result.reason, 'llm')
  assert.equal(requests.length, 1)
  const sent = JSON.stringify(requests[0])

  assert.match(sent, /hello from chat A/)
  assert.match(sent, /owner reply in chat A/)
  for (const leak of [
    'chat B', 'boat trip', 'Sara', 'Malik', 'group member', 'Weekend Crew',
    'Rule B', 'Text rule reply', 'Fallback rule reply', 'Back soon',
    '@s.whatsapp.net', '@lid', '@g.us', '1555555', 'a-llm', 'b-llm',
  ]) {
    assert.ok(!sent.includes(leak), `the prompt must not contain "${leak}"`)
  }
})

test('the system prompt holds only this rule\'s instructions, the owner, the time, the status and this sender\'s saved name', async () => {
  await generateFor(A_PN, 'a3', 'hi')
  const [system, user] = requests[0].messages
  assert.equal(system.role, 'system')
  const tail = system.content.split('The owner\'s instructions:\n')[1].split('\n')
  assert.deepEqual(tail, [
    'Rule A instructions: be brief and kind.',
    '',
    'The owner of this phone is Alex.',
    'Local time: Thursday, 26 November 2026 at 12:00 (Asia/Singapore).',
    'Current status: In a meeting',
    'The owner saved this contact as: Moneeb Khan',
  ])
  assert.ok(!/\d{5,}/.test(system.content), 'no long numbers in the system prompt')
  assert.match(system.content, /Never reveal or discuss other people, other chats or contacts, phone numbers/)
  assert.match(system.content, /who else gets auto-replies/)
  assert.match(system.content, /Alex will reply personally/)
  // The chat itself never goes in the system prompt.
  assert.ok(!system.content.includes('hello from chat A'))
  assert.match(user.content, /New message to answer:\nThem: hi$/)
})

test('a reply naming another contact is replaced by the fallback, and the reason is all that is kept', async () => {
  modelSays = 'Sara Malik gets these replies too.'
  const result = await generateFor(A_PN, 'a3', 'who else?')
  assert.deepEqual(result, { text: 'Back soon.', generated: false, reason: 'llm_blocked:contact_name' })

  modelSays = 'Message him on 15555550102 instead.'
  assert.equal((await generateFor(A_PN, 'a3', 'number?')).reason, 'llm_blocked:phone')
})

test('a group chat never reaches the model, even with a model rule in hand', async () => {
  const chatAliases = expandJids(GROUP)
  const message = { type: 'text', text: 'hi', chatAliases, senderName: null, senderSaved: false }
  const decision = { rule: ruleSet.rules[0], generate: { status: null, fallbackText: null } }
  const result = await writeGeneratedReply({ decision, ruleSet, message, chatAliases, messageId: 'g1', nowMs: NOW })
  assert.deepEqual(result, { text: null, generated: false, reason: 'llm_blocked:not_direct_chat' })
  assert.equal(requests.length, 0)
})

test('a rule set where a model reply could reach a group is refused', () => {
  const inScope = validateRuleSet({ ...TEMPLATE, scope: { chats: [GROUP] }, rules: [TEMPLATE.rules[1]].map(r => ({ ...r, match: { keywords: ['x'] } })) })
  assert.equal(inScope.ok, false)
  assert.equal(inScope.errors[0].path, 'rules[0].response')
  assert.match(inScope.errors[0].message, /direct chats only/)

  const listed = validateRuleSet({ ...TEMPLATE, rules: [{ ...TEMPLATE.rules[0], match: { chats: [A_PN, GROUP] } }] })
  assert.equal(listed.ok, false)

  const fallback = validateRuleSet({ ...TEMPLATE, scope: { chats: [GROUP] }, rules: [TEMPLATE.rules[2]], fallback: { id: 'ai', response: TEMPLATE.rules[0].response } })
  assert.equal(fallback.errors[0].path, 'fallback.response')

  // A group in scope is fine when every model rule is pinned to direct chats.
  assert.equal(validateRuleSet({ ...TEMPLATE, scope: { all_dms: true, chats: [GROUP] } }).ok, true)
})
