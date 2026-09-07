/** Add a column only if it is missing, so migrations stay idempotent. */
function addColumn(db, table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all()
  if (existing.some(c => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      scopes      TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used   DATETIME,
      revoked     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS whitelist (
      id          TEXT PRIMARY KEY,
      jid         TEXT NOT NULL UNIQUE,
      label       TEXT,
      added_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tabs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#6366f1',
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_meta (
      jid           TEXT PRIMARY KEY,
      display_name  TEXT,
      tab_id        TEXT REFERENCES tabs(id) ON DELETE SET NULL,
      is_muted      INTEGER DEFAULT 0,
      is_archived   INTEGER DEFAULT 0,
      priority      INTEGER DEFAULT 0,
      notes         TEXT,
      last_summary  TEXT,
      summary_at    DATETIME,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      jid           TEXT NOT NULL,
      from_jid      TEXT,
      body          TEXT,
      type          TEXT DEFAULT 'text',
      media_mime    TEXT,
      media_size    INTEGER,
      media_sha256  TEXT,
      media_key     TEXT,
      media_url     TEXT,
      media_saved   INTEGER DEFAULT 0,
      media_path    TEXT,
      timestamp     DATETIME NOT NULL,
      is_from_me    INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'sent',
      quoted_id     TEXT,
      raw_json      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_type   ON messages(type);

    -- LID to phone number mapping (WhatsApp multi-device uses LID for chats, PN for contacts)
    CREATE TABLE IF NOT EXISTS lid_map (
      lid         TEXT PRIMARY KEY,
      pn          TEXT NOT NULL,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lid_map_pn ON lid_map(pn);

    -- Web console sessions. Kept in SQLite rather than in memory so a server
    -- restart (a redeploy, a crash, a config change) does not sign the owner
    -- out of the console.
    CREATE TABLE IF NOT EXISTS sessions (
      sid         TEXT PRIMARY KEY,
      data        TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `)

  // Read state. Incoming messages are stored with status 'sent' and WhatsApp
  // never tells us the owner read them, so "unread" has to be tracked here:
  // anything newer than last_read_at is unread. Without this, unread_count is
  // simply every message the contact has ever sent.
  addColumn(db, 'channel_meta', 'last_read_at', 'DATETIME')
  addColumn(db, 'channel_meta', 'name_rank', 'INTEGER NOT NULL DEFAULT 0')

  // Whether a message @-mentions the owner. Computed at ingest from the
  // message's contextInfo, because parsing raw_json per query is far too slow
  // to do across a whole mailbox.
  addColumn(db, 'messages', 'mentions_me', 'INTEGER DEFAULT 0')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_mentions ON messages(mentions_me) WHERE mentions_me = 1;
    CREATE INDEX IF NOT EXISTS idx_messages_quoted   ON messages(quoted_id);
  `)
}
