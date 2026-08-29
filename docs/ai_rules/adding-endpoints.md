# Adding an endpoint

Routes live under `server/src/api/`, one file per resource, each a default-exported
Fastify plugin. Routes are declared **without** the `/api` prefix — nginx strips it.

## The steps

1. **Pick the file.** An existing resource file, or a new one for a genuinely new noun.
2. **Pick the guard**, in the route options, never inside the handler:
   - `preHandler: requireScope('channels:read')` — usable by a token.
   - `preHandler: fastify.requireSession` — console only. Use this for anything that
     changes configuration or bypasses the whitelist.
3. **Validate input first**, returning `400 BAD_INPUT` before touching WhatsApp or the DB.
4. **Register it** in `server/src/index.js` if the file is new.
5. **Document it** in `docs/endpoints.md`. An undocumented route does not exist.
6. **Expose it in the CLI** if a machine would want it: a subparser plus a branch in
   `run_api_command`, and a section in `docs/cli.md`.

## The shape

```js
export default async function thingRoutes(fastify) {
  fastify.get('/things/:id', {
    preHandler: requireScope('channels:read'),
  }, async (request, reply) => {
    const id = request.params.id
    if (!id) {
      return reply.code(400).send({ error: 'id required', code: 'BAD_INPUT' })
    }

    const row = db.prepare('SELECT * FROM things WHERE id = ?').get(id)
    if (!row) {
      return reply.code(404).send({ error: 'Thing not found', code: 'NOT_FOUND' })
    }

    return row
  })
}
```

## If it touches WhatsApp

Use `ensureConnected()` from `wa/client.js`, not `getSock()` — it returns `null` unless the
socket is actually linked, so the route can answer `503 WA_DISCONNECTED` instead of
throwing.

```js
const sock = ensureConnected()
if (!sock) {
  return reply.code(503).send({ error: 'WhatsApp not connected', code: 'WA_DISCONNECTED' })
}
```

## If it accepts a JID

Run user input through `toJid()` so `+971501234567` and `971501234567@s.whatsapp.net` both
work. For **reads**, also expand through `expandJids()` — a DM lives under a phone-number
JID, a `@lid` JID, or both, and reading only one silently returns half the conversation.

## If it sends

Add the rate limit config the other send routes use:

```js
config: config.rateLimitSend > 0
  ? { rateLimit: { max: config.rateLimitSend, timeWindow: '1 minute' } }
  : {},
```

## Adding a scope

Four places, and the test that pins them together:

1. `VALID_SCOPES` in `server/src/middleware/token.js`
2. `SCOPE_GROUPS` in `ui/src/pages/Tokens.jsx`
3. The scope tables in `docs/endpoints.md` and `README.md`
4. `EXPECTED` in `server/tests/scopes.test.js`
