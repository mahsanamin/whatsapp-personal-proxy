# WhatsApp Personal Proxy (wpp)
## Claude Code Project Specification

You are building **WhatsApp Personal Proxy (wpp)**, a self-hosted WhatsApp power-user workspace. It is a full-stack application managed entirely by Docker Compose. Read this entire file before writing a single line of code.

---

## Project Goal

A self-hosted WhatsApp gateway and workspace manager that provides:
- A **Web UI** for human control (QR auth, channel browsing, messaging, tab organization, token management)
- A **REST + WebSocket API** for programmatic access by bots, agents, and automations
- A **CLI (`wpp`)** that uses the same API tokens as the programmatic API
- **No automatic media saving** — media metadata is stored, files are only saved on explicit user request

---

## Repository Structure

Create the following structure from scratch:

```
wpp/
├── CLAUDE.md                        # this file
├── docker-compose.yml
├── docker-compose.override.yml      # dev overrides (hot reload etc.)
├── .env.example                     # committed template
├── .env                             # gitignored, real secrets
├── .gitignore
│
├── nginx/
│   └── nginx.conf
│
├── server/                          # Node.js backend (Fastify + Baileys + SQLite)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js                 # entrypoint
│       ├── config.js                # env + constants
│       ├── db/
│       │   ├── index.js             # better-sqlite3 setup
│       │   └── migrations.js        # schema creation
│       ├── wa/
│       │   ├── client.js            # Baileys setup, event handling
│       │   ├── qr.js                # QR code SSE stream
│       │   └── media.js             # on-demand media download (never auto)
│       ├── api/
│       │   ├── auth.js              # login, logout, session
│       │   ├── tokens.js            # CRUD for API tokens
│       │   ├── personal.js          # /personal/send
│       │   ├── others.js            # /others/send + whitelist
│       │   ├── groups.js            # /groups/send
│       │   ├── channels.js          # list, get, update channel metadata
│       │   ├── messages.js          # retrieve messages, media endpoints
│       │   └── tabs.js              # CRUD for custom tabs
│       ├── ws/
│       │   └── index.js             # WebSocket server (authenticated)
│       └── middleware/
│           ├── session.js           # web UI session auth
│           └── token.js             # API token auth + scope enforcement
│
├── ui/                              # React frontend (Vite)
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── api/                     # fetch wrappers
│       │   └── client.js
│       ├── ws/                      # WebSocket hook
│       │   └── useWebSocket.js
│       └── pages/
│           ├── Login.jsx
│           ├── Connect.jsx          # QR code page
│           ├── Workspace.jsx        # main layout: tabs sidebar + channel list + message view
│           └── Tokens.jsx           # token management
│
└── cli/                             # wpp CLI
    ├── package.json
    └── src/
        ├── index.js                 # CLI entrypoint (bin)
        ├── config.js                # reads ~/.wpp/config.yaml
        └── commands/
            ├── send.js
            ├── messages.js
            ├── tabs.js
            ├── channel.js
            └── watch.js
```

---

## Docker Compose

### `docker-compose.yml`

```yaml
version: "3.9"

services:

  server:
    build:
      context: ./server
      dockerfile: Dockerfile
    container_name: wpp-server
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_PATH: /data/db/wpp.db
      WA_SESSION_PATH: /data/wa-session
      MEDIA_PATH: /data/media
    volumes:
      - wa_session:/data/wa-session
      - db_data:/data/db
      - media_data:/data/media
    ports:
      - "127.0.0.1:3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  ui:
    build:
      context: ./ui
      dockerfile: Dockerfile
    container_name: wpp-ui
    restart: unless-stopped
    depends_on:
      - server
    ports:
      - "127.0.0.1:5173:80"

  nginx:
    image: nginx:alpine
    container_name: wpp-nginx
    restart: unless-stopped
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "0.0.0.0:80:80"
    depends_on:
      - server
      - ui

volumes:
  wa_session:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ./data/wa-session
  db_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ./data/db
  media_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ./data/media
```

