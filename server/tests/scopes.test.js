import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The scope list is the contract between the token middleware, the web
// console's picker, and the docs. Drift between them silently grants or denies
// access, so pin it here. Read as text rather than imported, so this suite
// stays runnable without the native better-sqlite3 build.
const EXPECTED = [
  'personal:send',
  'others:send',
  'others:whitelist:read',
  'others:whitelist:manage',
  'groups:send',
  'channels:read',
  'channels:summarize',
  'tabs:manage',
  'wa:admin',
]

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('VALID_SCOPES matches the documented set', () => {
  const src = read('../src/middleware/token.js')
  const block = src.match(/const VALID_SCOPES = \[([\s\S]*?)\]/)
  assert.ok(block, 'VALID_SCOPES declaration not found')
  const found = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(found, EXPECTED)
})

test('every scope is offered in the web console', () => {
  const ui = read('../../ui/src/pages/Tokens.jsx')
  for (const scope of EXPECTED) {
    assert.ok(ui.includes(`'${scope}'`), `web console is missing the ${scope} scope`)
  }
})

test('every scope has a plain-language label in the web console', () => {
  const ui = read('../../ui/src/pages/Tokens.jsx')
  const block = ui.match(/const SCOPE_LABELS = \{([\s\S]*?)\n\}/)
  assert.ok(block, 'SCOPE_LABELS declaration not found')
  const labelled = [...block[1].matchAll(/'([^']+)':\s*'[^']+'/g)].map(m => m[1])
  assert.deepEqual(labelled, EXPECTED)
})

test('every scope is documented in the README', () => {
  const readme = read('../../README.md')
  for (const scope of EXPECTED) {
    assert.ok(readme.includes(scope), `README does not document the ${scope} scope`)
  }
})

test('the CLI never routes a send to an endpoint the server does not expose', () => {
  const cli = read('../../wpp')
  for (const path of ['/api/personal/send', '/api/others/send', '/api/groups/send']) {
    assert.ok(cli.includes(path), `CLI lost the ${path} route`)
  }
  const routes = read('../src/api/personal.js') + read('../src/api/others.js') + read('../src/api/groups.js')
  for (const route of ['/personal/send', '/others/send', '/groups/send']) {
    assert.ok(routes.includes(`'${route}'`), `server no longer serves ${route}`)
  }
})
