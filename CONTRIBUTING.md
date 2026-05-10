# Contributing

Thanks for your interest! WPP is a small personal-use project, so the bar is
"does it help me or another self-hoster" rather than "does it scale to a
million users."

## Ground rules

- **One feature per PR.** Easier to review, easier to revert.
- **Match the existing style.** ESM everywhere, minimal abstractions, no new
  frameworks unless there's a real reason.
- **Don't break the threat model** in [SECURITY.md](SECURITY.md). If you
  change the auth, cookie, or proxy story, call it out in the PR.
- **No telemetry, no analytics, no remote calls** beyond what Baileys needs
  to talk to WhatsApp.

## Local setup

```bash
git clone git@github.com:mahsanamin/whatsapp-personal-proxy.git
cd whatsapp-personal-proxy
git config core.hooksPath .githooks   # turn on pre-push checks
make init                              # creates data/, copies .env.example → .env
# edit .env, then:
make dev
```

## Running checks manually

```bash
# Per-package audit + lock-file check
(cd server && npm audit --audit-level=high && npm ls)
(cd ui     && npm audit --audit-level=high && npm ls && npm run build)
(cd cli    && npm audit --audit-level=high && npm ls)
```

## Reporting bugs

Open an issue with the WPP version, your `PUBLIC_URL` setup
(Tailscale / host-nginx / direct), and the relevant slice of `make logs`
output. Strip session strings before pasting.

## Reporting vulnerabilities

Don't open a public issue — see [SECURITY.md](SECURITY.md).