### `docker-compose.override.yml` (dev only)

```yaml
version: "3.9"

services:
  server:
    build:
      target: dev
    volumes:
      - ./server/src:/app/src        # hot reload
    environment:
      NODE_ENV: development

  ui:
    build:
      target: dev
    volumes:
      - ./ui/src:/app/src
    environment:
      VITE_API_URL: http://localhost:3000
```

### Pre-start script

Create a `Makefile` at root:

```makefile
.PHONY: init up down logs

init:
	mkdir -p data/db data/wa-session data/media
	cp -n .env.example .env || true
	@echo "Edit .env then run: make up"

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f
```

---

## `.env.example`

```env
# Web UI Admin credentials
ADMIN_USER=admin
ADMIN_PASS=changeme

# Long random string — generate with: openssl rand -hex 32
JWT_SECRET=replace_with_random_secret

# Your personal numbers (bypass whitelist, always allowed)
# Comma-separated E.164 format
PERSONAL_NUMBERS=+923001234567,+923007654321

# Public URL for CLI config and QR callback
PUBLIC_URL=http://localhost
```

---

## Server — Technical Specification

### Tech Stack
- **Runtime**: Node.js 20 (LTS)
- **Framework**: Fastify v4
- **WhatsApp**: `@whiskeysockets/baileys` latest
- **Database**: `better-sqlite3` (synchronous, simple, no daemon)
- **Auth**: `@fastify/session` + `@fastify/cookie` for Web UI; Bearer token for API
- **WebSocket**: `@fastify/websocket`
- **QR**: `qrcode` package (generate as base64 PNG for SSE)

### `src/db/index.js` — Required Pragmas

Immediately after opening the DB, before anything else runs, set these pragmas:

```javascript
// WAL mode: allows concurrent reads while Baileys is writing messages
db.pragma('journal_mode = WAL')
// NORMAL is safe with WAL and significantly faster than FULL
db.pragma('synchronous = NORMAL')
// Enforce FK constraints (SQLite disables these by default)
db.pragma('foreign_keys = ON')
// 32MB page cache — helps with message history queries
db.pragma('cache_size = -32000')
```

This is critical. Without WAL mode, the UI reading messages will block Baileys writing them (SQLite's single-writer lock). With WAL, reads and writes proceed concurrently.

### `server/Dockerfile`

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ curl

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS dev
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
CMD ["node", "--watch", "src/index.js"]

FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
CMD ["node", "src/index.js"]
```

### `server/package.json`

```json
{
  "name": "wpp-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "@fastify/cookie": "^9.0.0",
    "@fastify/cors": "^9.0.0",
    "@fastify/session": "^10.0.0",
    "@fastify/websocket": "^8.0.0",
    "@whiskeysockets/baileys": "latest",
    "better-sqlite3": "^9.0.0",
    "nanoid": "^5.0.0",
    "pino": "^8.0.0",
    "qrcode": "^1.5.3"
  }
}
```

---

## Database Schema

Create all tables in `src/db/migrations.js`. Run on server startup.

```sql
-- API Tokens
CREATE TABLE IF NOT EXISTS tokens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,   -- bcrypt hash of the raw token
  scopes      TEXT NOT NULL,          -- JSON array: ["personal:send","channels:read"]
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used   DATETIME,
  revoked     INTEGER DEFAULT 0
);

