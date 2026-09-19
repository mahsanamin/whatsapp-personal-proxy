# Security rules

This proxy holds a live WhatsApp account. A mistake here does not corrupt data, it lets
someone else be you.

## Non-negotiables

- **`data/wa-session/` is a credential.** Anyone with that directory can impersonate the
  account from a fresh install. Never log it, never copy it into an image, never include
  it in a bug report or a backup that leaves the machine.
- **Tokens are hashed at rest.** SHA-256, `sk_` prefix, plaintext returned exactly once at
  creation. Never add an endpoint that can read a token back.
- **Password comparison is constant-time** (`crypto.timingSafeEqual`). Do not "simplify"
  it to `===`.
- **Revocation is a soft delete.** `revoked = 1` keeps the audit row. Do not switch it to
  a hard `DELETE`.
- **Never interpolate into SQL.** Prepared statements with placeholders, always.

## Scopes are the whole access model

A token is a machine's identity. One machine, one token, least privilege — a notifier gets
`personal:send` and nothing else, so a leak on that box cannot read the message history.

Every route states its scope in the route options. When adding a route, ask what the
weakest useful token is and require exactly that. `channels:read` is a *broad* scope: it
exposes the full message mirror. Do not attach it to a route that does not need it.

`requireScope` lets a console session through unconditionally — that is intended, the
console is the owner. It means a route guarded only by `requireSession` is console-only
and unreachable by any token.

## Writes are gated twice

The server enforces the destination (linked account and `PERSONAL_NUMBERS`, then the whitelist, then group
membership). The CLI additionally requires a confirmation or `--yes`. Both layers stay:
the server one is the real control, the CLI one stops an agent sending on a guess.

Do not add a send route that skips the destination check. `/api/send` exists for the
console and is session-only for exactly that reason.

## What may be unauthenticated

Only three things, deliberately:

- `/api/health` — no account data.
- `/api/auth/wa/status` and `/api/auth/wa/qr` — a QR code is useless to anyone who cannot
  also complete the pairing on your phone, and the console needs them before a session
  exists.
- `/api/cli/wpp` and `/api/cli/install-command` — the script holds no secrets, and a new
  machine needs it *before* it has a token.

Everything else requires a credential. When in doubt, require one.

## Media

Media is never fetched automatically. Beyond disk usage this is a privacy stance: the
server stores metadata, and bytes leave WhatsApp only when someone explicitly asks for
that message. Do not add background prefetching.

## Before pushing

`.githooks/pre-push` runs a secret sweep for personal hostnames, work email addresses,
and real phone numbers. Enable it once per clone: `git config core.hooksPath .githooks`.
Example numbers in docs and tests must stay in the reserved `+1555555xxxx` range.
