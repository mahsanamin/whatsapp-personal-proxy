import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('protobuf Long values are coerced before they reach SQLite', () => {
  const src = read('../src/wa/client.js')
  assert.ok(src.includes('function toNumber'), 'the Long coercion helper is gone')
  for (const kind of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']) {
    assert.ok(
      src.includes(`toNumber(msg.${kind}.fileLength)`),
      `${kind}.fileLength is bound raw again — better-sqlite3 refuses to bind a ` +
      'Long object, so every message of that type is silently dropped',
    )
  }
})

test('a failed insert is reported rather than swallowed', () => {
  const src = read('../src/wa/client.js')
  assert.ok(
    src.includes('failed to store message'),
    'saving must log on failure; a silent catch is how media loss went unnoticed',
  )
})

test('a voice note is distinguished from an audio file', () => {
  const src = read('../src/wa/client.js')
  assert.ok(
    src.includes("msg.audioMessage.ptt ? 'voice' : 'audio'"),
    'WhatsApp renders a voice note and an audio attachment differently; so should we',
  )
})

test('messages we send are stored immediately, not only on the echo', () => {
  const src = read('../src/wa/client.js')
  assert.ok(src.includes('export function recordSentMessage'), 'send-time persistence is gone')
  for (const rel of ['../src/api/sendText.js', '../src/api/media.js']) {
    assert.ok(
      read(rel).includes('recordSentMessage'),
      `${rel} no longer records what it sent, so replying to it races the echo`,
    )
  }
})

test('the media route takes the body as bytes, whatever the content type', () => {
  const src = read('../src/api/media.js')
  assert.ok(
    src.includes("removeContentTypeParser(['text/plain', 'application/json'])"),
    "Fastify's built-in parsers outrank the wildcard, so a .txt upload arrives as " +
    'a string and a .json one as an object',
  )
  assert.ok(src.includes("parseAs: 'buffer'"), 'the wildcard parser must produce a Buffer')
})

test('media sends obey the same allow list as text', () => {
  const src = read('../src/api/media.js')
  assert.ok(
    src.includes('refuseIfNotAllowed'),
    'a media send must not be a way around the allow list that gates text',
  )
})

test('one module decides who may message whom', () => {
  const guard = read('../src/util/sendPermission.js')
  assert.ok(guard.includes('groups:send') && guard.includes('others:send') && guard.includes('personal:send'),
    'the send guard no longer covers every destination kind')
  assert.ok(
    guard.includes('return false') || guard.includes('Fail closed'),
    'an unreadable allow list must fail closed, never open',
  )
  for (const rel of ['../src/api/personal.js', '../src/api/others.js', '../src/api/groups.js', '../src/api/media.js']) {
    const src = read(rel)
    assert.ok(
      src.includes('sendText.js') || src.includes('refuseIfNotAllowed'),
      `${rel} checks permissions on its own again; duplicating that check is how ` +
      'group sends ended up with no allow list at all',
    )
  }
})

test('the console renders media even when it has a caption', () => {
  const src = read('../../ui/src/pages/Workspace.jsx')
  assert.ok(
    !src.includes('isMedia && !msg.body'),
    'gating media on the absence of a caption hides every captioned photo, ' +
    'showing only its caption text',
  )
  assert.ok(src.includes('<MediaBlock'), 'the media renderer is gone')
})

test('images, video and audio play in the console rather than only linking', () => {
  const src = read('../../ui/src/pages/Workspace.jsx')
  const block = src.slice(src.indexOf('function MediaBlock'), src.indexOf('function MessageBubble'))
  assert.ok(block.includes('<img'), 'photos no longer render inline')
  assert.ok(block.includes('<video'), 'video no longer plays inline')
  assert.ok(block.includes('<audio'), 'voice notes must be playable without downloading them')
})