-- Whitelist for /others/send
CREATE TABLE IF NOT EXISTS whitelist (
  id          TEXT PRIMARY KEY,
  jid         TEXT NOT NULL UNIQUE,   -- E.164 number @s.whatsapp.net or group JID
  label       TEXT,
  added_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Custom Tabs (user-defined, WA-agnostic)
CREATE TABLE IF NOT EXISTS tabs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT DEFAULT '#6366f1',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Per-channel metadata (user's organizational layer, WA never knows about this)
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

-- Messages (text content + media stubs, NO media files auto-saved)
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,          -- WA message ID
  jid           TEXT NOT NULL,             -- channel JID
  from_jid      TEXT,
  body          TEXT,                      -- text content only
  type          TEXT DEFAULT 'text',       -- text|image|video|doc|audio|sticker|reaction
  -- Media stub fields (populated for media messages, no file written)
  media_mime    TEXT,
  media_size    INTEGER,
  media_sha256  TEXT,
  media_key     TEXT,                      -- WA encryption key for on-demand download
  media_url     TEXT,                      -- WA CDN URL (may expire)
  media_saved   INTEGER DEFAULT 0,         -- 1 only if user explicitly saved
  media_path    TEXT,                      -- set only when media_saved = 1
  -- Metadata
  timestamp     DATETIME NOT NULL,
  is_from_me    INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'sent',       -- sent|delivered|read|failed
  quoted_id     TEXT,                      -- message ID being replied to
  raw_json      TEXT                       -- full WA message object JSON
);

CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type   ON messages(type);
```

---

## Baileys Configuration — CRITICAL

**Never auto-download media. Implement robust reconnection. Use BufferJSON for all serialization.**

```javascript
// src/wa/client.js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON,
} from '@whiskeysockets/baileys'
import pino from 'pino'

const MAX_RETRIES = 10
let retries = 0
let currentSock = null

export async function createWAClient(sessionPath, eventBus) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,        // we handle QR ourselves via SSE
    downloadHistory: false,          // NO history sync — ever
    syncFullHistory: false,          // NO full sync — ever
    mediaCache: undefined,           // NO media cache — ever
    getMessage: async () => undefined,
    // Do NOT pass a store — this prevents Baileys from auto-downloading anything
    logger: pino({ level: 'warn' }),
  })

  currentSock = sock
  sock.ev.on('creds.update', saveCreds)

  // ─── Reconnection logic — covers all disconnect scenarios ───────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      eventBus.emit('wa.qr', qr)
    }

    if (connection === 'open') {
      retries = 0
      eventBus.emit('wa.status', { status: 'open' })

      // Sync all groups the account is in into channel_meta on connect
      // This ensures channels appear even before a message arrives from them
      try {
        const groups = await sock.groupFetchAllParticipating()
        for (const [jid, meta] of Object.entries(groups)) {
          upsertChannelMeta(jid, { display_name: meta.subject })
        }
      } catch (e) {
        // Non-fatal — channel list will still populate from message history
      }
    }

    if (connection === 'connecting') {
      eventBus.emit('wa.status', { status: 'connecting' })
    }

    if (connection === 'close') {
      eventBus.emit('wa.status', { status: 'close' })

      const code = lastDisconnect?.error?.output?.statusCode

      // These two codes mean the session is dead — do NOT retry, require re-scan
      const isLoggedOut = code === DisconnectReason.loggedOut
      const isForbidden = code === DisconnectReason.forbidden

      if (isLoggedOut || isForbidden) {
        // Wipe session files so next startup shows QR again
        eventBus.emit('wa.logged_out')
        return
      }

      // All other disconnects: retry with exponential backoff
      if (retries < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, retries), 60_000) // cap at 60s
        retries++
        setTimeout(() => createWAClient(sessionPath, eventBus), delay)
      } else {
        eventBus.emit('wa.failed', { message: 'Max reconnect attempts reached' })
      }
    }
  })

  // ─── Message ingestion — text only, media stubs, NEVER download ─────────
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const normalized = normalizeMessage(msg)
      saveMessage(normalized)                    // write to SQLite
      eventBus.emit('message.new', normalized)   // broadcast to WS clients
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      updateMessageStatus(update)
      eventBus.emit('message.update', update)
    }
  })

  return sock
}

// ─── Graceful shutdown — flush auth state cleanly before exit ────────────
process.on('SIGTERM', async () => {
  if (currentSock) {
    try { currentSock.end() } catch (_) {}
  }
  process.exit(0)
})

