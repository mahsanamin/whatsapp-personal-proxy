# Working on this repository

Start with `CLAUDE.md` for the shape of the project, then `docs/ai_rules/` for the rules
any change must follow. `docs/project-structure.md` says where a given change belongs.

## Before you change anything

1. `docs/ai_rules/security.md` — this proxy holds a live WhatsApp account. A mistake here
   does not corrupt data, it lets someone else be you.
2. `docs/ai_rules/code-conventions.md` — especially: the `wpp` CLI takes **no**
   dependencies, ever. That is what makes it installable anywhere with one `curl`.
3. `docs/ai_rules/adding-endpoints.md` — if you are adding a route.

## Checks

```bash
./proxy test    # server (node:test) + CLI (unittest)
```

`.githooks/pre-push` additionally builds the UI, audits dependencies, and sweeps for
leaked personal data. Enable it once: `git config core.hooksPath .githooks`.

## Things that look like bugs but are not

- **Routes have no `/api` prefix.** nginx strips it. `/channels` is served at
  `/api/channels`.
- **`requireScope` lets a console session through unconditionally.** The console is the
  owner. A route guarded only by `requireSession` is therefore console-only.
- **`/api/cli/wpp` is unauthenticated.** A new machine needs the script before it has a
  token, and the script holds no secrets.
- **The UI container listens on 5173, not 80.** So one nginx upstream is correct in both
  development and production.
- **Message ingestion swallows per-message errors.** WhatsApp sends message types this
  code has never seen; one bad payload must not kill the socket.

## Using WPP as an agent

Install the CLI, connect it with its own scoped token, and read `docs/cli.md`. The output
is JSON on stdout, structured errors on stderr, nonzero exit on failure.

**Only pass `--yes` to a write after the user has authorized that exact recipient and
message.** Sending a WhatsApp message is not reversible.
