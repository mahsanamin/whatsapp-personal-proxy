const PN_SUFFIX = '@s.whatsapp.net'
const LID_SUFFIX = '@lid'
const GROUP_SUFFIX = '@g.us'
const NEWSLETTER_SUFFIX = '@newsletter'

/**
 * Turn user input into a WhatsApp JID.
 *   "+971501234567" / "971 50 123-4567" -> "971501234567@s.whatsapp.net"
 *   anything already containing "@"      -> returned untouched
 * Returns null when the input is neither a JID nor a phone number.
 */
export function toJid(input) {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value) return null
  if (value.includes('@')) return value
  const digits = value.replace(/[\s()-]/g, '').replace(/^\+/, '')
  if (!/^\d{5,20}$/.test(digits)) return null
  return `${digits}${PN_SUFFIX}`
}

export function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith(GROUP_SUFFIX)
}

// Baileys identifies a linked device as `number:device@s.whatsapp.net` while
// API callers normally use `number@s.whatsapp.net`. Both belong to the same
// WhatsApp user, so comparisons must ignore the device suffix.
export function jidUser(jid) {
  if (typeof jid !== 'string') return null
  const parts = jid.split('@')
  if (parts.length !== 2 || ![PN_SUFFIX.slice(1), LID_SUFFIX.slice(1)].includes(parts[1])) return null
  const user = parts[0].split(':')[0]
  return /^\d+$/.test(user) ? user : null
}

export function channelType(jid) {
  if (isGroup(jid)) return 'group'
  if (typeof jid === 'string' && jid.endsWith(NEWSLETTER_SUFFIX)) return 'channel'
  return 'dm'
}

export { PN_SUFFIX, LID_SUFFIX, GROUP_SUFFIX, NEWSLETTER_SUFFIX }
