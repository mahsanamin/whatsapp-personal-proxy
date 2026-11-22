import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectionGate } from '../src/util/connectionGate.js'

// A fake clock: timers run only when the test says so.
function fakeTimers() {
  const pending = new Map()
  let next = 1
  return {
    setTimer: (fn) => { const id = next++; pending.set(id, fn); return id },
    clearTimer: (id) => { pending.delete(id) },
    runAll: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach(fn => fn()) },
    get size() { return pending.size },
  }
}

test('a new attempt makes the previous socket stale', () => {
  const gate = createConnectionGate(fakeTimers())
  const first = gate.begin()
  const second = gate.begin()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
})

test('the replaced socket closing does not schedule a reconnect', () => {
  const clock = fakeTimers()
  const gate = createConnectionGate(clock)
  const old = gate.begin()
  gate.begin() // e.g. "refresh QR" replaced the socket
  let reconnects = 0
  assert.equal(gate.retryLater(old, 1000, () => reconnects++), false)
  clock.runAll()
  assert.equal(reconnects, 0)
})

test('starting a new attempt cancels a retry still waiting to fire', () => {
  const clock = fakeTimers()
  const gate = createConnectionGate(clock)
  const token = gate.begin()
  let reconnects = 0
  gate.retryLater(token, 1000, () => reconnects++)
  gate.begin() // manual refresh arrives before the backoff timer
  assert.equal(clock.size, 0)
  clock.runAll()
  assert.equal(reconnects, 0)
})

test('the current socket closing retries exactly once', () => {
  const clock = fakeTimers()
  const gate = createConnectionGate(clock)
  const token = gate.begin()
  let reconnects = 0
  assert.equal(gate.retryLater(token, 1000, () => reconnects++), true)
  gate.retryLater(token, 1000, () => reconnects++) // a duplicate close event
  assert.equal(clock.size, 1)
  clock.runAll()
  assert.equal(reconnects, 1)
})