function normalizeMessage(raw) {
  // Extract: id, jid, from_jid, timestamp, body (text only), type
  // For media messages: extract mime, size, mediaKey, fileSha256 as hex
  // NEVER call downloadMediaMessage here
  // ALWAYS use BufferJSON.replacer when serializing to JSON:
  //   raw_json: JSON.stringify(raw, BufferJSON.replacer)
  // BufferJSON handles Buffer fields in Baileys objects — plain JSON.stringify
  // will silently serialize Buffers as {} which corrupts the stored data
}

export function getSock() {
  return currentSock
}
```

---

## API Routes — Full Specification

### Auth Routes (Web UI session — no token needed)

```
POST /auth/login
  Body: { username, password }
  Response: { ok: true }  + sets session cookie

POST /auth/logout
  Clears session

GET /auth/wa/status
  Response: { status: "open"|"connecting"|"close", qr: null|"base64png" }

GET /auth/wa/qr
  SSE stream — emits { type: "qr", data: "base64png" } until connected
  then emits { type: "connected" } and closes

POST /auth/wa/reconnect
  Requires: web UI session (not a token)
  Triggers a fresh reconnect attempt without restarting the container
  Resets the retry counter. Use when WA silently drops connection.
  Response: { ok: true, message: "Reconnecting..." }
```

### Token Routes (Web UI session required)

```
GET /tokens
  Response: [{ id, name, scopes, created_at, last_used, revoked }]
  Note: NEVER return the raw token after creation

POST /tokens
  Body: { name: string, scopes: string[] }
  Response: { id, name, scopes, token: "sk_..." }   ← raw token shown ONCE only

DELETE /tokens/:id
  Marks token as revoked
```

**Valid scopes:**
```
personal:send
others:send
others:whitelist:read
others:whitelist:manage
groups:send
channels:read
channels:summarize
tabs:manage
wa:admin
```

### Personal Send (scope: `personal:send`)

```
POST /personal/send
  Auth: Bearer token OR session
  Body: { to: "+923001234567", message: "text" }
  Validation: `to` must be in PERSONAL_NUMBERS env var (E.164)
  Response: { ok: true, messageId: "..." }
```

### Others Send (scope: `others:send`)

```
POST /others/send
  Auth: Bearer token OR session
  Body: { to: "+971501234567", message: "text" }
  Validation: `to` must exist in whitelist table
  Response: { ok: true, messageId: "..." }
```

### Groups Send (scope: `groups:send`)

```
POST /groups/send
  Auth: Bearer token OR session
  Body: { jid: "120363..@g.us", message: "text" }
  Response: { ok: true, messageId: "..." }
```

### Channels (scope: `channels:read`)

```
GET /channels
  Query: ?tab=<tabId>&archived=false&search=<text>
  Response: [{
    jid, display_name, tab_id, is_muted, is_archived,
    unread_count, last_message: { body, timestamp, type }
  }]

GET /channels/:jid
  Response: full channel_meta + last_message

PATCH /channels/:jid
  Auth: session only (organizational changes are UI-only)
  Body: { tab_id?, is_muted?, is_archived?, priority?, notes?, display_name? }
  Response: updated channel_meta
```

### Messages (scope: `channels:read`)

```
GET /channels/:jid/messages
  Query: ?limit=50&before=<iso_timestamp>&type=<text|image|...>
  Response: [{ id, jid, from_jid, body, type, timestamp, is_from_me,
               media_mime?, media_size?, media_saved, quoted_id }]

GET /channels/:jid/messages/:id/media
  Streams media to client — downloads on demand using stored media_key
  DOES NOT write to disk
  Headers: Content-Type, Content-Disposition: inline

POST /channels/:jid/messages/:id/media/save
  Downloads media and writes to MEDIA_PATH/<sha256>.<ext>
  Sets media_saved=1, media_path in DB
  Response: { ok: true, path: "/data/media/abc123.jpg" }

GET /media/:sha256
  Serves explicitly saved media from MEDIA_PATH
