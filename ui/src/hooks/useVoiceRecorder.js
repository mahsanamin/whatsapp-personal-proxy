import { useState, useRef, useCallback, useEffect } from 'react'

// The server re-encodes every voice note to Ogg/Opus, so any of these works.
// Ogg first only because it is the smallest step for the server; Chrome falls
// through to webm and Safari to mp4.
const PREFERRED_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMimeType() {
  return PREFERRED_TYPES.find(t => MediaRecorder.isTypeSupported?.(t)) || ''
}

export const voiceRecordingSupported = typeof window !== 'undefined' &&
  Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'

/**
 * Record from the microphone. start() asks for permission and begins; stop()
 * resolves with the recording; cancel() throws it away. The microphone is
 * released after either, so the browser's recording indicator goes off.
 */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const startingRef = useRef(false)

  const release = useCallback(() => {
    clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
    setRecording(false)
    setElapsed(0)
  }, [])

  const start = useCallback(async () => {
    // A second click while the permission prompt is open must not open a
    // second microphone stream.
    if (recorderRef.current || startingRef.current) return
    startingRef.current = true
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } finally {
      startingRef.current = false
    }
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
    streamRef.current = stream
    recorderRef.current = recorder
    recorder.start()

    const startedAt = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250)
    setRecording(true)
  }, [])

  const stop = useCallback(() => new Promise((resolve) => {
    const recorder = recorderRef.current
    if (!recorder) return resolve(null)
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      release()
      resolve(blob.size ? blob : null)
    }
    recorder.stop()
  }), [release])

  const cancel = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder) {
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
    }
    release()
  }, [release])

  // Leaving the page mid-recording must not leave the microphone open.
  useEffect(() => cancel, [cancel])

  return { recording, elapsed, start, stop, cancel }
}

export function formatElapsed(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
