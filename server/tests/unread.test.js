import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../src/db/migrations.js'
import { applyUnreadUpdate, unreadState, markUnreadThrough, recordUnreadMessage, unreadMentions, applyUnreadReceipt } from '../src/db/unread.js'

const pn = '15555550101@s.whatsapp.net'
const lid = '15555550201@lid'
const jids = [pn, lid]
function database() {
  const db = new Database(':memory:')
  runMigrations(db)
  for (const jid of jids) db.prepare('INSERT INTO channel_meta (jid) VALUES (?)').run(jid)
  return db
}
function message(id, overrides = {}) {
  return { id, jid: lid, timestamp: '2026-01-02T00:00:00.000Z', type: 'text', is_from_me: 0, mentions_me: 0, ...overrides }
}

test('an archive without saved read state is unknown, not thousands of unread messages', () => {
  const db = database()
  try {
    db.prepare('INSERT INTO messages (id, jid, timestamp) VALUES (?, ?, ?)').run('old', lid, '2020-01-01T00:00:00Z')
    assert.equal(unreadState(db, jids).unread_count, null)
    assert.equal(unreadState(db, jids).unread_known, false)
    applyUnreadUpdate(db, jids, { unreadCount: 2 })
    assert.equal(unreadState(db, jids).unread_count, null)
    assert.equal(unreadState(db, jids).unread_lower_bound, 2)
  } finally { db.close() }
})

test('history counts are snapshots; live counts are deltas; replayed history is ignored', () => {
  const db = database()
  try {
    const snapshot = { unreadCount: 8, conversationTimestamp: 1767225600 }
    applyUnreadUpdate(db, jids, snapshot, 'history')
    assert.equal(unreadState(db, jids).unread_count, 8)
    applyUnreadUpdate(db, [lid, pn], snapshot, 'history')
    assert.equal(unreadState(db, jids).unread_count, 8)
    applyUnreadUpdate(db, [lid, pn], { unreadCount: 1 })
    applyUnreadUpdate(db, jids, { unreadCount: 2 })
    assert.equal(unreadState(db, jids).unread_count, 11)
    applyUnreadUpdate(db, jids, { ...snapshot, unreadCount: 99 }, 'history')
    assert.equal(unreadState(db, jids).unread_count, 11)
  } finally { db.close() }
})

test('read updates clear counts and marked-unread is a flag, never a negative count', () => {
  const db = database()
  try {
    applyUnreadUpdate(db, jids, { unreadCount: 4 }, 'history')
    applyUnreadUpdate(db, jids, { unreadCount: 0 })
    assert.equal(unreadState(db, jids).unread_count, 0)
    applyUnreadUpdate(db, jids, { unreadCount: -1 })
    assert.equal(unreadState(db, jids).unread_count, 0)
    assert.equal(unreadState(db, jids).marked_unread, true)
    applyUnreadUpdate(db, jids, { unreadCount: null })
    assert.equal(unreadState(db, jids).marked_unread, false)
    assert.equal(unreadState(db, jids).unread_count, 0)
  } finally { db.close() }
})

test('reading a rendered page preserves newer arrivals and does not count reactions or outgoing messages', () => {
  const db = database()
  try {
    applyUnreadUpdate(db, jids, { unreadCount: 5 }, 'history')
    recordUnreadMessage(db, message('old', { timestamp: '2026-01-01T00:00:00.000Z' }))
    recordUnreadMessage(db, message('new', { mentions_me: 1 }))
    recordUnreadMessage(db, message('new', { mentions_me: 1 }))
    recordUnreadMessage(db, message('reaction', { type: 'reaction' }))
    recordUnreadMessage(db, message('system', { type: 'unknown' }))
    recordUnreadMessage(db, message('outgoing', { is_from_me: 1 }))
    assert.equal(markUnreadThrough(db, jids, '2026-01-01T12:00:00.000Z'), 1)
    assert.equal(unreadState(db, jids).unread_count, 1)
    assert.equal(unreadMentions(db, jids), 1)
    assert.equal(markUnreadThrough(db, jids, '2026-01-03T00:00:00.000Z'), 0)
    assert.equal(unreadState(db, jids).unread_known, true)
    assert.equal(unreadMentions(db, jids), 0)
    applyUnreadUpdate(db, jids, { unreadCount: 50 }, 'history')
    assert.equal(unreadState(db, jids).unread_count, 0)
  } finally { db.close() }
})

test('missing or malformed counters never reset a known count', () => {
  const db = database()
  try {
    applyUnreadUpdate(db, jids, { unreadCount: 3 }, 'history')
    for (const unreadCount of [undefined, '4', {}, -2, 1.5]) {
      assert.equal(applyUnreadUpdate(db, jids, { unreadCount }), false)
    }
    assert.equal(unreadState(db, jids).unread_count, 3)
  } finally { db.close() }
})

test('a genuinely newer snapshot reconciles messages received while the proxy was offline', () => {
  const db = database()
  const realNow = Date.now
  try {
    Date.now = () => Date.parse('2026-01-01T00:00:00Z')
    markUnreadThrough(db, jids, '2026-01-01T00:00:00.000Z')
    Date.now = () => Date.parse('2026-01-03T00:00:00Z')
    applyUnreadUpdate(db, jids, { unreadCount: 5, conversationTimestamp: Date.parse('2026-01-02T00:00:00Z') / 1000 }, 'history')
    assert.equal(unreadState(db, jids).unread_count, 5)
  } finally { Date.now = realNow; db.close() }
})

test('individual incoming read receipts decrement once and unrelated receipts do nothing', () => {
  const db = database()
  try {
    applyUnreadUpdate(db, jids, { unreadCount: 2 }, 'history')
    recordUnreadMessage(db, message('incoming'))
    assert.equal(applyUnreadReceipt(db, jids, 'incoming'), true)
    assert.equal(unreadState(db, jids).unread_count, 1)
    assert.equal(applyUnreadReceipt(db, jids, 'incoming'), false)
    assert.equal(applyUnreadReceipt(db, jids, 'outgoing-or-unknown'), false)
    assert.equal(unreadState(db, jids).unread_count, 1)
  } finally { db.close() }
})

test('replayed live message counters are not counted twice when IDs are supplied', () => {
  const db = database()
  try {
    applyUnreadUpdate(db, jids, { unreadCount: 0 }, 'history')
    const update = { unreadCount: 1, messages: [{ message: { key: { id: 'live-message', fromMe: false } } }] }
    assert.equal(applyUnreadUpdate(db, jids, update), true)
    assert.equal(applyUnreadUpdate(db, jids, update), false)
    assert.equal(unreadState(db, jids).unread_count, 1)
  } finally { db.close() }
})
