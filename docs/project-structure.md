# Project structure

```
whatsapp-personal-proxy/
├── proxy                       Stack control: init, start, stop, logs, status, test
├── wpp                         The CLI itself — one file, standard library only.
│                               Bundled into the server image and served at /api/cli/wpp
├── Makefile                    Thin wrapper over ./proxy
├── docker-compose.yml          Production stack
├── docker-compose.override.yml Development overrides (hot reload)
├── .env.example                Committed template; .env is gitignored
│
├── nginx/nginx.conf            Edge proxy: /api/* and /ws → server, /* → ui
│
├── server/                     Node 20 + Fastify + Baileys + SQLite
│   ├── Dockerfile              Built from the repo root so `wpp` can be bundled
│   ├── src/
│   │   ├── index.js            Entrypoint: plugins, route registration, listen
│   │   ├── config.js           Env validation. Exits rather than start misconfigured
│   │   ├── db/
│   │   │   ├── index.js        better-sqlite3 handle and pragmas
│   │   │   ├── migrations.js   Schema, idempotent
│   │   │   └── lidmap.js       LID ⇄ phone-number JID expansion
│   │   ├── wa/
│   │   │   ├── client.js       Baileys socket, event ingestion, name resolution
│   │   │   └── media.js        On-demand media download. Never automatic
│   │   ├── api/                One file per resource, each a Fastify plugin
│   │   │   ├── auth.js         Console login, /auth/test, QR endpoints
│   │   │   ├── tokens.js       API token CRUD (console session only)
│   │   │   ├── cli.js          Serves the wpp script and its install command
│   │   │   ├── channels.js     Chat list, chat detail, live group list
│   │   │   ├── messages.js     Message reads, search, media
│   │   │   ├── events.js       SSE stream for the CLI
│   │   │   ├── personal.js     Sends to PERSONAL_NUMBERS
│   │   │   ├── others.js       Sends to whitelisted numbers
│   │   │   ├── groups.js       Sends to groups
│   │   │   ├── whitelist.js    Whitelist CRUD
│   │   │   └── tabs.js         Console tab CRUD
│   │   ├── ws/index.js         WebSocket for the console
│   │   ├── middleware/
│   │   │   ├── session.js      Console session guard
│   │   │   └── token.js        Bearer tokens, scopes, caller identification
│   │   └── util/jid.js         Pure JID helpers (no DB import — testable anywhere)
│   └── tests/                  node:test, no framework
│
├── ui/                         React 18 + Vite + Tailwind
│   └── src/pages/
│       ├── Login.jsx           Console sign-in
│       ├── Connect.jsx         QR code — the only place WhatsApp gets linked
│       ├── Workspace.jsx       Tabs, chat list, message view, manual send
│       └── Tokens.jsx          API keys and the CLI install command
│
├── tests/cli/test_wpp.py       CLI tests, standard library unittest
└── docs/
    ├── cli.md                  Using wpp from another machine
    ├── endpoints.md            Every route, its auth, and its scope
    ├── architecture.md         How the pieces fit, and the LID/PN quirk
    ├── configuration.md        Every .env knob
    └── ai_rules/               Conventions any change must follow
```

## Where to put a change

| Change | Goes in |
|---|---|
| New API route | `server/src/api/<resource>.js`, registered in `index.js`, documented in `docs/endpoints.md` |
| New scope | `VALID_SCOPES` in `middleware/token.js`, the console picker, `docs/endpoints.md`, and the test in `server/tests/scopes.test.js` |
| New CLI command | A subparser plus a branch in `run_api_command` in `wpp`, and a section in `docs/cli.md` |
| WhatsApp protocol handling | `server/src/wa/client.js` |
| Anything about JIDs | `server/src/util/jid.js` if pure, `server/src/db/lidmap.js` if it needs the database |
