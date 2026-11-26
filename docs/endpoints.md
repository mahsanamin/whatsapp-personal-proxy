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
| `personal:send` | Send to the linked account and additional `PERSONAL_NUMBERS` |
| `others:send` | Send to whitelisted numbers |
| `others:whitelist:read` | Read the whitelist |
| `others:whitelist:manage` | Add to and remove from the whitelist |
| `groups:send` | Send to groups you are in |
| `channels:read` | List chats, read messages, search, stream events |
| `channels:summarize` | Reserved for the LLM summary endpoint |
| `tabs:manage` | Create, rename, and delete tabs |
| `wa:admin` | Force reconnect and QR refresh |
| `autoreply:manage` | Manage auto-reply rule sets, test them, read the decision log, mute contacts. Cannot put a rule set live, turn on the kill switch, or change the server limits |
| `autoreply:llm` | Only together with `autoreply:manage`: also create, edit, activate (in `dry_run`) and test rule sets with an "llm" reply, and read model-written reply text in the decision log. The model reads the recent messages of the chat it answers, so treat this like `channels:read`. Still cannot put anything live |

## Health and identity

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/health` | none | `{ ok, wa, uptime }` |
| `GET` | `/api/auth/test` | any credential | Identity, scopes, WhatsApp link state. `wpp connect` calls this |

`/api/auth/test` also returns `personal_numbers` when the caller holds `personal:send`.
The list includes both `PERSONAL_NUMBERS` and the linked WhatsApp account itself,
so the CLI can route a send without a wasted round trip.

## Web console session

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | `{ username, password, remember? }`. `remember` is `30d`, `60d` or `forever` (400 days, the browser cap); omitted means 7 days. Sessions renew on use. Rate limited by `RATE_LIMIT_LOGIN` |
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
| `GET` | `/api/channels/:jid/picture` | `channels:read` | The chat's WhatsApp profile picture (preview size) as image bytes. People and groups only. Fetched on demand and cached server-side for 24h, including "no picture"; `404 NOT_FOUND` when none is visible, `503 WA_DISCONNECTED` when nothing is cached and WhatsApp is down, `502 WA_FETCH_FAILED` on a transient failure |
| `GET` | `/api/groups` | `channels:read` | Groups from WhatsApp live, not the mirror. Requires an open link |
| `GET` | `/api/channels/:jid/messages` | `channels:read` | Query: `limit` (max 200), `before`, `after`, `type`. Newest first. Reads across LID and phone-number JIDs |
| `GET` | `/api/messages/search` | `channels:read` | Query: `q` (required), `jid`, `type`, `limit` |
| `GET` | `/api/events` | `channels:read` | SSE stream. Query: `jid` (comma separated), `type` |
| `GET` | `/ws` | token or session | WebSocket for the console. `?token=` or an authenticated session |

## Sending

All three are rate limited by `RATE_LIMIT_SEND`.

| Method | Path | Scope | Body |
|---|---|---|---|
| `POST` | `/api/personal/send` | `personal:send` | `{ to, message }` — `to` must be the linked account or in `PERSONAL_NUMBERS` |
| `POST` | `/api/others/send` | `others:send` | `{ to, message }` — `to` must be whitelisted |
| `POST` | `/api/groups/send` | `groups:send` | `{ jid, message }` — `jid` must end in `@g.us` **and be on the allow list** |
| `POST` | `/api/send` | session | `{ jid, message }` — console only, reaches any JID. Never exposed to a token under any scope |

**Who may message whom.** The console holds a session and may message anyone.
An API key may only reach the linked account, `PERSONAL_NUMBERS`, and entries on the allow list
(`/api/whitelist`, managed in the console under **Allow list**). This applies to
groups as well as DMs: a key with `groups:send` can only message groups that
were explicitly allowed.

## Media and message actions

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/api/media/send` | depends on destination | Body is the **raw file bytes**; metadata goes in the query string: `to`, `kind`, `caption`, `filename`, `mimetype`, `voice`, `gif`, `reply_to`. Up to 100 MB. With `voice=true` the audio is re-encoded to Ogg/Opus with ffmpeg and sent with its duration and waveform; a file ffmpeg cannot read fails with `422 TRANSCODE_FAILED` |
| `POST` | `/api/messages/:id/react` | destination-gated | `{ emoji }` — an empty emoji removes your reaction |
| `POST` | `/api/messages/:id/edit` | destination-gated | `{ message }` — your own messages only |
| `DELETE` | `/api/messages/:id` | destination-gated | Deletes for everyone; your own messages only |
| `POST` | `/api/channels/:jid/receipts` | `channels:read` | Sends real read receipts (blue ticks) |
| `POST` | `/api/channels/:jid/presence` | destination-gated | `{ state }` — composing, recording, paused, available, unavailable |
| `POST` | `/api/channels/:jid/read` | `channels:read` | Local unread bookkeeping only; invisible to the sender |

