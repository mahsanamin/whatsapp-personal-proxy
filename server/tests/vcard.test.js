import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vcardPhones, describeContacts } from '../src/util/vcard.js'

const card = (tel) => `BEGIN:VCARD\nVERSION:3.0\nN:;Sam;;;\nFN:Sam\n${tel}\nEND:VCARD`

test('vcardPhones reads the number WhatsApp puts on a shared contact', () => {
  assert.deepEqual(vcardPhones(card('TEL;type=CELL;type=VOICE;waid=15550100:+1 555 0100')), ['+1 555 0100'])
})

test('vcardPhones reads grouped lines written by Apple clients', () => {
  assert.deepEqual(vcardPhones(card('item1.TEL;waid=15550100:+1 555 0100\nitem1.X-ABLabel:Phone')), ['+1 555 0100'])
})

test('vcardPhones falls back to the waid when the value is empty', () => {
  assert.deepEqual(vcardPhones(card('TEL;waid=15550100:')), ['+15550100'])
})

test('vcardPhones keeps every distinct number and ignores folded photo data', () => {
  const vcard = card('TEL;type=CELL:+1 555 0100\nTEL;type=WORK:+1 555 0199\nTEL:+1 555 0100\nPHOTO;BASE64:abc\n TEL:notreal')
  assert.deepEqual(vcardPhones(vcard), ['+1 555 0100', '+1 555 0199'])
})

test('vcardPhones handles CRLF and missing input', () => {
  assert.deepEqual(vcardPhones('BEGIN:VCARD\r\nTEL:+1 555 0100\r\nEND:VCARD'), ['+1 555 0100'])
  assert.deepEqual(vcardPhones(undefined), [])
  assert.deepEqual(vcardPhones('BEGIN:VCARD\nFN:Sam\nEND:VCARD'), [])
})

test('describeContacts puts the number next to the name', () => {
  assert.equal(describeContacts([{ displayName: 'Sam', vcard: card('TEL:+1 555 0100') }]), 'Sam (+1 555 0100)')
})

test('describeContacts joins several cards and tolerates missing parts', () => {
  assert.equal(describeContacts([
    { displayName: 'Sam', vcard: card('TEL:+1 555 0100') },
    { displayName: 'Lee' },
    { vcard: card('TEL:+1 555 0199') },
  ]), 'Sam (+1 555 0100), Lee, +1 555 0199')
  assert.equal(describeContacts([]), null)
  assert.equal(describeContacts(undefined), null)
})
