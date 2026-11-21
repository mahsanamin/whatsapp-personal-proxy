# Configuration

Everything lives in `.env` at the repository root. `./proxy init` copies
`.env.example` into place. The server validates on boot and **refuses to start** on a
bad configuration rather than running insecurely.

## Required

| Variable | Purpose |
|---|---|
| `ADMIN_USER` | Web console username |
| `ADMIN_PASS` | Web console password. The server refuses to start while this is `changeme` |
| `JWT_SECRET` | Session signing secret. Must be ≥32 characters and not the placeholder. `openssl rand -hex 32` |

## Optional

| Variable | Default | Purpose |
|---|---|---|
| `PERSONAL_NUMBERS` | empty | Additional owned E.164 numbers that `personal:send` can reach without the allow list. The linked WhatsApp account is always included automatically |

## Networking

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3900` | How the console and CLI reach this server. Used for the secure-cookie decision and for the CLI install command shown in the console |
| `BIND_HOST` | `127.0.0.1` | What the edge nginx binds to on the host |
| `COOKIE_SECURE` | auto | `1` forces the `Secure` cookie flag. Left blank, it is derived from whether `PUBLIC_URL` is HTTPS |

`BIND_HOST` is the one to get right. `127.0.0.1` means only this machine, and only
through something running on it — correct when a host nginx, Caddy, or Tailscale Serve
is fronting the stack. If the machines running `wpp` reach the server directly (a
tailnet, a trusted LAN), set `BIND_HOST` to that interface's address, not `0.0.0.0`,
and set `PUBLIC_URL` to match.

On a headless box there is no browser on `localhost`, so a loopback bind looks healthy
in every local check and is unreachable from anywhere else. Bind to the address other
machines actually use.

## Keeping media

| Variable | Default | Purpose |
|---|---|---|
| `MEDIA_AUTO_DOWNLOAD` | `0` | Save media to disk as it arrives |
| `MEDIA_AUTO_DOWNLOAD_MAX_MB` | `25` | Skip anything larger. `0` removes the limit |

WhatsApp removes media from its CDN after a while. With this off, bytes are
fetched only when something asks for them — and by then a download frequently
returns `403`, leaving only a re-upload request to the phone, which it often
ignores. **Media not kept on arrival is usually gone for good.**

Turn it on if the media in your chats matters. `data/media/` will grow roughly
in step with what you receive.

`wpp media export <chat>` pulls everything in one conversation to your machine,
and reports whatever WhatsApp would no longer supply instead of failing.

## Rate limits

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_LOGIN` | `10` | Console login attempts per minute per IP. `0` disables |
| `RATE_LIMIT_SEND` | `60` | Calls per minute per IP across the three send endpoints. `0` disables |

## Auto-reply

Server caps for `docs/autoreply.md`. A rule set can be stricter, never looser.

These are the **defaults**. Each one can be changed on the console's Auto-reply page
("Server limits"), which saves the new value in SQLite and uses it from the next incoming
message, with no restart. A saved value wins over the variable here until you press
"Reset to defaults" (or save the default value again). A limit that was never changed in
the console follows this file, including after you edit it and restart.

The console accepts: delay between replies 5 to 3,600 seconds, replies per contact per
hour 1 to 100, per day 1 to 1,000, replies per hour overall 1 to 1,000, and message age
30 to 600 seconds.

| Variable | Default | Purpose |
|---|---|---|
| `AUTOREPLY_MIN_GAP_S` | `60` | Minimum seconds between two auto-replies in one chat. Cannot go below 5. Lower it for menu-style rule sets, where the contact answers within seconds |
| `AUTOREPLY_MAX_PER_CHAT_PER_HOUR` | `3` | Auto-replies per contact per hour |
| `AUTOREPLY_MAX_PER_CHAT_PER_DAY` | `10` | Auto-replies per contact per 24 hours |
| `AUTOREPLY_MAX_PER_HOUR` | `30` | Auto-replies per hour across all chats |
| `AUTOREPLY_MAX_AGE_S` | `180` | Messages older than this are treated as history and never answered (30 to 600) |

Auto-reply itself is switched on from the console, not here, and is off on a new install.

## Paths

Set by `docker-compose.yml`; only change them if you are running outside Docker.

| Variable | Container default |
|---|---|
| `DB_PATH` | `/data/db/wpp.db` |
| `WA_SESSION_PATH` | `/data/wa-session` |
| `MEDIA_PATH` | `/data/media` |
| `PORT` | `3901` |
| `CLI_PATH` | unset — the server finds the bundled `wpp` itself |

All three data paths are bind-mounted from `./data/` on the host.

## Putting it on the internet

Pick one; never expose `:3900` directly.

**Tailscale** (simplest):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3900
```

Set `PUBLIC_URL` to the resulting `https://your-host.tail-xxxx.ts.net` and restart.

**Host nginx with a real certificate**: proxy to `127.0.0.1:3900`, forwarding `Host`,
`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, and the `Upgrade`/`Connection`
headers for the WebSocket. See the README for a full server block.

TLS is never terminated inside the stack. Fastify runs with `trustProxy: true`, so
`X-Forwarded-Proto` from the front proxy is what flips secure cookies on.
