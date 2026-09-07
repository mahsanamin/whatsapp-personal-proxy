// A message's pushName describes its author, never its recipient.
export function incomingContact(raw) {
  const key = raw?.key
  if (!key || key.fromMe || !raw.pushName) return null
  const jid = key.participant || key.remoteJid
  if (typeof jid !== 'string' || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid)) return null
  return { jid: jid.replace(/:\d+@/, '@'), name: raw.pushName }
}
