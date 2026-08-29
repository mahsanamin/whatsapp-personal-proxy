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
