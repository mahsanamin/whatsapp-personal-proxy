# Testing

Two suites, no frameworks, no new dependencies. `./proxy test` runs both.

```bash
cd server && npm test                              # node:test
python3 -m unittest discover -s tests/cli -t .     # CLI
```

## Server (`server/tests/`, node:test)

The server's interesting behaviour is mostly I/O against WhatsApp and SQLite, which is
not worth mocking. What the unit suite covers is the things that break silently:

- **Pure helpers** (`util/jid.js`) — number parsing and JID classification, tested
  directly. This is why `util/` must not import the database: these tests run with no
  native build and no `npm install`.
- **Contracts that span files** — the scope list appears in the middleware, the console
  picker, the docs, and the CLI's routes. Drift between them silently grants or denies
  access and no single-file test would notice, so `scopes.test.js` reads the sources as
  text and pins them together.

Prefer a contract test over a mock. If a change needs elaborate mocking to test, that
usually means the logic wants extracting into `util/` first.

## CLI (`tests/cli/test_wpp.py`, unittest)

The CLI is imported as a module with `WPP_CONFIG` pointed at a temp file, and `api_call`
is patched, so the suite never touches a real server. Covered:

- Number and URL parsing, including what must be **rejected**.
- Config store round-trip, and that the saved file is mode `0600` — a token in a
  world-readable file is a real leak, so that assertion stays.
- Target resolution: JIDs and numbers resolve with no network call at all; a name
  resolves via search; an exact name beats a partial match; an ambiguous name **refuses**
  rather than guessing which chat to message.
- Send routing, including the fallback when the cached personal-number list is stale, and
  that an explicit `--route` is never second-guessed.
- The confirmation gate: a non-interactive write without `--yes` must fail.

## What a change owes the suite

- A new pure helper: a test.
- A new scope: add it to `EXPECTED` in `scopes.test.js`.
- A new CLI routing or resolution rule: a test, especially for the refusal case.
- A bug fix: a test that fails before it.

Adding a route does not require an integration test, but it does require the docs entry —
`scopes.test.js` will fail if a scope goes undocumented.
