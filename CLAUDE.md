# WPP — WhatsApp Personal Proxy

Self-hosted WhatsApp gateway. The server runs on **one** machine (the one your phone is
linked to); every other machine drives it through the `wpp` CLI over REST.

## Quick reference

- `./proxy start|stop|restart|logs|status|test` manages the stack. `make` wraps it.
- `./proxy init` creates `data/` and `.env`. Edit `.env` before the first start.
- `docs/` — CLI, endpoints, architecture, configuration, project structure
- `docs/ai_rules/` — conventions every code change must follow. **Read these first.**

## Architecture

- **server/** — Node 20 + Fastify + Baileys + SQLite (better-sqlite3)
- **ui/** — React 18 + Vite + Tailwind (dark terminal-inspired theme)
- **wpp** — the CLI: one Python file, standard library only, bundled into the server
  image and served at `/api/cli/wpp` so a new machine bootstraps with one `curl`
- **nginx/** — edge proxy: `/api/*` and `/ws` → server, `/*` → ui

Routes are declared without the `/api` prefix; nginx strips it. Both the UI container
and the Vite dev server listen on **5973**, so `nginx/nginx.conf` has one upstream that
is right in development and production.

## Auth model

- **Web console** — session cookie (`@fastify/session`). Full access. The only place
  WhatsApp is linked (QR scan) and the only place tokens are minted.
- **CLI and scripts** — `Authorization: Bearer sk_...`, restricted by `requireScope()`.
  One token per machine, least privilege, revocable independently.

Valid scopes: `personal:send`, `others:send`, `others:whitelist:read`,
`others:whitelist:manage`, `groups:send`, `channels:read`, `channels:summarize`,
`tabs:manage`, `wa:admin`.

Tokens are SHA-256 hashed at rest, `sk_` prefix, shown once at creation. Admin password
comparison is constant-time via `crypto.timingSafeEqual`.

**Send permissions are two-tier and must stay that way.** The console may message anyone
  (`POST /send`, session-only). An API key may reach only the linked account, `PERSONAL_NUMBERS`, and the allow
list — DMs via `/others/send` and groups via `/groups/send`, both of which check the
`whitelist` table and exempt an authenticated session. A new send route inherits this
obligation; `server/tests/permissions.test.js` pins it.

## Key conventions

- All server and UI source is ESM (`"type": "module"`).
- Error format: `{ error: "message", code: "MACHINE_CODE" }`. Codes are a contract —
  the CLI branches on them.
- The CLI prints `{ success, data, meta }` to stdout and
  `{ success: false, error: {...} }` to stderr, exit 1.
- SQLite in WAL mode. Prepared statements only, never string interpolation.
- `server/src/util/` must not import the database, so its helpers stay testable without
  the native build.
- Media is **never** auto-downloaded. Metadata is stored; bytes are fetched only on an
  explicit request for that message.
- Baileys: no store; `syncFullHistory: true` so contact names and history populate;
  `BufferJSON.replacer` for all serialization.

## LID/PN duality — read this before touching JIDs

WhatsApp multi-device gives one person two addresses: a phone-number JID
(`...@s.whatsapp.net`) and a device-linked one (`...@lid`). Chats often arrive under the
LID while names arrive under the PN.

- `lid_map` cross-references them, so display names propagate both ways (`wa/client.js`).
- **Reads must expand through `expandJids()`** (`db/lidmap.js`). Reading a single JID
  returns half a DM.
- User input goes through `toJid()` (`util/jid.js`) so numbers and JIDs both work.

## Networking

TLS terminates at the edge (host nginx / Tailscale Serve). The Node app speaks plain
HTTP and relies on `trustProxy: true` plus `X-Forwarded-Proto` to set secure-cookie
flags. `BIND_HOST` controls what the stack binds on the host — on a headless box a
loopback bind is unreachable from the machines that need it.

## Development

```bash
./proxy dev      # foreground with hot reload via docker-compose.override.yml
./proxy logs     # tail logs
./proxy test     # server (node:test) + CLI (unittest)
./proxy cli      # print the install/connect commands for this server
```

Enable the pre-push checks once per clone: `git config core.hooksPath .githooks`.
