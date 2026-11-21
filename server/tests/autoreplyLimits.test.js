import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'

Object.assign(process.env, {
  ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
  AUTOREPLY_MIN_GAP_S: '60', AUTOREPLY_MAX_PER_CHAT_PER_HOUR: '3', AUTOREPLY_MAX_PER_CHAT_PER_DAY: '10',
  AUTOREPLY_MAX_PER_HOUR: '30', AUTOREPLY_MAX_AGE_S: '180',
})
const { db } = await import('../src/db/index.js')
const { LIMIT_BOUNDS, validateLimitsPatch, mergeLimits } = await import('../src/util/autoreplyLimits.js')
const { effectiveLimits, validateRuleSet, decide } = await import('../src/util/autoreply.js')
const store = await import('../src/db/autoreply.js')
const { default: autoreplyRoutes } = await import('../src/api/autoreply.js')

const DEFAULTS = { minGapSeconds: 60, maxPerChatPerHour: 3, maxPerChatPerDay: 10, maxPerHour: 30, maxAgeSeconds: 180 }

// ─── Pure helpers ────────────────────────────────────────────────────

test('a change is accepted only as whole numbers inside the bounds', () => {
  assert.deepEqual(validateLimitsPatch({ minGapSeconds: 5, maxPerHour: 1000 }),
    { ok: true, errors: [], values: { minGapSeconds: 5, maxPerHour: 1000 } })

  for (const bad of [
    { minGapSeconds: 4 }, { minGapSeconds: 3601 }, { maxPerChatPerHour: 0 }, { maxPerChatPerDay: 1.5 },
    { maxPerHour: '30' }, { maxAgeSeconds: 29 }, { maxAgeSeconds: 601 }, { maxPerHour: null },
  ]) {
    assert.equal(validateLimitsPatch(bad).ok, false, JSON.stringify(bad))
  }
})

test('unknown fields, empty changes and non-objects are refused', () => {
  assert.match(validateLimitsPatch({ minGap: 10 }).errors[0], /Unknown limit "minGap"/)
  assert.equal(validateLimitsPatch({}).ok, false)
  assert.equal(validateLimitsPatch(null).ok, false)
  assert.equal(validateLimitsPatch([1]).ok, false)
})

test('the lower bounds match the env parsing floors', () => {
  assert.equal(LIMIT_BOUNDS.minGapSeconds.min, 5)
  for (const field of ['maxPerChatPerHour', 'maxPerChatPerDay', 'maxPerHour']) assert.equal(LIMIT_BOUNDS[field].min, 1)
  assert.deepEqual(LIMIT_BOUNDS.maxAgeSeconds, { min: 30, max: 600 })
})

test('saved values override the defaults, and broken ones fall back', () => {
  const { limits, overridden } = mergeLimits(DEFAULTS, { minGapSeconds: 5, maxPerHour: 0, maxPerChatPerDay: 10, junk: 7 })
  assert.deepEqual(limits, { ...DEFAULTS, minGapSeconds: 5 })
  assert.deepEqual(overridden, ['minGapSeconds'])
})

test('a template can still only tighten overridden server limits', () => {
  const server = mergeLimits(DEFAULTS, { maxPerChatPerHour: 20, maxPerChatPerDay: 50, minGapSeconds: 5 }).limits
  const strict = { max_replies_per_contact_per_hour: 2, max_replies_per_contact_per_day: 4 }
  assert.deepEqual(effectiveLimits(strict, server), { perContactHour: 2, perContactDay: 4, perHour: 30, minGapMs: 5000 })

  const loose = { max_replies_per_contact_per_hour: 99, max_replies_per_contact_per_day: 999 }
  const lowered = mergeLimits(DEFAULTS, { maxPerChatPerHour: 1, maxPerChatPerDay: 2 }).limits
  assert.deepEqual(effectiveLimits(loose, lowered), { perContactHour: 1, perContactDay: 2, perHour: 30, minGapMs: 60_000 })
})

// ─── Routes ──────────────────────────────────────────────────────────

const app = Fastify()
app.addHook('onRequest', async request => {
  if (request.headers['x-test-console'] === 'yes') request.session = { authenticated: true }
})
await app.register(autoreplyRoutes)
after(async () => { await app.close(); db.close() })

const consoleHeaders = { 'x-test-console': 'yes' }
const TOKEN = 'sk_test_autoreply_manage'
const tokenHeaders = { authorization: `Bearer ${TOKEN}` }

