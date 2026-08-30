import { downloadMediaMessage, BufferJSON } from '@whiskeysockets/baileys'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import { config } from '../config.js'
import { getSock } from './client.js'
import { db } from '../db/index.js'

const logger = pino({ level: 'warn' })

export async function downloadMediaOnDemand(msgRow, opts = {}) {
  const ext = mimeToExt(msgRow.media_mime)
  const filename = `${msgRow.media_sha256 || msgRow.id}.${ext}`
  const savePath = msgRow.media_path || path.join(config.mediaPath, filename)

  if (existsSync(savePath)) {
    try {
      const buffer = await readFile(savePath)
      return { buffer, savePath }
    } catch (_) {}
  }

  // Reconstruct the raw message object from stored JSON
  let raw = JSON.parse(msgRow.raw_json, BufferJSON.reviver)
  const sock = getSock()

  let buffer
  try {
    buffer = await downloadMediaMessage(raw, 'buffer', {})
  } catch (err) {
    const status = err?.response?.status || err?.status
    if (sock && (status === 403 || status === 404 || status === 410)) {
      try {
        raw = await sock.updateMediaMessage(raw)
        db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(
          JSON.stringify(raw, BufferJSON.replacer),
          msgRow.id
        )
        buffer = await downloadMediaMessage(raw, 'buffer', {})
      } catch (retryErr) {
        console.error('Failed to re-fetch expired media via socket:', retryErr)
        throw err
      }
    } else {
      throw err
    }
  }

  if (buffer) {
    try {
      await mkdir(config.mediaPath, { recursive: true })
      await writeFile(savePath, buffer)
      db.prepare(
        'UPDATE messages SET media_saved = 1, media_path = ? WHERE id = ?'
      ).run(savePath, msgRow.id)
    } catch (err) {
      // Non-fatal if caching fails
    }
  }

  return { buffer, savePath }
}

function mimeToExt(mime) {
  const baseMime = (mime || '').split(';')[0].trim().toLowerCase()
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }
  return map[baseMime] || 'bin'
}
