import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// These pin the two mistakes that made every contact show up twice: reading
// message-key fields that this Baileys version does not emit, and listing the
// two addresses of one person as two chats. Both were invisible in unit tests
// until they were pinned as source-level contracts, because the bug was a
// wrong field *name* rather than wrong logic.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('LID mapping is read from the key fields Baileys actually emits', () => {
  const src = read('../src/wa/client.js')
  for (const field of ['senderPn', 'senderLid', 'participantPn', 'participantLid']) {
    assert.ok(src.includes(`key.${field}`), `client.js no longer reads key.${field}`)
  }
})

test('the abandoned key field names are not reintroduced', () => {
  const src = read('../src/wa/client.js')
  for (const field of ['remoteJidAlt', 'participantAlt']) {
    assert.ok(
      !src.includes(`key.${field}`),
      `key.${field} does not exist in Baileys 6.7.x; reading it silently empties lid_map`,
    )
  }
})

test('the chat list collapses a contact\'s two addresses into one row', () => {
  const src = read('../src/api/channels.js')
  assert.ok(src.includes('canonicalJidMap'), 'channel list no longer canonicalises JIDs')
  assert.ok(src.includes('alt_jids'), 'merged rows no longer report the addresses they absorbed')
})

test('chat search matches a contact by either of its addresses', () => {
  const src = read('../src/api/channels.js')
  assert.ok(
    src.includes('FROM lid_map m'),
    'search dropped its lid_map join, so one address of a chat is filtered out before the merge',
  )
})

test('message reads span every address of a conversation', () => {
  const src = read('../src/api/messages.js')
  assert.ok(src.includes('expandJids'), 'reads no longer expand across LID and phone-number JIDs')
})

test('linkage is read from stored credentials, not the live socket', () => {
  const src = read('../src/wa/client.js')
  const body = src.match(/export function isLinked\(\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(body, 'isLinked() not found')
  assert.ok(
    !body[1].includes('currentSock'),
    'isLinked reads the socket again; it is null during the post-pairing restart, ' +
    'which makes a freshly linked account look unlinked',
  )
})

test('signal keys are cached', () => {
  const src = read('../src/wa/client.js')
  assert.ok(
    src.includes('makeCacheableSignalKeyStore'),
    'uncached signal keys cause decrypt failures and "Device out of sync" on the phone',
  )
})

test('numeric values are not leaked into JSX as bare truthiness', () => {
  const src = readFileSync(new URL('../../ui/src/pages/Workspace.jsx', import.meta.url), 'utf8')
  // `a && b && 0` evaluates to 0, and React renders that as a visible "0".
  // Every guard on a SQLite integer must be coerced or compared.
  assert.ok(
    src.includes('const showSender = Boolean('),
    'showSender is truthiness-chained onto is_from_me (0/1) again; it renders a stray 0',
  )
  assert.ok(
    !/\{msg\.media_size &&/.test(src),
    'media_size guarded by bare truthiness renders a stray 0 when the size is 0',
  )
})

test('an outgoing message reconciles with its WebSocket echo', () => {
  const src = readFileSync(new URL('../../ui/src/pages/Workspace.jsx', import.meta.url), 'utf8')
  assert.ok(
    src.includes('res.messageId'),
    'handleSend no longer adopts the real message id, so the echo draws a second bubble',
  )
})

test('the WebSocket hook calls the current handlers, not the ones from first render', () => {
  const src = readFileSync(new URL('../../ui/src/ws/useWebSocket.js', import.meta.url), 'utf8')
  assert.ok(
    src.includes('handlers.current'),
    'handlers captured in the mount effect see activeJid as null forever',
  )
  assert.ok(
    src.includes('setTimeout(connect'),
    'a dropped socket must reconnect, not just clear its ref',
  )
})

test('console sessions are persisted, not held in memory', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.ok(
    src.includes('SqliteSessionStore'),
    'the default in-memory store signs the owner out on every restart',
  )
})

test('messages carry a resolved sender name, not a raw JID', () => {
  const src = readFileSync(new URL('../src/api/messages.js', import.meta.url), 'utf8')
  assert.ok(src.includes('from_name'), 'message reads no longer resolve the sender name')
  assert.ok(src.includes('resolveNames'), 'sender names are no longer resolved through lid_map')
})

test('sender names resolve through the canonical address', () => {
  const src = readFileSync(new URL('../src/db/lidmap.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function resolveNames'))
  assert.ok(
    fn.includes('canonicalJidMap'),
    'without canonicalising, one contact reads as its address-book name on one ' +
    'address and its pushName on the other',
  )
})

test('a sender label is only drawn in group chats', () => {
  const src = readFileSync(new URL('../../ui/src/pages/Workspace.jsx', import.meta.url), 'utf8')
  assert.ok(
    /const showSender = Boolean\(\s*isGroupChat/.test(src),
    'a one-to-one chat has one other participant; labelling every bubble is noise',
  )
  assert.ok(
    src.includes('msg.from_name ||'),
    'the bubble shows the raw JID again instead of preferring the resolved name',
  )
})
