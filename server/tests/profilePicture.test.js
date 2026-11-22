import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPictureError,
  isPictureFresh,
  isAllowedPictureUrl,
  pictureMime,
  isPictureJid,
  createLimiter,
  PICTURE_TTL_MS,
  PICTURE_ERROR_TTL_MS,
} from '../src/util/profilePicture.js'

test('privacy and absence errors mean "no picture", not a failure', () => {
  assert.equal(classifyPictureError({ data: 401, message: 'not-authorized' }), 'none')
  assert.equal(classifyPictureError({ data: 404, message: 'item-not-found' }), 'none')
  assert.equal(classifyPictureError({ message: 'item-not-found' }), 'none')
  assert.equal(classifyPictureError({ output: { statusCode: 403 } }), 'none')
})

test('timeouts and dropped connections are transient', () => {
  assert.equal(classifyPictureError({ output: { statusCode: 408 }, message: 'Timed Out' }), 'error')
  assert.equal(classifyPictureError({ output: { statusCode: 428 }, message: 'Connection Closed' }), 'error')
  assert.equal(classifyPictureError(new Error('socket hang up')), 'error')
  assert.equal(classifyPictureError(undefined), 'error')
})

test('a picture or "no picture" stays fresh for a day', () => {
  const now = 10 * PICTURE_TTL_MS
  for (const status of ['ok', 'none']) {
    assert.equal(isPictureFresh({ status, fetched_at: now - PICTURE_TTL_MS + 1 }, now), true)
    assert.equal(isPictureFresh({ status, fetched_at: now - PICTURE_TTL_MS }, now), false)
  }
})

test('a transient failure is retried soon', () => {
  const now = 10 * PICTURE_TTL_MS
  assert.equal(isPictureFresh({ status: 'error', fetched_at: now - PICTURE_ERROR_TTL_MS + 1 }, now), true)
  assert.equal(isPictureFresh({ status: 'error', fetched_at: now - PICTURE_ERROR_TTL_MS }, now), false)
})

test('a missing row is never fresh', () => {
  assert.equal(isPictureFresh(undefined), false)
  assert.equal(isPictureFresh({ status: 'ok' }), false)
})

test('only WhatsApp HTTPS hosts may be fetched', () => {
  assert.equal(isAllowedPictureUrl('https://pps.whatsapp.net/v/t61/abc.jpg?oh=1'), true)
  assert.equal(isAllowedPictureUrl('http://pps.whatsapp.net/v/abc.jpg'), false)
  assert.equal(isAllowedPictureUrl('https://evilwhatsapp.net/abc.jpg'), false)
  assert.equal(isAllowedPictureUrl('https://pps.whatsapp.net.evil.com/abc.jpg'), false)
  assert.equal(isAllowedPictureUrl('https://127.0.0.1/abc.jpg'), false)
  assert.equal(isAllowedPictureUrl('not a url'), false)
  assert.equal(isAllowedPictureUrl(undefined), false)
})

test('people and groups have pictures, other addresses do not', () => {
  assert.equal(isPictureJid('15555550100@s.whatsapp.net'), true)
  assert.equal(isPictureJid('123456789012345@lid'), true)
  assert.equal(isPictureJid('120363000000000000@g.us'), true)
  assert.equal(isPictureJid('15555550100-1600000000@g.us'), true, 'legacy group id')
  assert.equal(isPictureJid('120363000000000000@newsletter'), false)
  assert.equal(isPictureJid('status@broadcast'), false)
  assert.equal(isPictureJid('foo@bar'), false)
  assert.equal(isPictureJid('15555550100:3@s.whatsapp.net'), false, 'device suffix is stripped before this check')
  assert.equal(isPictureJid(null), false)
})

test('only raster image types are accepted', () => {
  assert.equal(pictureMime('image/jpeg'), 'image/jpeg')
  assert.equal(pictureMime('Image/JPEG; charset=binary'), 'image/jpeg')
  assert.equal(pictureMime('image/webp'), 'image/webp')
  assert.equal(pictureMime('image/svg+xml'), null, 'SVG can carry script')
  assert.equal(pictureMime('text/html'), null)
  assert.equal(pictureMime(''), null)
  assert.equal(pictureMime(null), null)
})

test('the limiter never runs more than its cap at once', async () => {
  const limit = createLimiter(2)
  let running = 0
  let peak = 0
  const task = (value) => async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 5))
    running--
    return value
  }

  const results = await Promise.all([1, 2, 3, 4, 5].map(n => limit(task(n))))
  assert.deepEqual(results, [1, 2, 3, 4, 5])
  assert.equal(peak, 2)
  assert.equal(limit.active(), 0)
  assert.equal(limit.pending(), 0)
})

test('a failing task frees its slot and rejects only its own caller', async () => {
  const limit = createLimiter(1)
  const failed = limit(async () => { throw new Error('boom') })
  const after = limit(async () => 'ok')
  await assert.rejects(failed, /boom/)
  assert.equal(await after, 'ok')
})
