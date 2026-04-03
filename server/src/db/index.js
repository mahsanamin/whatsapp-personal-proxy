import Database from 'better-sqlite3'
import { config } from '../config.js'
import { runMigrations } from './migrations.js'

const db = new Database(config.dbPath)

// WAL mode: allows concurrent reads while Baileys is writing messages
db.pragma('journal_mode = WAL')
// NORMAL is safe with WAL and significantly faster than FULL
db.pragma('synchronous = NORMAL')
// Enforce FK constraints (SQLite disables these by default)
db.pragma('foreign_keys = ON')
// 32MB page cache — helps with message history queries
db.pragma('cache_size = -32000')

runMigrations(db)

export { db }
