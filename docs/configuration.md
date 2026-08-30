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
| `PERSONAL_NUMBERS` | Comma-separated E.164 numbers that bypass the whitelist. These are the numbers `personal:send` can reach |

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
