import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardReply, nameTokens } from '../src/util/autoreplyGuard.js'
import { writeLlmReply } from '../src/util/autoreplyLlm.js'

const contactNames = nameTokens(['Moneeb Khan', 'Sara Malik', 'Dr. Imran Qureshi', 'Office', 'Ali', 'Bhai Jaan', 'Zainab'])

test('saved names become whole-word tokens of four letters or more, minus common words', () => {
  assert.deepEqual([...contactNames].sort(), ['imran', 'khan', 'malik', 'moneeb', 'qureshi', 'sara', 'zainab'])
})

test('phone numbers are refused in every common shape, dates and times are not', () => {
  for (const text of [
    'Call 03001234567', 'His number is +92 300 1234567', 'try (0300) 123-4567', '0300.123.4567',
    'Reach me at +971 50 123 4567', 'رقم ٠٥٠١٢٣٤٥٦٧', '1234567',
  ]) {
    assert.equal(guardReply(text, {}), 'phone', text)
  }
  for (const text of [
    'Back on 2026-11-26', 'Back on 26.11.2026', 'Free 14.00 - 15.30', 'Around 10:30, maybe 11:45',
    'It costs 1,500,000', 'Room 123456', 'Call me back in 5 minutes',
  ]) {
    assert.equal(guardReply(text, {}), null, text)
  }
})

test('WhatsApp addresses and email addresses are refused', () => {
  for (const text of ['ping 1203630000@g.us', 'it is 15555550101@s.whatsapp.net', 'id 123@lid', 'old 1@c.us', 'status@broadcast', 'x@newsletter', 'see s.whatsapp.net']) {
    assert.equal(guardReply(text, {}), 'wa_address', text)
  }
  assert.equal(guardReply('mail alex.lee+work@example.co.uk', {}), 'email')
  assert.equal(guardReply('Meet @ 5', {}), null)
})

test('links are refused, with or without a scheme', () => {
  for (const text of ['see https://example.com', 'go to www.example', 'wa.me/123', 'look at example.com/page', 'open ftp://host', 'try bit.ly/abc']) {
    assert.equal(guardReply(text, {}), 'url', text)
  }
  for (const text of ['e.g. tomorrow', 'He is at work.Come later', 'ok. See you']) {
    assert.equal(guardReply(text, {}), null, text)
  }
})

test('another contact\'s saved name is refused, the sender\'s own and the owner\'s are not', () => {
  const guard = { contactNames, allowedNames: ['Moneeb Khan'] }
  assert.equal(guardReply('Sara also gets these', guard), 'contact_name')
  assert.equal(guardReply('ask QURESHI sahab', guard), 'contact_name', 'case-insensitive')
  assert.equal(guardReply('Hi Moneeb, Alex is busy', guard), null, 'the sender may be named')
  assert.equal(guardReply('Khan sahab will call', guard), null, 'a token the sender shares is theirs')
  assert.equal(guardReply('Sarah is fine', guard), null, 'whole words only')
  assert.equal(guardReply('Ali will reply', guard), null, 'short tokens never count')
  assert.equal(guardReply('He is in the office', guard), null, 'common words never count')
  assert.equal(guardReply('Zainab knows', { ...guard, instructions: 'If asked, say Zainab is with me.' }), null, 'a name the owner wrote is allowed')
})

test('a copy of eight words in a row from the instructions is refused', () => {
  const instructions = 'Only answer saved colleagues and never mention the weekend plans with the family'
  assert.equal(guardReply('I was told to only answer saved colleagues and never mention the weekend', { instructions }), 'instructions')
  assert.equal(guardReply('He will answer you soon, sorry', { instructions }), null)
  assert.equal(guardReply('never mention the weekend', { instructions: 'short' }), null)
})

const response = { model: 'chat', instructions: 'Say Alex is busy.', context_messages: 0, max_chars: 200 }
const gatewaySaying = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
const base = { response, status: null, nowMs: Date.parse('2026-11-26T04:00:00Z'), timezone: 'UTC', senderName: 'Moneeb Khan', history: [], incoming: { type: 'text', text: 'who else?' }, gateway: { url: 'http://gw.test/v1', apiKey: 'k' } }

test('a blocked reply is replaced by the fallback, and its text is never returned', async () => {
  const result = await writeLlmReply({ ...base, fallbackText: 'Alex will reply soon.', guard: { contactNames }, fetchImpl: gatewaySaying('Sara gets these too, her number is 03001234567') })
  assert.deepEqual(result, { text: 'Alex will reply soon.', generated: false, reason: 'llm_blocked:phone' })

  const skipped = await writeLlmReply({ ...base, fallbackText: null, guard: { contactNames }, fetchImpl: gatewaySaying('Sara gets these too') })
  assert.deepEqual(skipped, { text: null, generated: false, reason: 'llm_blocked:contact_name' })
})

test('a clean reply goes through, naming the sender and the owner', async () => {
  const result = await writeLlmReply({ ...base, ownerName: 'Alex', fallbackText: 'x', guard: { contactNames: nameTokens(['Alex Doe', 'Moneeb Khan', 'Sara Malik']), allowedNames: [] }, fetchImpl: gatewaySaying('Hi Moneeb, Alex is busy right now.') })
  assert.deepEqual(result, { text: 'Hi Moneeb, Alex is busy right now.', generated: true, reason: 'llm' })
})
