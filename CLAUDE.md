# WPP — WhatsApp Personal Proxy

Self-hosted WhatsApp gateway with Web UI, REST/WebSocket API, and CLI.

## Quick Start

```bash
make init    # creates data dirs, copies .env.example → .env
# Edit .env with your credentials
make up      # docker compose up -d --build
```

## Architecture

- **server/** — Node.js 20 + Fastify + Baileys + SQLite (better-sqlite3)
- **ui/** — React 18 + Vite + Tailwind CSS (dark terminal-inspired theme)
- **cli/** — Commander.js CLI, reads `~/.wpp/config.yaml`, uses same API tokens
- **nginx/** — Reverse proxy: `/api/*` → server, `/ws` → server, `/*` → ui

## Key Conventions

- All source is ESM (`"type": "module"`)
- SQLite with WAL mode for concurrent reads
- API tokens: SHA-256 hashed, `sk_` prefix, shown once on creation
- Admin password: constant-time comparison via `crypto.timingSafeEqual`
- Media: NEVER auto-downloaded. Metadata stored, files fetched on explicit request only
- Baileys: no store, no history sync, `BufferJSON.replacer` for all serialization
- Error format: `{ error: "message", code: "MACHINE_CODE" }`

## Auth Model

- **Web UI**: session cookie (`@fastify/session`) — full access
- **API/CLI**: Bearer token with scopes — restricted by `requireScope()` middleware
- Valid scopes: `personal:send`, `others:send`, `others:whitelist:read`, `others:whitelist:manage`, `groups:send`, `channels:read`, `channels:summarize`, `tabs:manage`, `wa:admin`

## Development

```bash
make dev     # foreground with logs, hot reload via docker-compose.override.yml
make logs    # tail logs
```