Media uploads carry the bytes as the request body rather than multipart so the
CLI needs no encoder and the server no extra package. `Content-Type:
application/octet-stream` with `?mimetype=` is the reliable form — Fastify's
built-in parsers otherwise reinterpret `text/plain` and `application/json`
bodies.

**Message types:** `text`, `image`, `video`, `audio`, `voice`, `doc`,
`sticker`, `reaction`, `deleted`, `unknown`. `voice` is a voice note (`ptt`);
`audio` is an attached audio file.

## Whitelist

| Method | Path | Scope |
|---|---|---|
| `GET` | `/api/whitelist` | `others:whitelist:read` |
| `POST` | `/api/whitelist` | `others:whitelist:manage` — `{ jid, label? }`, accepts `+9715...` or a raw JID |
| `DELETE` | `/api/whitelist/:id` | `others:whitelist:manage` |

## Auto-reply

Rule sets and their format are described in [`autoreply.md`](autoreply.md). Template
errors come back as `400 BAD_INPUT` with the full list in `details: [{ path, message }]`.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/autoreply/settings` | `autoreply:manage` | `{ enabled, limits, defaults, overridden, bounds }`. `limits` are the ones in force, `defaults` come from `.env`, `overridden` names the limits saved from the console |
| `PUT` | `/api/autoreply/settings` | session | `{ enabled }`. The global switch. Console only |
| `PUT` | `/api/autoreply/limits` | session | Any of `{ minGapSeconds, maxPerChatPerHour, maxPerChatPerDay, maxPerHour, maxAgeSeconds }` as whole numbers inside `bounds`, otherwise `400 BAD_INPUT`. Saved in SQLite and used from the next message. Does not change any rule set's mode. Returns the same shape as `GET /settings`. Console only |
| `DELETE` | `/api/autoreply/limits` | session | Clears every saved limit, so the `.env` defaults apply again. Console only |
| `GET` | `/api/autoreply/rulesets` | `autoreply:manage` | List, without templates |
| `POST` | `/api/autoreply/rulesets` | `autoreply:manage` | `{ template }` as JSON text or an object. Starts inactive in `dry_run`. `201` |
| `GET` | `/api/autoreply/rulesets/:id` | `autoreply:manage` | Includes `template` as stored text |
| `GET` | `/api/autoreply/rulesets/:id/download` | `autoreply:manage` | The template as a `.json` attachment |
| `PUT` | `/api/autoreply/rulesets/:id` | `autoreply:manage` | `{ template }`. A live rule set goes back to `dry_run` |
| `PATCH` | `/api/autoreply/rulesets/:id` | `autoreply:manage` | `{ mode?, active? }`. Activating one deactivates the rest. Leaving a set active and `live` needs the console session, otherwise `403 MISSING_SCOPE` |
| `DELETE` | `/api/autoreply/rulesets/:id` | `autoreply:manage` | The decision log is kept |
| `POST` | `/api/autoreply/validate` | `autoreply:manage` | `{ template }` → `{ valid, errors, warnings, summary }` |
| `POST` | `/api/autoreply/test` | `autoreply:manage` | `{ template \| ruleset_id, chat, text, type?, saved?, sender_name? }` → scope, whether the sender is saved, matching rule, reply, and whether it would send now. An "llm" rule calls the model (`decision.generated`); the response is `no-store`. Sends and logs nothing. 20 per minute. Rule sets with an "llm" reply need the console or `autoreply:llm` here and in the create, edit and activate routes, otherwise `403 MISSING_SCOPE` |
| `GET` | `/api/autoreply/decisions` | `autoreply:manage` | `?limit=` (max 500) `&ruleset_id=`. Without `autoreply:llm`, a reply a model may have written comes back with `reply_text: null` and `reply_redacted: true` |
| `GET` | `/api/autoreply/contacts` | `autoreply:manage` | Per-contact replies, conversation count, mute state |
| `POST` | `/api/autoreply/contacts/:jid/mute` | `autoreply:manage` | `{ minutes? }`, default 1440 |
| `DELETE` | `/api/autoreply/contacts/:jid/mute` | `autoreply:manage` | `:jid` may be `<group>\|<sender>` for a sender muted inside a group |

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
