import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toJid, isGroup, channelType, jidUser } from '../src/util/jid.js'

test('toJid normalises phone numbers to a WhatsApp JID', () => {
  assert.equal(toJid('+971501234567'), '971501234567@s.whatsapp.net')
  assert.equal(toJid('971501234567'), '971501234567@s.whatsapp.net')
  assert.equal(toJid(' +971 50 123-4567 '), '971501234567@s.whatsapp.net')
})

test('toJid passes an existing JID through untouched', () => {
  assert.equal(toJid('120363000000000000@g.us'), '120363000000000000@g.us')
  assert.equal(toJid('12345@lid'), '12345@lid')
})

test('toJid rejects input that is neither a number nor a JID', () => {
  assert.equal(toJid('Mum'), null)
  assert.equal(toJid(''), null)
  assert.equal(toJid('   '), null)
  assert.equal(toJid('123'), null, 'too short to be a phone number')
  assert.equal(toJid(undefined), null)
  assert.equal(toJid(12345), null)
})

test('isGroup only matches @g.us', () => {
  assert.equal(isGroup('120363000000000000@g.us'), true)
  assert.equal(isGroup('971501234567@s.whatsapp.net'), false)
  assert.equal(isGroup(null), false)
})

test('jidUser treats a linked-device JID as the same phone-number user', () => {
  assert.equal(jidUser('971501234567:32@s.whatsapp.net'), '971501234567')
  assert.equal(jidUser('971501234567@s.whatsapp.net'), '971501234567')
  assert.equal(jidUser('+971501234567'), null)
  assert.equal(jidUser('971501234567@example.com'), null)
  assert.equal(jidUser(null), null)
})

test('channelType classifies every JID flavour', () => {
  assert.equal(channelType('120363000000000000@g.us'), 'group')
  assert.equal(channelType('120363000000000000@newsletter'), 'channel')
  assert.equal(channelType('971501234567@s.whatsapp.net'), 'dm')
  assert.equal(channelType('99887766@lid'), 'dm')
})
