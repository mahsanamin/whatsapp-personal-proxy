import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TRANSCODE_ARGS,
  VOICE_MIMETYPE,
  WAVEFORM_BARS,
  durationSeconds,
  pcmSamples,
  waveformFromSamples,
} from '../src/util/voiceNote.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('voice notes are encoded as Opus in Ogg, the only format phones play inline', () => {
  assert.equal(VOICE_MIMETYPE, 'audio/ogg; codecs=opus')
  const arg = (flag) => TRANSCODE_ARGS[TRANSCODE_ARGS.indexOf(flag) + 1]
  assert.equal(arg('-c:a'), 'libopus')
  assert.equal(arg('-f'), 'ogg')
  assert.equal(arg('-ac'), '1')
})

test('waveform has 64 bars scaled so the loudest is 100', () => {
  const samples = new Int16Array(64 * 10)
  for (let bar = 0; bar < 64; bar++) {
    for (let j = 0; j < 10; j++) samples[bar * 10 + j] = (j % 2 ? -1 : 1) * bar * 100
  }
  const wave = waveformFromSamples(samples)
  assert.equal(wave.length, WAVEFORM_BARS)
  assert.equal(wave[0], 0)
  assert.equal(wave[63], 100)
  assert.equal(wave[32], Math.floor((100 * 32) / 63))
})

test('silence and too-short clips give a flat waveform, not NaN', () => {
  assert.deepEqual([...waveformFromSamples(new Int16Array(1000))], new Array(64).fill(0))
  assert.deepEqual([...waveformFromSamples(new Int16Array(10))], new Array(64).fill(0))
})

test('duration rounds to whole seconds and is never zero', () => {
  assert.equal(durationSeconds(8000 * 5, 8000), 5)
  assert.equal(durationSeconds(8000 * 2.6, 8000), 3)
  assert.equal(durationSeconds(0, 8000), 1)
})

test('PCM is read as signed 16-bit little-endian, even from an odd offset', () => {
  const raw = Buffer.from([0, 0x10, 0x00, 0xff, 0xff])
  const samples = pcmSamples(raw.subarray(1))
  assert.deepEqual([...samples], [0x10, -1])
})

test('the waveform is put back after Baileys builds the voice note', () => {
  // Baileys overwrites any caller waveform with undefined when its optional
  // decoder is missing, so going back to sock.sendMessage loses the waveform.
  const src = read('../src/api/media.js')
  assert.ok(src.includes('generateWAMessage('), 'voice notes must be built, not sent via sendMessage')
  assert.ok(src.includes('audioMessage.waveform = note.waveform'), 'waveform is no longer restored')
  assert.ok(src.includes('prepareVoiceNote(buffer)'), 'voice uploads must be re-encoded')
})

test('the server image installs ffmpeg', () => {
  const dockerfile = read('../Dockerfile')
  assert.match(dockerfile, /apk add[^\n]*\bffmpeg\b/)
})

test('the console sends recordings as voice notes and never to the wrong chat', () => {
  const src = read('../../ui/src/pages/Workspace.jsx')
  assert.ok(src.includes("voice: 'true'"), 'a recording must go out as a voice note, not an audio file')
  assert.ok(
    src.includes('useEffect(() => { voice.cancel() }, [activeJid, voice.cancel])'),
    'switching chats mid-recording must discard it, or it is sent to whoever is open next',
  )
})
