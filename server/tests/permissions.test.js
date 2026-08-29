import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The whole safety model of this project is one sentence: the console may
// message anyone, an API key may not. Every send route has to hold that line,
// and a route added later must not quietly opt out of it.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('a DM from an API key requires the recipient to be allowed', () => {
  const src = read('../src/api/others.js')
  assert.ok(src.includes('FROM whitelist WHERE jid = ?'), 'others/send lost its allow-list check')
  assert.ok(src.includes('NOT_WHITELISTED'), 'others/send no longer reports why it refused')
})

test('a group message from an API key requires the group to be allowed', () => {
  const src = read('../src/api/groups.js')
  assert.ok(
    src.includes('FROM whitelist WHERE jid = ?'),
    'groups/send accepts any group again — a key with groups:send could message every group you are in',
  )
  assert.ok(
    src.includes("request.session?.authenticated"),
    'the group allow-list check must exempt the console session, which may message anyone',
  )
})

test('personal sends are limited to the configured numbers', () => {
  const src = read('../src/api/personal.js')
  assert.ok(src.includes('config.personalNumbers.includes'), 'personal/send lost its number check')
  assert.ok(src.includes('NOT_PERSONAL_NUMBER'), 'personal/send no longer reports why it refused')
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
