# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use
GitHub's [private security advisory](https://github.com/mahsanamin/whatsapp-personal-proxy/security/advisories/new)
flow instead — it lets us discuss and patch privately before disclosure.

Acknowledgement target: 7 days.

## Threat model

WPP is designed for **personal, single-tenant, self-hosted use** on a trusted
network — typically behind Tailscale, a host-level reverse proxy with TLS, or
a private LAN you control. It is **not** hardened for the public internet
without an authenticating reverse proxy in front of it.

### Assumptions

- The operator controls both the host and the network path to it
- TLS is terminated by an upstream reverse proxy (host nginx, Tailscale Serve,
  Caddy, Cloudflare Tunnel, etc.) — the Node server itself speaks plain HTTP
- Only the operator and explicitly issued API tokens have access
- The `data/` directory (SQLite DB, WhatsApp session, media) is treated as
  sensitive — it grants full read access to the linked WhatsApp account

### What WPP protects against

- API tokens are SHA-256 hashed at rest and only shown once at creation time
- Admin password comparison uses `crypto.timingSafeEqual`
- Session cookies are `HttpOnly`; `Secure` is auto-enabled when `PUBLIC_URL`
  is HTTPS (or via `COOKIE_SECURE=1`)
- Login and send endpoints have configurable per-IP rate limiting
- Token scopes (`personal:send`, `groups:send`, `channels:read`, etc.) restrict
  what each API key can do
- The container nginx binds to `127.0.0.1` by default so the UI is not
  exposed on the LAN unless you opt in via `BIND_HOST=0.0.0.0`

### What WPP does NOT protect against

- A compromised host. The session files in `data/wa-session/` are full
  WhatsApp credentials; anyone with that directory can hijack your account
- Running directly on the public internet without an authenticating proxy
- WhatsApp policy enforcement. Baileys is an unofficial client; using this
  may violate WhatsApp's Terms of Service and could result in your account
  being banned. Use at your own risk.

## Operational guidance

- Generate `JWT_SECRET` with `openssl rand -hex 32` — do not reuse the
  placeholder. The server refuses to start with the default value
- Set a strong `ADMIN_PASS` — the server refuses to start while it is `changeme`
- Keep `data/` backed up and **encrypted at rest** if your host filesystem
  is not encrypted
- Rotate API tokens periodically; revoke unused ones via the Tokens page
- Keep Baileys up to date — WhatsApp protocol changes occasionally, and old
  versions can lock out
