import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('unread is measured against last_read_at, not message status', () => {
  const src = read('../src/api/channels.js')
  assert.ok(
    src.includes('cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at'),
    'unread counted from message status again — incoming messages are always ' +
    "'sent', so that reports every message ever received as unread",
  )
  assert.ok(
    !src.includes("m.status != 'read'"),
    "status is a delivery receipt for outgoing messages; it cannot express whether the owner has read an incoming one",
  )
})

test('a chat can be marked read across both of its addresses', () => {
  const src = read('../src/api/channels.js')
  assert.ok(src.includes("'/channels/:jid/read'"), 'the mark-read route is gone')
  assert.ok(
    src.slice(src.indexOf("'/channels/:jid/read'")).includes('expandJids'),
    'marking read must cover every address of the conversation, or it stays unread',
  )
})

test('the brief ranks by signal rather than recency alone', () => {
  const src = read('../src/api/brief.js')
  assert.ok(src.includes('unread_mentions'), 'brief no longer surfaces mentions of the owner')
  assert.ok(src.includes('replies_to_me'), 'brief no longer surfaces replies to the owner')
  assert.ok(src.includes('is_muted'), 'brief no longer discounts muted chats')
})

test('the brief excludes protocol noise', () => {
  const src = read('../src/api/brief.js')
  assert.ok(
    src.includes("NOT IN ('reaction', 'unknown')"),
    "unparsed 'unknown' messages are protocol chatter with no body; counting them as unread is noise",
  )
})

test('mentions of the owner are computed at ingest', () => {
  const src = read('../src/wa/client.js')
  assert.ok(src.includes('mentionsMe'), 'mention detection is gone')
  assert.ok(
    src.includes('mentions_me'),
    'the flag must be stored; parsing raw_json per query is far too slow across a mailbox',
  )
})

test('the CLI trims records before an LLM pays for them', () => {
  const cli = read('../../wpp')
  assert.ok(cli.includes('def compact_message'), 'compact message shaping is gone')
  assert.ok(cli.includes('def compact_chat'), 'compact chat shaping is gone')
  assert.ok(cli.includes('"brief"'), 'the brief command is gone')
  assert.ok(
    cli.includes('args.verbose'),
    'there must be a way back to the full records when they are genuinely needed',
  )
})
