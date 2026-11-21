import { test, after } from 'node:test'
import assert from 'node:assert/strict'

Object.assign(process.env, {
  PERSONAL_NUMBERS: '+15555550999', ADMIN_USER: 'test', ADMIN_PASS: 'test-only-password', JWT_SECRET: 'test-only-secret-'.repeat(3), DB_PATH: ':memory:',
})
const { db } = await import('../src/db/index.js')
const { SqliteSessionStore } = await import('../src/db/sessionStore.js')
const { default: Fastify } = await import('fastify')
const { default: cookie } = await import('@fastify/cookie')
const { default: session } = await import('@fastify/session')

const store = new SqliteSessionStore({ ttlMs: 60_000 })
after(() => { clearInterval(store.timer); db.close() })

const call = (method, ...args) => new Promise((resolve, reject) =>
  store[method](...args, (err, value) => (err ? reject(err) : resolve(value))))

async function makeApp() {
  const app = Fastify()
  await app.register(cookie)
  await app.register(session, {
    secret: 'test-only-secret-'.repeat(3),
    store,
    cookie: { secure: false, maxAge: 60_000 },
  })
  app.post('/login', async (request) => { request.session.authenticated = true; return { ok: true } })
  app.get('/me', async (request) => ({ authenticated: Boolean(request.session.authenticated) }))
  app.post('/bump', async (request) => { request.session.count = (request.session.count || 0) + 1; return { count: request.session.count } })
  return app
}

// The console's whole sign-in depends on this: with rolling sessions every
// request re-saves through compareAndSet, so a wrong generation check signs the
// owner out on the next click.
test('a console session survives repeated requests and keeps its changes', async () => {
  const app = await makeApp()
  const login = await app.inject({ method: 'POST', url: '/login' })
  assert.equal(login.statusCode, 200)
  const sid = login.cookies.find(c => c.name === 'sessionId')
  assert.ok(sid, 'login sets a session cookie')
  const headers = { cookie: `sessionId=${sid.value}` }

  for (let i = 1; i <= 3; i++) {
    const bump = await app.inject({ method: 'POST', url: '/bump', headers })
    assert.equal(bump.statusCode, 200)
    assert.equal(bump.json().count, i)
  }
  const me = await app.inject({ method: 'GET', url: '/me', headers })
  assert.equal(me.statusCode, 200)
  assert.deepEqual(me.json(), { authenticated: true })
  await app.close()
})

test('compareAndSet refuses a stale or missing session and accepts the current one', async () => {
  await call('set', 'sid-1', { cookie: {}, value: 'a' })
  await call('compareAndSet', 'sid-1', 'sid-1', { cookie: {}, value: 'b' })
  assert.equal((await call('get', 'sid-1')).value, 'b')

  await call('set', 'sid-2', { cookie: {}, __fastifySessionMetadata: { generation: 'gen-2' } })
  await assert.rejects(call('compareAndSet', 'sid-2', 'gen-1', { cookie: {} }), { code: 'ENOENT' })
  await call('compareAndSet', 'sid-2', 'gen-2', { cookie: {}, value: 'c' })
  assert.equal((await call('get', 'sid-2')).value, 'c')

  await assert.rejects(call('compareAndSet', 'missing', 'missing', { cookie: {} }), { code: 'ENOENT' })
})