```

### Tabs (scope: `tabs:manage`)

```
GET /tabs
  Response: [{ id, name, color, position, channel_count }]

POST /tabs
  Body: { name, color? }
  Response: created tab

PATCH /tabs/:id
  Body: { name?, color?, position? }

DELETE /tabs/:id
  Unassigns all channels in this tab (sets tab_id = NULL)
```

### Whitelist (scope: `others:whitelist:manage`)

```
GET /whitelist
  Response: [{ id, jid, label, added_at }]

POST /whitelist
  Body: { jid: "+971...", label?: "Moneeb Work" }

DELETE /whitelist/:id
```

### Health

```
GET /health
  Response: { ok: true, wa: "open"|"connecting"|"close", uptime: 123 }
```

---

## WebSocket Specification

**Endpoint**: `ws://server:3000/ws`

**Auth**: Query param `?token=<raw_token>` OR `?session=<session_id>`

**Events emitted by server to clients:**

```jsonc
// New incoming message
{ "event": "message.new", "data": { /* normalized message */ } }

// Message status update (delivered, read)
{ "event": "message.update", "data": { "id": "...", "status": "read" } }

// WA connection status change
{ "event": "wa.status", "data": { "status": "open", "qr": null } }

// Channel metadata changed (tab move, mute, etc.)
{ "event": "channel.update", "data": { /* channel_meta */ } }
```

**Client can send:**

```jsonc
// Subscribe to specific JIDs only (filter noise)
{ "action": "subscribe", "jids": ["120363...@g.us", "923001234567@s.whatsapp.net"] }

// Subscribe to a whole tab
{ "action": "subscribe_tab", "tab_id": "tab_abc123" }

// Ping
{ "action": "ping" }
```

---

## Token Middleware

```javascript
// src/middleware/token.js
// Usage: fastify.addHook('onRequest', requireScope('personal:send'))

export function requireScope(scope) {
  return async (request, reply) => {
    // 1. Check session first (web UI always has full access)
    if (request.session?.authenticated) return

    // 2. Check Bearer token
    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const raw = auth.slice(7)
    const token = lookupAndVerifyToken(raw)   // hash lookup in DB
    if (!token || token.revoked) {
      return reply.code(401).send({ error: 'Invalid token' })
    }
    if (!token.scopes.includes(scope)) {
      return reply.code(403).send({ error: `Missing scope: ${scope}` })
    }

    // Update last_used
    updateLastUsed(token.id)
    request.token = token
  }
}
```

Token format: `sk_` prefix + 32 random bytes hex. Store only the SHA-256 hash in DB.

---

## Web UI — Technical Specification

### Tech Stack
- **Vite** + **React 18**
- **Tailwind CSS v3**
- **React Router v6**
- No component library — build custom components

### `ui/Dockerfile`

```dockerfile
FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev", "--", "--host"]

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx-ui.conf /etc/nginx/conf.d/default.conf
```

### Design Direction

The UI should feel like a **terminal-inspired dark workspace** — not a consumer chat app. Think VS Code sidebar meets a power-user messaging client. Dark theme only. Monospace accents for JIDs and token strings. Clean, dense information layout.

Design principles:
- **Dark background**: `#0d0d0d` or `#111111`
- **Accent color**: Emerald green `#10b981` for active states, new messages
- **Sidebar**: Fixed left panel showing tabs + channels. Tabs are collapsible sections.
- **Message area**: Right panel, dense layout, timestamps on hover
- **Font**: JetBrains Mono for IDs/tokens/JIDs, system-ui for body text
- **No gradients**, no rounded corners on main chrome, borders use `1px solid #222`

### Pages

#### `Login.jsx`
- Single centered form: username + password
- On success → redirect to `/connect` if WA not connected, else `/`

#### `Connect.jsx`
- Polls `GET /auth/wa/status` on load
- If not connected: opens SSE to `GET /auth/wa/qr`
- Renders QR as `<img src="data:image/png;base64,...">` 
- Shows spinner → success state → auto-redirect to `/` on connected event
- If already connected: auto-redirect to `/`

