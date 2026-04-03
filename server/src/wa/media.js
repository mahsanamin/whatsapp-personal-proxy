import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { BufferJSON } from '@whiskeysockets/baileys'

export async function downloadMediaOnDemand(msgRow, opts = {}) {
  // Reconstruct the raw message object from stored JSON
  const raw = JSON.parse(msgRow.raw_json, BufferJSON.reviver)

  const buffer = await downloadMediaMessage(
    raw,
    'buffer',
    {},
  )

  if (opts.saveToDisk) {
    const ext = mimeToExt(msgRow.media_mime)
    const filename = `${msgRow.media_sha256 || msgRow.id}.${ext}`
    const savePath = path.join(config.mediaPath, filename)
    await mkdir(config.mediaPath, { recursive: true })
    await writeFile(savePath, buffer)
    return { buffer, savePath }
  }

  return { buffer }
}

function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }
  return map[mime] || 'bin'
}
