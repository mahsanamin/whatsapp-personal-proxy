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

    -- Unread snapshots/deltas are independent of how much history is mirrored.
    CREATE TABLE IF NOT EXISTS conversation_unread (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL UNIQUE,
      unread_count INTEGER NOT NULL DEFAULT 0,
      known INTEGER NOT NULL DEFAULT 0,
      marked_unread INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      as_of INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unread_counter_events (
      message_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS unread_messages (
      message_id TEXT PRIMARY KEY,
      jid TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      mentions_me INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_unread_messages_jid_ts ON unread_messages(jid, timestamp);


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

  // Keep the read cursor separately from outgoing delivery receipts.
  // Counts come from conversation_unread, not the size of the message archive.
  addColumn(db, 'channel_meta', 'last_read_at', 'DATETIME')
  addColumn(db, 'unread_messages', 'is_read', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'channel_meta', 'name_rank', 'INTEGER NOT NULL DEFAULT 0')

  // Whether a message @-mentions the owner. Computed at ingest from the
  // message's contextInfo, because parsing raw_json per query is far too slow
  // to do across a whole mailbox.
  addColumn(db, 'messages', 'mentions_me', 'INTEGER DEFAULT 0')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_mentions ON messages(mentions_me) WHERE mentions_me = 1;
    CREATE INDEX IF NOT EXISTS idx_messages_quoted   ON messages(quoted_id);
  `)

  // Auto-reply. The template is kept as the text that was uploaded, so a
  // download gives back exactly what was written, in the author's own field
  // order and formatting. The incoming message body is never copied here:
  // messages already holds it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autoreply_rulesets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      version     TEXT,
      description TEXT,
      template    TEXT NOT NULL,
      mode        TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('off', 'dry_run', 'live')),
      active      INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS autoreply_settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS autoreply_decisions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      at                INTEGER NOT NULL,
      chat_jid          TEXT NOT NULL,
      message_id        TEXT,
      ruleset_id        TEXT,
      ruleset_name      TEXT,
      rule_id           TEXT,
      action            TEXT NOT NULL,
      reason            TEXT,
      reply_text        TEXT,
      reply_message_id  TEXT,
      -- A short hash of the incoming text, so the same question is not
      -- answered twice in one conversation. Never the text itself.
      text_hash         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_autoreply_decisions_chat ON autoreply_decisions(chat_jid, at);
    CREATE INDEX IF NOT EXISTS idx_autoreply_decisions_at   ON autoreply_decisions(at);
    CREATE INDEX IF NOT EXISTS idx_autoreply_decisions_reply ON autoreply_decisions(reply_message_id);

    -- At most one answer per message, even when WhatsApp redelivers it.
    CREATE TABLE IF NOT EXISTS autoreply_processed (
      message_id  TEXT PRIMARY KEY,
      at          INTEGER NOT NULL
    );

    -- Per-contact state: mutes, the current conversation, and the signals
    -- that spot floods and other bots. Keyed by the chat's canonical JID, or
    -- "<group>|<sender>" for one person inside a group.
    CREATE TABLE IF NOT EXISTS autoreply_contacts (
      contact_key              TEXT PRIMARY KEY,
      muted_until              INTEGER,
      mute_reason              TEXT,
      last_manual_at           INTEGER,
      last_incoming_at         INTEGER,
      conversation_started_at  INTEGER,
      loop_streak              INTEGER NOT NULL DEFAULT 0,
      last_sent_at             INTEGER,
      loop_checked_sent_at     INTEGER,
      updated_at               INTEGER NOT NULL
    );
  `)
}
