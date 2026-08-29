import { BufferJSON } from '@whiskeysockets/baileys'
import { db } from '../db/index.js'

/**
 * Rehydrate a stored message into the object Baileys expects.
 *
 * Quoting, reacting, editing and deleting all need the original message key,
 * which is why every row keeps its raw payload serialised with
 * BufferJSON.replacer — the binary fields inside it must survive the round trip.
 */
export function loadRawMessage(id) {
  if (!id) return null
  const row = db.prepare('SELECT raw_json FROM messages WHERE id = ?').get(id)
  if (!row?.raw_json) return null
  try {
    return JSON.parse(row.raw_json, BufferJSON.reviver)
  } catch (_) {
    return null
  }
}

/** The message key, which is what react/edit/delete operate on. */
export function loadMessageKey(id) {
  const raw = loadRawMessage(id)
  return raw?.key || null
}

/** Metadata a caller needs to decide whether an operation is legal. */
export function loadMessageMeta(id) {
  if (!id) return null
  return db.prepare('SELECT id, jid, is_from_me, type, timestamp FROM messages WHERE id = ?').get(id) || null
}
