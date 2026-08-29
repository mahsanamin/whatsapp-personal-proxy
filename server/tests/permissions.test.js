import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The whole safety model of this project is one sentence: the console may
// message anyone, an API key may not. Every send route has to hold that line,
// and a route added later must not quietly opt out of it.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// The destination rules moved into util/sendPermission.js so every send route
// — text and media alike — asks the same question. These assert the rules
// there, since that is now the only place they exist.

test('a DM from an API key requires the recipient to be allowed', () => {
  const guard = read('../src/util/sendPermission.js')
  assert.ok(guard.includes('FROM whitelist WHERE jid = ?'), 'the allow-list lookup is gone')
  assert.ok(guard.includes('NOT_WHITELISTED'), 'the guard no longer reports why it refused')
  assert.ok(read('../src/api/others.js').includes('sendText'), 'others/send bypasses the shared guard')
})

test('a group message from an API key requires the group to be allowed', () => {
  const guard = read('../src/util/sendPermission.js')
  assert.ok(
    guard.includes('isGroup(jid)') && guard.includes('isAllowed(jid)'),
    'groups are exempt from the allow list again — a key with groups:send could ' +
    'message every group you are in',
  )
  assert.ok(
    guard.includes('request.session?.authenticated'),
    'the guard must exempt the console session, which may message anyone',
  )
  assert.ok(read('../src/api/groups.js').includes('sendText'), 'groups/send bypasses the shared guard')
})

test('personal sends are limited to the configured numbers', () => {
  const guard = read('../src/util/sendPermission.js')
  assert.ok(guard.includes('config.personalNumbers'), 'the own-numbers check is gone')
  assert.ok(
    guard.includes("scopes.includes('personal:send')"),
    'reaching your own numbers must still require the personal:send scope',
  )
  assert.ok(read('../src/api/personal.js').includes('sendText'), 'personal/send bypasses the shared guard')
})

test('the unrestricted send route is reachable only by the console', () => {
  const src = read('../src/index.js')
  const route = src.slice(src.indexOf("fastify.post('/send'"), src.indexOf("fastify.post('/send'") + 400)
  assert.ok(
    route.includes('requireSession'),
    '/send bypasses every allow list, so it must never be reachable with a Bearer token',
  )
  assert.ok(
    !route.includes('requireScope'),
    '/send must not be exposed to API keys under any scope',
  )
})

test('the console offers a way to manage the allow list', () => {
  const page = read('../../ui/src/pages/Whitelist.jsx')
  assert.ok(page.includes("api('/whitelist'"), 'the allow-list page no longer reads the list')
  assert.ok(page.includes("method: 'POST'"), 'the allow-list page can no longer add entries')
  assert.ok(page.includes("method: 'DELETE'"), 'the allow-list page can no longer remove entries')

  const app = read('../../ui/src/App.jsx')
  assert.ok(app.includes('path="/whitelist"'), 'the allow-list page is not routed')
})

test('permission is decided before the request body is validated', () => {
  const src = read('../src/api/sendText.js')
  const guardAt = src.indexOf('refuseIfNotAllowed')
  const bodyAt = src.indexOf("code: 'BAD_INPUT'")
  assert.ok(guardAt > -1 && bodyAt > -1, 'sendText lost a check')
  assert.ok(
    guardAt < bodyAt,
    'a caller who may not message this destination should not learn whether ' +
    'their request was otherwise well formed',
  )
})