const TEMPLATE = {
  format: 1, name: 'Limits test', version: '1', scope: { allowlist: true },
  rules: [{ id: 'hi', match: { keywords: ['hi'] }, response: { type: 'text', text: 'Hello' } }],
}

beforeEach(() => {
  for (const table of ['tokens', 'autoreply_settings', 'autoreply_rulesets']) db.prepare(`DELETE FROM ${table}`).run()
  const hash = crypto.createHash('sha256').update(TOKEN).digest('hex')
  db.prepare('INSERT INTO tokens (id, name, token_hash, scopes) VALUES (?, ?, ?, ?)')
    .run('t1', 'agent', hash, JSON.stringify(['autoreply:manage']))
})

test('a token with autoreply:manage can read the limits but never change them', async () => {
  const read = await app.inject({ url: '/autoreply/settings', headers: tokenHeaders })
  assert.equal(read.statusCode, 200)
  assert.deepEqual(read.json().limits, DEFAULTS)
  assert.deepEqual(read.json().defaults, DEFAULTS)
  assert.deepEqual(read.json().overridden, [])
  assert.deepEqual(read.json().bounds, LIMIT_BOUNDS)

  const write = await app.inject({ method: 'PUT', url: '/autoreply/limits', headers: tokenHeaders, payload: { maxPerHour: 1000 } })
  assert.equal(write.statusCode, 401)
  const reset = await app.inject({ method: 'DELETE', url: '/autoreply/limits', headers: tokenHeaders })
  assert.equal(reset.statusCode, 401)
  assert.equal(store.getServerLimits().limits.maxPerHour, 30)
})

test('the console saves limits, they persist, and reset restores the defaults', async () => {
  const saved = await app.inject({ method: 'PUT', url: '/autoreply/limits', headers: consoleHeaders, payload: { minGapSeconds: 5, maxAgeSeconds: 300 } })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json().limits, { ...DEFAULTS, minGapSeconds: 5, maxAgeSeconds: 300 })
  assert.deepEqual(saved.json().overridden, ['minGapSeconds', 'maxAgeSeconds'])
  assert.equal(db.prepare("SELECT value FROM autoreply_settings WHERE key = 'limit.minGapSeconds'").get().value, '5')

  // Saving the default again drops the override, so `.env` decides it again.
  await app.inject({ method: 'PUT', url: '/autoreply/limits', headers: consoleHeaders, payload: { maxAgeSeconds: 180 } })
  assert.deepEqual(store.getServerLimits().overridden, ['minGapSeconds'])

  const reset = await app.inject({ method: 'DELETE', url: '/autoreply/limits', headers: consoleHeaders })
  assert.equal(reset.statusCode, 200)
  assert.deepEqual(reset.json().limits, DEFAULTS)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM autoreply_settings WHERE key LIKE 'limit.%'").get().n, 0)
})

test('bad values are refused with BAD_INPUT and change nothing', async () => {
  const bad = await app.inject({ method: 'PUT', url: '/autoreply/limits', headers: consoleHeaders, payload: { minGapSeconds: 4, maxPerHour: 10 } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'BAD_INPUT')
  assert.match(bad.json().error, /minGapSeconds/)
  assert.deepEqual(store.getServerLimits().limits, DEFAULTS)
})

test('changing limits does not take a live rule set out of live mode, and the engine sees the change', async () => {
  const ruleSet = validateRuleSet(TEMPLATE).ruleSet
  const row = store.createRuleSet(JSON.stringify(TEMPLATE), ruleSet)
  db.prepare("UPDATE autoreply_rulesets SET mode = 'live', active = 1 WHERE id = ?").run(row.id)
  store.setEnabled(true)

  const nowMs = Date.now()
  const message = { type: 'text', text: 'hi', chatAliases: ['15555550101@s.whatsapp.net'], senderName: null }
  const stats = { lastReplyAt: nowMs - 10_000 }
  const before = decide({ ruleSet, message, nowMs, stats, limits: store.getServerLimits().limits })
  assert.equal(before.reason, 'min_gap')

  await app.inject({ method: 'PUT', url: '/autoreply/limits', headers: consoleHeaders, payload: { minGapSeconds: 5 } })
  const after = decide({ ruleSet, message, nowMs, stats, limits: store.getServerLimits().limits })
  assert.notEqual(after.reason, 'min_gap')

  const active = store.getRuleSet(row.id)
  assert.equal(active.mode, 'live')
  assert.equal(active.active, true)
  assert.equal(store.isEnabled(), true)
})
