import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sendMessage } from '../src/wa/send.js'

// A stand-in for the parts of a Baileys socket the helper touches, reproducing
// the 6.7.24 ordering: the echo upsert is queued on process.nextTick after the
// send resolves, runs inside processingMutex, and switches buffering on.
function fakeSocket({ fail = false } = {}) {
  const events = []
  let chain = Promise.resolve()
  const sock = {
    buffering: false,
    processingMutex: {
      mutex(work) {
        chain = chain.then(work)
        return chain
      },
    },
    ev: {
      flush() {
        events.push(sock.buffering ? 'flush' : 'flush-noop')
        sock.buffering = false
      },
    },
    async sendMessage(jid, content, options) {
      events.push('send')
      if (fail) throw new Error('refused')
      const msg = { key: { id: options?.messageId || 'ID1', remoteJid: jid } }
      process.nextTick(() => {
        sock.processingMutex.mutex(async () => {
          sock.buffering = true
          events.push('echo')
        })
      })
      return msg
    },
  }
  return { sock, events }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('the buffer is flushed after the echo turns buffering on, not before', async () => {
  const { sock, events } = fakeSocket()
  const result = await sendMessage(sock, '15555550100@s.whatsapp.net', { text: 'hi' })
  assert.equal(result.key.id, 'ID1')
  await settle()
  assert.deepEqual(events, ['send', 'echo', 'flush'])
  assert.equal(sock.buffering, false, 'events would sit in the buffer until an unrelated message arrived')
})

test('a caller-chosen message id is passed through', async () => {
  const { sock } = fakeSocket()
  const result = await sendMessage(sock, '15555550100@s.whatsapp.net', { text: 'hi' }, { messageId: 'MINE' })
  assert.equal(result.key.id, 'MINE')
})

test('a failed send still flushes and still throws', async () => {
  const { sock, events } = fakeSocket({ fail: true })
  await assert.rejects(sendMessage(sock, '15555550100@s.whatsapp.net', { text: 'hi' }), /refused/)
  await settle()
  assert.deepEqual(events, ['send', 'flush-noop'])
})

test('every server send goes through the shared helper', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  for (const file of ['../src/index.js', '../src/api/sendText.js', '../src/api/media.js', '../src/api/actions.js']) {
    assert.ok(!read(file).includes('sock.sendMessage('), `${file} calls sock.sendMessage directly and skips the flush`)
  }
})
