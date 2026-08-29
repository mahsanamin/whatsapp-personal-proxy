# Error handling

## The server's error shape

Every error response is exactly:

```json
{ "error": "human readable message", "code": "MACHINE_CODE" }
```

`code` is `SCREAMING_SNAKE_CASE` and is a contract — the CLI and callers branch on it, so
renaming one is a breaking change. Reuse an existing code before inventing a new one:

`BAD_INPUT`, `UNAUTHORIZED`, `INVALID_TOKEN`, `MISSING_SCOPE`, `NOT_FOUND`, `DUPLICATE`,
`NOT_WHITELISTED`, `NOT_PERSONAL_NUMBER`, `WA_DISCONNECTED`, `NO_MEDIA`,
`MEDIA_DOWNLOAD_FAILED`, `MEDIA_SAVE_FAILED`, `INVALID_SCOPES`, `NOT_IMPLEMENTED`.

Status codes: `400` bad input, `401` no or bad credential, `403` authenticated but not
allowed, `404` missing, `409` conflict, `503` WhatsApp is down, `502` WhatsApp refused.

## Never crash on a message

Baileys delivers whatever WhatsApp sends, including message types this code has never
seen. Ingestion in `wa/client.js` wraps each message so one malformed payload cannot take
down the socket. That is deliberate — keep it. An unrecognised type is stored with
`type: 'unknown'` rather than dropped, so nothing is silently lost.

The same applies to the name-resolution helpers: a failure to resolve a contact name must
degrade to a nameless chat, never to a failed read.

## The CLI's error shape

Failures go to **stderr** as JSON and exit `1`:

```json
{ "success": false, "error": { "code": "...", "message": "...", "status": 403 } }
```

Server codes pass through unchanged so a caller sees the same `NOT_WHITELISTED` whether
it used `curl` or `wpp`. CLI-only codes (`NOT_CONNECTED`, `AMBIGUOUS_TARGET`,
`CONFIRMATION_REQUIRED`, `BAD_URL`) cover what the CLI decides on its own.

An error message should say what to do next. `AMBIGUOUS_TARGET` carries the candidate
chats in `error.details`; `TARGET_NOT_FOUND` names the command that would list them.
