# Code conventions

## Everywhere

- Comments explain **why**, never what. If a line needs a comment to say what it does,
  rewrite the line.
- Match the surrounding file's style rather than importing a new one.
- No new runtime dependencies without a reason that survives being said out loud.

## Server (Node)

- ESM only (`"type": "module"`). No `require`.
- Two-space indent, no semicolons, single quotes — matching the existing files.
- One resource per file under `src/api/`, each exporting a default Fastify plugin.
- Every route declares its guard in the route options, never inline in the handler:
  `preHandler: requireScope('channels:read')` or `preHandler: fastify.requireSession`.
- Database access goes through prepared statements. Never interpolate a value into SQL;
  build the placeholder list instead.
- Pure helpers belong in `src/util/`, which must not import the database — that keeps
  them testable without the native `better-sqlite3` build.

## CLI (`wpp`)

- **Standard library only.** This is the whole point: a new machine gets working with
  one `curl` and nothing else. A dependency would break that.
- Python 3.9 syntax. No `match`, no `X | Y` type unions, no walrus in new code.
- One file. Resist splitting it — it is served verbatim from `/api/cli/wpp`.
- Every command returns a dict from `ok(...)`; `main()` does the printing.
- Never print anything that is not JSON to stdout.

## UI (React)

- Function components with hooks. No class components.
- Tailwind utility classes inline; no separate stylesheets beyond `index.css`.
- All fetches go through `api()` in `src/api/client.js`, which handles the `/api` prefix,
  credentials, and error unwrapping.