#### `Workspace.jsx` (main layout)

```
┌─────────────────────────────────────────────────────────────────┐
│ WAX                                    ● Connected  [Tokens] [⏻]│
├──────────────┬──────────────────────────────────────────────────┤
│ TABS         │ CHANNEL                 │ MESSAGES               │
│              │                         │                        │
│ + New Tab    │ [Search...]             │ Hassan Tariq           │
│              │                         │                        │
│ ▼ Important  │ ● Hassan Tariq    12:04 │ 12:04  hey check this  │
│   Hassan T.  │   hey check this...     │                        │
│   Moneeb     │                         │ 12:05  saw it, on it   │
│              │ ● Moneeb          11:30 │                        │
│ ▼ Wego       │   on the umrah api...   │ [Send a message...] →  │
│   Umrah Team │                         │                        │
│   Flights    │ ● Family Group    10:00 │                        │
│              │   dinner tonight?       │                        │
│ ▼ Inbox      │                         │                        │
│   (all rest) │                         │                        │
└──────────────┴─────────────────────────┴────────────────────────┘
```

**Sidebar behavior:**
- Each tab is a collapsible section with channel list inside
- "Inbox" is a virtual tab — all channels with no tab assigned
- Drag channels between tabs (use HTML5 drag-and-drop, no library needed)
- Right-click channel → context menu: Move to tab, Mute, Archive, Add note
- Unread count badge on channel rows
- New messages flash the channel row green briefly

**Channel list:**
- Shows: display name, last message preview (text only), timestamp, unread badge
- Media messages show type icon instead of text preview: 📷 Photo, 🎥 Video, 📄 Document

**Message view:**
- Grouped by date
- Sent messages right-aligned, received left-aligned
- Media messages show a placeholder card with type + size + "Download" button
  - Download button calls `GET /channels/:jid/messages/:id/media` → browser download
  - "Save to server" button calls `POST .../media/save`
- Reply/quote shown as nested block
- Real-time: WebSocket `message.new` events append to open channel instantly

#### `Tokens.jsx`
- Table: name, scopes (badges), created, last used, actions (revoke)
- "New Token" modal: name field + scope checkboxes (grouped by namespace)
- On create: show raw token in a one-time display box with copy button
- Warning: "This token will not be shown again"

---

## CLI — Technical Specification

### `cli/package.json`

```json
{
  "name": "wpp",
  "version": "1.0.0",
  "type": "module",
  "bin": { "wpp": "./src/index.js" },
  "dependencies": {
    "commander": "^12.0.0",
    "js-yaml": "^4.1.0",
    "ws": "^8.0.0",
    "chalk": "^5.0.0",
    "cli-table3": "^0.6.3",
    "ora": "^8.0.0"
  }
}
```

### Config file: `~/.wpp/config.yaml`

```yaml
server: https://wpp.yourdomain.ts.net
token: sk_abc123...
default_tab: important
```

### Commands

```bash
# Config management
wpp config set --server <url> --token <token>
wpp config show
wpp status                          # GET /health, show WA status
wpp reconnect                       # POST /auth/wa/reconnect (requires admin token with wa:admin scope)

# Sending
wpp send personal <number> <message>
wpp send others <number> <message>
wpp send group <jid|name> <message>

# Reading messages
wpp messages <channel_name_or_jid>          # last 20
wpp messages <channel> --limit 50
wpp messages <channel> --since 24h
wpp messages <channel> --type image         # only media stubs

# Organization
wpp tabs list
wpp tabs create <name> [--color #hex]
wpp tabs delete <id>

wpp channel list [--tab <name>]
wpp channel move <channel> --tab <name>
wpp channel mute <channel>
wpp channel archive <channel>
wpp channel note <channel> "my note"

# Whitelist
wpp whitelist list
wpp whitelist add <number> [--label <name>]
wpp whitelist remove <number>

# Real-time
wpp watch                                   # stream all events
wpp watch --tab important                   # filter by tab
wpp watch --channel "Hassan Tariq"          # filter by channel
```

