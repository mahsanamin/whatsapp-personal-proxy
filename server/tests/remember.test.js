import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionMaxAgeMs, DEFAULT_SESSION_MS, REMEMBER_MS } from '../src/util/remember.js'

const DAY = 24 * 60 * 60 * 1000

test('no remember choice keeps the default 7-day session', () => {
  assert.equal(DEFAULT_SESSION_MS, 7 * DAY)
  for (const v of [undefined, null, '', false]) {
    assert.equal(sessionMaxAgeMs(v), DEFAULT_SESSION_MS)
  }
})

test('each remember option maps to its lifetime', () => {
  assert.equal(sessionMaxAgeMs('30d'), 30 * DAY)
  assert.equal(sessionMaxAgeMs('60d'), 60 * DAY)
  assert.equal(sessionMaxAgeMs('forever'), 400 * DAY, 'browsers cap cookies at 400 days')
})

test('unknown remember values are refused, not guessed', () => {
  for (const v of ['90d', 'FOREVER', 'toString', '__proto__', 30, true, {}]) {
    assert.equal(sessionMaxAgeMs(v), null, `value ${String(v)}`)
  }
})

test('the option table cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(REMEMBER_MS))
})
