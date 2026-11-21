/**
 * Phone numbers on a shared contact card.
 *
 * WhatsApp sends a contact as a display name plus a vCard, and the number only
 * lives in the vCard. Keeping just the name meant a forwarded contact arrived
 * with no way to reach the person.
 */
export function vcardPhones(vcard) {
  if (typeof vcard !== 'string') return []
  // vCard folds long lines by starting the continuation with a space or tab.
  const lines = vcard.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const phones = []
  for (const line of lines) {
    // Apple clients group properties, so the line can be `item1.TEL;...`.
    const match = /^(?:[\w-]+\.)?TEL\b([^:]*):(.*)$/i.exec(line)
    if (!match) continue
    const waid = /(?:^|;)waid=(\d+)/i.exec(match[1])?.[1]
    const value = match[2].trim() || (waid ? `+${waid}` : '')
    if (value && !phones.includes(value)) phones.push(value)
  }
  return phones
}

/** `Name (+1 555 0100)` for each card, joined; null when there is nothing. */
export function describeContacts(cards) {
  const parts = []
  for (const card of cards || []) {
    const name = card?.displayName?.trim() || ''
    const phones = vcardPhones(card?.vcard)
    if (name && phones.length) parts.push(`${name} (${phones.join(', ')})`)
    else if (name || phones.length) parts.push(name || phones.join(', '))
  }
  return parts.length ? parts.join(', ') : null
}