### Output format

- Default: human-readable tables (cli-table3)
- `--json` flag on any command: raw JSON output (for piping to jq, agents, etc.)
- `--quiet` flag: suppress headers and decoration, just data
- Colors: use chalk. Green for sent, dim for metadata, red for errors.
- `wpp watch` output format:

```
[12:04:32] Hassan Tariq → hey check this thing
[12:05:01] You → Hassan Tariq: saw it, on it
[12:05:44] Umrah Team (Moneeb) → the ELM API is back up
```

---

## Nginx Configuration

```nginx
# nginx/nginx.conf
events { worker_processes 1; }

http {
  upstream server { server server:3000; }
  upstream ui     { server ui:80; }

  server {
    listen 80;

    # API + WebSocket
    location /api/ {
      proxy_pass http://server/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket
    location /ws {
      proxy_pass http://server/ws;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    }

    # Web UI (everything else)
    location / {
      proxy_pass http://ui/;
      proxy_set_header Host $host;
    }
  }
}
```

---

## Implementation Order

Build in this exact order. Each step should be working before moving to the next.

### Step 1 — Skeleton & Docker
1. Create all directories and empty files per the structure above
2. Write `docker-compose.yml`, `.env.example`, `Makefile`, `.gitignore`
3. Write both Dockerfiles (server + ui) with multi-stage builds
4. Write `nginx/nginx.conf`
5. Run `make init && make up` — all containers should start (even if server crashes, fix it)

### Step 2 — Server Foundation
1. `src/index.js` — Fastify app, register plugins, mount routes
2. `src/config.js` — load and validate all env vars, fail fast if missing
3. `src/db/migrations.js` — all CREATE TABLE statements, run on startup
4. `src/db/index.js` — open DB, run migrations, export `db` singleton
5. `GET /health` — should return 200 with `{ ok: true }`

### Step 3 — Web Auth
1. `src/api/auth.js` — login/logout with hardcoded ADMIN_USER/ADMIN_PASS
2. `src/middleware/session.js` — protect routes, 401 if not authenticated
3. Test: `curl -X POST /auth/login` returns session cookie

### Step 4 — Baileys & QR
1. `src/wa/client.js` — create socket with the exact config above (no auto-download, no store)
2. Implement full reconnect logic with exponential backoff covering `loggedOut` and `forbidden` as non-retriable codes
3. On `connection: 'open'`, call `sock.groupFetchAllParticipating()` and upsert all groups into `channel_meta` — this ensures groups appear in the channel list even before a message arrives from them
4. Use `BufferJSON.replacer` for ALL `JSON.stringify` calls on Baileys message objects — plain `JSON.stringify` silently corrupts Buffer fields to `{}`
5. `src/wa/qr.js` — SSE endpoint that streams QR events then sends `connected` and closes
6. `src/api/auth.js` — add `GET /auth/wa/status`, `GET /auth/wa/qr`, `POST /auth/wa/reconnect`
7. Test: hit QR endpoint, scan with phone, session persists on `docker compose restart server`

### Step 5 — Message Ingestion
1. Wire Baileys `messages.upsert` event → `normalizeMessage()` → SQLite insert
2. `src/api/messages.js` — `GET /channels/:jid/messages`
3. Test: send yourself a WA message, query it via API

### Step 6 — Send APIs
1. `src/api/personal.js` — validate against PERSONAL_NUMBERS, send via Baileys
2. `src/api/others.js` — validate against whitelist table, send
3. `src/api/groups.js` — send to group JID

### Step 7 — Token System
1. `src/api/tokens.js` — CRUD for tokens
2. `src/middleware/token.js` — Bearer auth + scope check
3. Apply `requireScope(...)` to all send and channel routes
4. Test: create token, use it in curl, verify scope rejection works

