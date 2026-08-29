import { db } from './index.js'

/**
 * SQLite-backed session store for @fastify/session.
 *
 * The default store is in-memory, so every server restart invalidated every
 * console session and signed the owner out. Sessions live in the same database
 * as everything else, so they survive a redeploy and are revoked by deleting a
 * row.
 */
export class SqliteSessionStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs

    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(`
        INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    }

    // Drop anything already expired at boot, then hourly.
    this.sweep()
    this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000)
    this.timer.unref?.()
  }

  sweep() {
    try { this.stmts.sweep.run(Date.now()) } catch (_) {}
  }

  expiryFor(session) {
    const expires = session?.cookie?.expires
    if (expires) {
      const at = new Date(expires).getTime()
      if (Number.isFinite(at)) return at
    }
    return Date.now() + this.ttlMs
  }

  set(sid, session, callback) {
    try {
      this.stmts.set.run(sid, JSON.stringify(session), this.expiryFor(session))
      callback()
    } catch (err) {
      callback(err)
    }
  }

  get(sid, callback) {
    try {
      const row = this.stmts.get.get(sid)
      if (!row) return callback(null, null)
      if (row.expires_at <= Date.now()) {
        this.stmts.destroy.run(sid)
        return callback(null, null)
      }
      callback(null, JSON.parse(row.data))
    } catch (err) {
      callback(err)
    }
  }

  destroy(sid, callback) {
    try {
      this.stmts.destroy.run(sid)
      callback()
    } catch (err) {
      callback(err)
    }
  }
}
