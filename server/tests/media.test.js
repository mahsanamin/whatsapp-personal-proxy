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

test('send times come from the payload, not from when we happened to ingest it', () => {
  const src = read('../src/wa/client.js')
  assert.ok(
    !src.includes("typeof raw.messageTimestamp === 'number'"),
    'messageTimestamp is a 64-bit protobuf value: a string on history sync, a Long ' +
    'when live, never a plain number. Testing for `number` stamps every message ' +
    'with the moment it was ingested and collapses all history onto one instant',
  )
  assert.ok(
    src.includes('toNumber(raw.messageTimestamp)'),
    'the timestamp must go through the same coercion as every other protobuf number',
  )
})

test('mis-stamped history can be repaired from the stored payloads', () => {
  const src = read('../src/db/repair.js')
  assert.ok(src.includes('messageTimestamp'), 'the timestamp repair is gone')
  assert.ok(
    src.includes('timestamp <> strftime'),
    'the repair must be idempotent, rewriting only rows that are actually wrong',
  )
  assert.ok(
    read('../src/index.js').includes('repairMessageTimestamps'),
    'the repair is never run',
  )
})

test('media re-upload is attempted on any failure, not a guessed status shape', () => {
  const src = read('../src/wa/media.js')
  assert.ok(
    !/err\?\.response\?\.status \|\| err\?\.status/.test(src),
    'Baileys throws Boom (err.output.statusCode); checking only the axios shape ' +
    'against a fixed list means the updateMediaMessage recovery never runs',
  )
  assert.ok(src.includes('updateMediaMessage'), 'the re-upload recovery is gone')
  assert.ok(src.includes('output?.statusCode'), 'Boom status codes are ignored again')
})

test('an empty download is a failure, never something to cache', () => {
  const src = read('../src/wa/media.js')
  assert.ok(
    src.includes('buffer.length === 0') || src.includes('length === 0'),
    'a zero-length body served as media is undecodable, and caching it makes that permanent',
  )
})

test('viewing media does not silently persist it', () => {
  const src = read('../src/wa/media.js')
  assert.ok(
    src.includes('opts.saveToDisk'),
    'saveToDisk must be honoured: /media/save is the explicit "keep a copy" action, ' +
    'and media_saved has to keep meaning that',
  )
})

test('a media failure reports why', () => {
  const src = read('../src/api/messages.js')
  assert.ok(
    src.includes('MediaUnavailableError'),
    'the route must distinguish "gone" from "broken" instead of returning a blanket 500',
  )
})

test('the console can page back through the whole stored history', () => {
  const src = read('../../ui/src/pages/Workspace.jsx')
  assert.ok(
    src.includes('loadOlder'),
    'without pagination the console shows only the newest 50 messages, so a chat ' +
    'with years of history appears to begin a few weeks ago',
  )
  assert.ok(src.includes('before=') || src.includes('&before='), 'older pages are never requested')
  assert.ok(
    src.includes('pendingScrollRestore'),
    'prepending older messages must not throw the reader to the bottom',
  )
})

test('older history can be requested from the phone', () => {
  const src = read('../src/api/channels.js')
  assert.ok(src.includes('fetchMessageHistory'), 'the on-demand history request is gone')
  assert.ok(
    src.includes("'/channels/:jid/history'"),
    'there must be a way to ask for history older than anything stored',
  )
})

test('content nested inside an envelope is unwrapped, not called unknown', () => {
  const src = read('../src/wa/client.js')
  assert.ok(src.includes('MESSAGE_ENVELOPES'), 'the envelope list is gone')
  for (const envelope of ['associatedChildMessage', 'ephemeralMessage', 'viewOnceMessage']) {
    assert.ok(
      src.includes(envelope),
      `${envelope} is no longer unwrapped; an album's photos and videos arrive ` +
      'inside one, and ignoring it discards their media keys entirely',
    )
  }
})

test('downloads unwrap the same envelopes the parser does', () => {
  const src = read('../src/wa/media.js')
  assert.ok(
    src.includes('unwrapMessage'),
    'Baileys looks for media at the top level of .message and rejects an album ' +
    'child as "not a media message" unless it is unwrapped first',
  )
})

test('a phone that never answers cannot hold a request open', () => {
  const src = read('../src/wa/media.js')
  assert.ok(
    src.includes('withTimeout') && src.includes('mediaReuploadTimeoutMs'),
    'the socket runs with no default query timeout, so the re-upload wait must ' +
    'be bounded here or the request hangs until the proxy gives up',
  )
  assert.ok(
    read('../src/config.js').includes('MEDIA_REUPLOAD_TIMEOUT_S'),
    'the wait must be tunable: how long a phone needs is not knowable in advance',
  )
  const nginx = readFileSync(new URL('../../nginx/nginx.conf', import.meta.url), 'utf8')
  assert.ok(
    /location \/api\/[\s\S]*?proxy_read_timeout/.test(nginx),
    'nginx defaults to a 60s read timeout, which returned 504 while the phone was still re-uploading',
  )
})

test('a whole conversation of media can be exported at once', () => {
  const cli = read('../../wpp')
  assert.ok(cli.includes('"export"'), 'the bulk media export is gone')
  assert.ok(cli.includes('skipped_existing'), 'export must be resumable rather than refetching everything')
})

test('media can be archived on arrival, while WhatsApp still has it', () => {
  const cfg = read('../src/config.js')
  assert.ok(cfg.includes('mediaAutoDownload'), 'the archive-on-arrival option is gone')
  const client = read('../src/wa/client.js')
  assert.ok(
    client.includes('archiveMedia'),
    'WhatsApp expires media from its CDN; anything not kept on arrival is likely ' +
    'unrecoverable, since the phone often will not re-upload it',
  )
  assert.ok(
    client.includes('setImmediate'),
    'archiving must never delay or fail ingestion',
  )
})

test('an album is recorded even when its children are missing', () => {
  const src = read('../src/wa/client.js')
  assert.ok(src.includes("type = 'album'"), 'albums fall back to unknown again')
  assert.ok(
    !src.includes('photo${images === 1'),
    'expectedImageCount counts videos too, so the label must not claim a kind',
  )
})
