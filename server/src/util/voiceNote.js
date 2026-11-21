import { spawn } from 'node:child_process'

// WhatsApp phones only play a voice note inline when it is Opus in an Ogg
// container. Browsers record webm (Chrome), ogg (Firefox) or mp4/AAC (Safari),
// so every voice upload is re-encoded rather than trusted. Mono at 48 kHz and a
// speech-tuned bitrate matches what the phone apps themselves produce.
export const VOICE_MIMETYPE = 'audio/ogg; codecs=opus'
export const TRANSCODE_ARGS = [
  '-hide_banner', '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vn', '-ac', '1', '-ar', '48000',
  '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
  '-f', 'ogg', 'pipe:1',
]

// The waveform only needs a coarse loudness envelope, so decode at a low rate.
export const PCM_RATE = 8000
export const PCM_ARGS = [
  '-hide_banner', '-loglevel', 'error',
  '-i', 'pipe:0',
  '-ac', '1', '-ar', String(PCM_RATE),
  '-f', 's16le', 'pipe:1',
]

// WhatsApp draws 64 bars, each 0-100.
export const WAVEFORM_BARS = 64

/** Read a raw s16le buffer as signed samples. */
export function pcmSamples(buffer) {
  // Int16Array needs an even offset; a pooled Buffer slice does not promise one.
  if (buffer.byteOffset % 2) buffer = Buffer.from(buffer)
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2))
}

/**
 * Average absolute loudness per bar, scaled so the loudest bar is 100. This is
 * the same shape Baileys would compute if its optional decoder were installed.
 * A silent or too-short clip gives flat zeros rather than NaN, which WhatsApp
 * renders as a plain line.
 */
export function waveformFromSamples(samples, bars = WAVEFORM_BARS) {
  const out = new Uint8Array(bars)
  const blockSize = Math.floor(samples.length / bars)
  if (blockSize === 0) return out

  const levels = new Array(bars)
  for (let i = 0; i < bars; i++) {
    let sum = 0
    const start = i * blockSize
    for (let j = 0; j < blockSize; j++) sum += Math.abs(samples[start + j])
    levels[i] = sum / blockSize
  }
  const max = Math.max(...levels)
  if (max === 0) return out
  for (let i = 0; i < bars; i++) out[i] = Math.floor((100 * levels[i]) / max)
  return out
}

/** Whole seconds, never zero: WhatsApp shows 0:00 for a clip it thinks is empty. */
export function durationSeconds(sampleCount, rate = PCM_RATE) {
  return Math.max(1, Math.round(sampleCount / rate))
}

/** Pipe bytes through ffmpeg and collect stdout. */
export function runFfmpeg(args, input, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.stdout.on('data', (c) => out.push(c))
    proc.stderr.on('data', (c) => err.push(c))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed in the server image') : e)
    })
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve(Buffer.concat(out))
      const detail = Buffer.concat(err).toString().trim().split('\n').pop()
      reject(new Error(`ffmpeg failed (${signal || code}): ${detail || 'no output'}`))
    })
    // ffmpeg may exit before reading all input on a bad file; that EPIPE is
    // reported through the exit code above, so it must not crash the process.
    proc.stdin.on('error', () => {})
    proc.stdin.end(input)
  })
}

/**
 * Turn any recorded audio into a WhatsApp voice note: Ogg/Opus bytes plus the
 * duration and waveform the phone needs to draw the bubble.
 */
export async function prepareVoiceNote(input) {
  const audio = await runFfmpeg(TRANSCODE_ARGS, input)
  const samples = pcmSamples(await runFfmpeg(PCM_ARGS, audio))
  return {
    audio,
    mimetype: VOICE_MIMETYPE,
    seconds: durationSeconds(samples.length),
    waveform: waveformFromSamples(samples),
  }
}
