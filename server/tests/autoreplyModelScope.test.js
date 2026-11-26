import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'

// A rule set whose replies a model writes lets its manager read chats through
// the model. That needs autoreply:llm on top of autoreply:manage, and even
// then a key never puts anything live.
Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
  LLM_GATEWAY_URL: '', LLM_GATEWAY_API_KEY: '',
})
const { db } = await import('../src/db/index.js')
const { validateRuleSet } = await import('../src/util/autoreply.js')
const store = await import('../src/db/autoreply.js')
const { default: autoreplyRoutes } = await import('../src/api/autoreply.js')

const app = Fastify()
await app.register(autoreplyRoutes)
after(async () => { await app.close(); db.close() })

const MANAGE = 'sk_test_manage_only'
const WITH_LLM = 'sk_test_manage_and_llm'
const LLM_ONLY = 'sk_test_llm_only'
const as = (token) => ({ authorization: `Bearer ${token}` })

const TEXT_TEMPLATE = {
  format: 1, name: 'Plain', version: '1', scope: { allowlist: true },
  rules: [{ id: 'hi', match: { keywords: ['hi'] }, response: { type: 'text', text: 'Hello' } }],
}
const LLM_TEMPLATE = {
  format: 1, name: 'Written', version: '1', scope: { allowlist: true },
  rules: [{ id: 'ask', match: { keywords: ['hi'] }, response: { type: 'llm', model: 'test-model', instructions: 'Be brief.' } }],
}

function addToken(id, raw, scopes) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  db.prepare('INSERT INTO tokens (id, name, token_hash, scopes) VALUES (?, ?, ?, ?)').run(id, id, hash, JSON.stringify(scopes))
}

function saveSet(template) {
  const text = JSON.stringify(template)
  return store.createRuleSet(text, validateRuleSet(text).ruleSet)
}

beforeEach(() => {
  for (const table of ['tokens', 'autoreply_rulesets', 'autoreply_decisions']) db.prepare(`DELETE FROM ${table}`).run()
  addToken('manage', MANAGE, ['autoreply:manage'])
  addToken('llm', WITH_LLM, ['autoreply:manage', 'autoreply:llm'])
  addToken('llm-only', LLM_ONLY, ['autoreply:llm'])
})

function assertRefused(res) {
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'MISSING_SCOPE')
  assert.match(res.json().error, /autoreply:llm/)
}

test('without autoreply:llm a key cannot create, update, activate or test a model rule set', async () => {
  assertRefused(await app.inject({ method: 'POST', url: '/autoreply/rulesets', headers: as(MANAGE), payload: { template: LLM_TEMPLATE } }))
  assert.equal(store.listRuleSets().length, 0)

  const plain = saveSet(TEXT_TEMPLATE)
  assertRefused(await app.inject({ method: 'PUT', url: `/autoreply/rulesets/${plain.id}`, headers: as(MANAGE), payload: { template: LLM_TEMPLATE } }))
  assert.equal(store.getRuleSet(plain.id).name, 'Plain')

  const written = saveSet(LLM_TEMPLATE)
  assertRefused(await app.inject({ method: 'PATCH', url: `/autoreply/rulesets/${written.id}`, headers: as(MANAGE), payload: { active: true } }))
  assert.equal(store.getRuleSet(written.id).active, false)

  assertRefused(await app.inject({ method: 'POST', url: '/autoreply/test', headers: as(MANAGE), payload: { ruleset_id: written.id, chat: '+15555550101', text: 'hi' } }))
  assertRefused(await app.inject({ method: 'POST', url: '/autoreply/test', headers: as(MANAGE), payload: { template: LLM_TEMPLATE, chat: '+15555550101', text: 'hi' } }))
})

test('validating a model rule set needs only autoreply:manage, since it reads no chat', async () => {
  const res = await app.inject({ method: 'POST', url: '/autoreply/validate', headers: as(MANAGE), payload: { template: LLM_TEMPLATE } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().valid, true)
})

test('autoreply:llm alone grants nothing', async () => {
  const res = await app.inject({ method: 'POST', url: '/autoreply/rulesets', headers: as(LLM_ONLY), payload: { template: LLM_TEMPLATE } })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /autoreply:manage/)
})

test('with autoreply:llm a key can create, update, activate in dry-run and test a model rule set', async () => {
  const created = await app.inject({ method: 'POST', url: '/autoreply/rulesets', headers: as(WITH_LLM), payload: { template: LLM_TEMPLATE } })
  assert.equal(created.statusCode, 201)
  const id = created.json().id
  assert.equal(created.json().mode, 'dry_run')

  const updated = await app.inject({ method: 'PUT', url: `/autoreply/rulesets/${id}`, headers: as(WITH_LLM), payload: { template: { ...LLM_TEMPLATE, version: '2' } } })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().version, '2')

  const activated = await app.inject({ method: 'PATCH', url: `/autoreply/rulesets/${id}`, headers: as(WITH_LLM), payload: { active: true, mode: 'dry_run' } })
  assert.equal(activated.statusCode, 200)
  assert.equal(activated.json().active, true)
  assert.equal(activated.json().mode, 'dry_run')

  const tested = await app.inject({ method: 'POST', url: '/autoreply/test', headers: as(WITH_LLM), payload: { ruleset_id: id, chat: '+15555550101', text: 'hi' } })
  assert.equal(tested.statusCode, 200)
  assert.equal(tested.json().match.rule_id, 'ask')
})

test('autoreply:llm still never puts a rule set live', async () => {
  const written = saveSet(LLM_TEMPLATE)
  const live = await app.inject({ method: 'PATCH', url: `/autoreply/rulesets/${written.id}`, headers: as(WITH_LLM), payload: { active: true, mode: 'live' } })
  assert.equal(live.statusCode, 403)
  assert.equal(store.getRuleSet(written.id).mode, 'dry_run')

  const kill = await app.inject({ method: 'PUT', url: '/autoreply/settings', headers: as(WITH_LLM), payload: { enabled: true } })
  assert.equal(kill.statusCode, 401)
  assert.equal(store.isEnabled(), false)
})

test('a key without autoreply:llm reads the decision log without model-written text', async () => {
  const written = saveSet(LLM_TEMPLATE)
  const plain = saveSet(TEXT_TEMPLATE)
  const log = (rulesetId, reason, text) => db.prepare(`
    INSERT INTO autoreply_decisions (at, chat_jid, ruleset_id, ruleset_name, action, reason, reply_text)
    VALUES (?, '15555550101@s.whatsapp.net', ?, 'x', 'dry_run', ?, ?)
  `).run(Date.now(), rulesetId, reason, text)
  log(written.id, 'manual_reply_pause', 'from the model, paused')
  log(plain.id, 'llm', 'from the model, set since edited')
  log('deleted-set', 'keyword', 'set no longer exists')
  log(plain.id, 'keyword', 'Hello')

  const manage = (await app.inject({ url: '/autoreply/decisions', headers: as(MANAGE) })).json()
  assert.deepEqual(manage.filter(r => r.reply_text).map(r => r.reply_text), ['Hello'])
  assert.equal(manage.filter(r => r.reply_redacted).length, 3)

  const withLlm = (await app.inject({ url: '/autoreply/decisions', headers: as(WITH_LLM) })).json()
  assert.equal(withLlm.filter(r => r.reply_text).length, 4)
  assert.equal(withLlm.some(r => r.reply_redacted), false)
})
