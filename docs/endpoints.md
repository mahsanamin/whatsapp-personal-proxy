# API endpoints

Everything is served under `/api/` by the edge nginx, which strips the prefix before
proxying to Fastify. A route the server declares as `/channels` is reached at
`/api/channels`.

## Authentication

Two credentials, never mixed:

- **Web console** — a session cookie from `POST /api/auth/login`. Has every scope.
- **CLI and scripts** — `Authorization: Bearer sk_...`. Restricted to the token's scopes.

A token that lacks the scope for a route gets `403 MISSING_SCOPE`; an unknown or revoked
token gets `401 INVALID_TOKEN`.

## Error format

```json
{ "error": "human readable message", "code": "MACHINE_CODE" }
```

Common codes: `BAD_INPUT`, `UNAUTHORIZED`, `INVALID_TOKEN`, `MISSING_SCOPE`, `NOT_FOUND`,
`DUPLICATE`, `NOT_WHITELISTED`, `NOT_PERSONAL_NUMBER`, `WA_DISCONNECTED`.

## Scopes

| Scope | Unlocks |
|---|---|
| `personal:send` | Send to your own `PERSONAL_NUMBERS` |
| `others:send` | Send to whitelisted numbers |
| `others:whitelist:read` | Read the whitelist |
| `others:whitelist:manage` | Add to and remove from the whitelist |
| `groups:send` | Send to groups you are in |
| `channels:read` | List chats, read messages, search, stream events |
| `channels:summarize` | Reserved for the LLM summary endpoint |
| `tabs:manage` | Create, rename, and delete tabs |
| `wa:admin` | Force reconnect and QR refresh |

## Health and identity

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/health` | none | `{ ok, wa, uptime }` |
| `GET` | `/api/auth/test` | any credential | Identity, scopes, WhatsApp link state. `wpp connect` calls this |

`/api/auth/test` also returns `personal_numbers` when the caller holds `personal:send`,
so the CLI can route a send without a wasted round trip.

## Web console session

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | `{ username, password }`. Rate limited by `RATE_LIMIT_LOGIN` |
| `POST` | `/api/auth/logout` | session | |

## Linking WhatsApp

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/auth/wa/status` | none | `{ status, qr, qr_age }`. `qr` is a base64 PNG, nulled once stale (>25s) |
| `GET` | `/api/auth/wa/qr` | none | SSE stream of QR codes, ends on `connected` |
| `POST` | `/api/auth/wa/refresh-qr` | session | Reset retries and generate a fresh QR |
| `POST` | `/api/auth/wa/reconnect` | session | Reconnect without clearing the session |

## Tokens

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/tokens` | session | Never returns the token itself |
| `POST` | `/api/tokens` | session | `{ name, scopes[] }` → `{ id, name, scopes, token }`. The plaintext token is returned once and never again |
| `DELETE` | `/api/tokens/:id` | session | Revokes (soft delete, keeps the audit row) |

## CLI distribution

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/cli/wpp` | none | The `wpp` script itself. Unauthenticated on purpose: a new machine needs it before it has a token |
| `GET` | `/api/cli/install-command` | none | The exact install and connect one-liners for this server's `PUBLIC_URL` |

## Reading

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/channels` | `channels:read` | Query: `type=dm\|group\|channel`, `search`, `tab`, `archived`, `limit` |
| `GET` | `/api/channels/:jid` | `channels:read` | One chat's metadata |
| `GET` | `/api/groups` | `channels:read` | Groups from WhatsApp live, not the mirror. Requires an open link |
| `GET` | `/api/channels/:jid/messages` | `channels:read` | Query: `limit` (max 200), `before`, `after`, `type`. Newest first. Reads across LID and phone-number JIDs |
| `GET` | `/api/messages/search` | `channels:read` | Query: `q` (required), `jid`, `type`, `limit` |
| `GET` | `/api/events` | `channels:read` | SSE stream. Query: `jid` (comma separated), `type` |
| `GET` | `/ws` | token or session | WebSocket for the console. `?token=` or an authenticated session |

## Sending

All three are rate limited by `RATE_LIMIT_SEND`.

| Method | Path | Scope | Body |
|---|---|---|---|
| `POST` | `/api/personal/send` | `personal:send` | `{ to, message }` — `to` must be in `PERSONAL_NUMBERS` |
| `POST` | `/api/others/send` | `others:send` | `{ to, message }` — `to` must be whitelisted |
| `POST` | `/api/groups/send` | `groups:send` | `{ jid, message }` — `jid` must end in `@g.us` |
| `POST` | `/api/send` | session | `{ jid, message }` — console only, no whitelist check |

## Whitelist

| Method | Path | Scope |
|---|---|---|
| `GET` | `/api/whitelist` | `others:whitelist:read` |
| `POST` | `/api/whitelist` | `others:whitelist:manage` — `{ jid, label? }`, accepts `+9715...` or a raw JID |
| `DELETE` | `/api/whitelist/:id` | `others:whitelist:manage` |

## Organisation

| Method | Path | Scope |
|---|---|---|
| `GET` `POST` | `/api/tabs` | `tabs:manage` |
| `PATCH` `DELETE` | `/api/tabs/:id` | `tabs:manage` |
| `PATCH` | `/api/channels/:jid` | session — tab, mute, archive, priority, notes, display name |

## Media

Media is **never** downloaded automatically. Metadata is stored; bytes are fetched only
when asked for.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/channels/:jid/messages/:id/media` | `channels:read` | Streams the file, does not write to disk |
| `POST` | `/api/channels/:jid/messages/:id/media/save` | `channels:read` | Downloads and persists under `MEDIA_PATH` |
| `GET` | `/api/media/:sha256` | session | Serves a previously saved file |