### Step 8 — Channels & Tabs
1. `src/api/channels.js` — list channels (derived from messages + channel_meta), get, patch
2. `src/api/tabs.js` — CRUD for tabs
3. Test: move a channel to a tab via API

### Step 9 — WebSocket
1. `src/ws/index.js` — authenticated WS server, subscribe/filter support
2. Wire eventBus → WS broadcast on `message.new`, `wa.status`, `channel.update`
3. Test: `wscat -c ws://localhost:3000/ws?token=sk_...` receives live messages

### Step 10 — Media (on-demand only)
1. `src/wa/media.js` — `downloadMediaMessage` called only on explicit request
2. `GET /channels/:jid/messages/:id/media` — stream to client
3. `POST /channels/:jid/messages/:id/media/save` — save to MEDIA_PATH

### Step 11 — Web UI
1. Login page → auth flow
2. Connect page → QR SSE flow
3. Workspace layout (sidebar + channel list + message view)
4. Token management page
5. WebSocket integration for real-time updates

### Step 12 — CLI
1. Config command
2. `send` commands
3. `messages` command
4. `tabs` + `channel` commands
5. `watch` command (WebSocket)

---

## Error Handling Rules

- All API errors return `{ error: "human readable message", code: "MACHINE_CODE" }`
- HTTP status codes: 400 bad input, 401 unauthed, 403 wrong scope, 404 not found, 500 server error
- Baileys disconnects: auto-reconnect with exponential backoff (1s, 2s, 4s… capped at 60s), max 10 retries
- `loggedOut` and `forbidden` disconnect codes are non-retriable — emit `wa.logged_out`, wipe session, require re-scan
- All other disconnect codes are retriable — backoff and reconnect automatically
- If WA is disconnected and a send is attempted: return 503 `{ error: "WhatsApp not connected", code: "WA_DISCONNECTED" }`
- All DB operations wrapped in try/catch — never crash the server on a bad message
- `upsertChannelMeta` on group sync failures is non-fatal — log and continue

---

## Security Rules

- ADMIN_USER / ADMIN_PASS: compared with constant-time string compare (use `crypto.timingSafeEqual`)
- Tokens: stored as SHA-256 hash, raw token shown ONCE on creation
- Session secret: from JWT_SECRET env var, min 32 chars, fail fast if shorter
- All ports bound to `127.0.0.1` in Docker Compose except Nginx
- No CORS allowed by default — add origins only via env var if needed
- PERSONAL_NUMBERS whitelist enforced server-side, never trust client

---

## What NOT to Build (Deferred)

Do not implement these in Phase 1 — leave TODO comments where relevant:

- LLM message summaries (`GET /channels/:jid/summary`) — stub endpoint returning 501
- Scheduled/broadcast messages — not in scope
- Incoming message webhooks (outbound to external URLs) — not in scope
- Read receipt marking — not in scope
- Contact sync from WA — groups are synced on connect via `groupFetchAllParticipating()`; DM channels populate from message history only. Full contact list sync is not in scope.
- Media send (sending images/docs) — text only for Phase 1

---

## Definition of Done

Phase 1 is complete when:

1. `make init && make up` starts all containers with no errors
2. Browsing to `http://localhost` shows the login page
3. Login with ADMIN_USER/ADMIN_PASS works
4. QR page appears, scanning with WhatsApp connects successfully
5. Session survives `docker compose restart server`
6. Channels page shows chats (derived from received messages)
7. Sending a message via UI to a personal number works
8. Creating an API token with scopes works, raw token shown once
9. `curl -H "Authorization: Bearer sk_..." -X POST /personal/send ...` works
10. `curl` with wrong scope returns 403
11. `wpp status` shows WA connected
12. `wpp send personal +923001234567 "test"` sends a message
13. `wpp watch` streams incoming messages in real time
14. A new incoming WA message appears in the Web UI without page refresh
15. A media message shows a placeholder card, not a downloaded file

