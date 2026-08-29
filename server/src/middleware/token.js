import crypto from 'node:crypto'
import { db } from '../db/index.js'

const VALID_SCOPES = [
  'personal:send',
  'others:send',
  'others:whitelist:read',
  'others:whitelist:manage',
  'groups:send',
  'channels:read',
  'channels:summarize',
  'tabs:manage',
  'wa:admin',
]

export { VALID_SCOPES }

export function requireScope(scope) {
  return async (request, reply) => {
    // Web UI session has full access
    if (request.session?.authenticated) return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    }

    const raw = auth.slice(7)
    const hash = crypto.createHash('sha256').update(raw).digest('hex')

    const token = db.prepare(
      'SELECT id, name, scopes, revoked FROM tokens WHERE token_hash = ?'
    ).get(hash)

    if (!token || token.revoked) {
      return reply.code(401).send({ error: 'Invalid token', code: 'INVALID_TOKEN' })
    }

    const scopes = JSON.parse(token.scopes)
    if (!scopes.includes(scope)) {
      return reply.code(403).send({ error: `Missing scope: ${scope}`, code: 'MISSING_SCOPE' })
    }

    // Update last_used
    db.prepare('UPDATE tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(token.id)
    request.token = { ...token, scopes }
  }
}

/**
 * Identify the caller without enforcing a scope.
 * Returns { type: 'session', scopes: VALID_SCOPES } for the web console,
 * { type: 'token', id, name, scopes } for a Bearer token, or null.
 */
export function identifyCaller(request) {
  if (request.session?.authenticated) {
    return { type: 'session', name: 'web console', scopes: [...VALID_SCOPES] }
  }

  // Header only. A token in a query string leaks into nginx access logs, any
  // fronting proxy's logs, browser history, and Referer headers.
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const raw = auth.slice(7)

  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const token = db.prepare(
    'SELECT id, name, scopes, revoked, created_at, last_used FROM tokens WHERE token_hash = ?'
  ).get(hash)

  if (!token || token.revoked) return null

  db.prepare('UPDATE tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(token.id)

  return {
    type: 'token',
    id: token.id,
    name: token.name,
    scopes: JSON.parse(token.scopes),
    created_at: token.created_at,
    last_used: token.last_used,
  }
}

/**
 * Authenticate without demanding a specific scope, and expose the caller on
 * the request. For routes whose required scope depends on the destination —
 * a media send needs groups:send or others:send depending on where it is going.
 */
export async function requireAnyCredential(request, reply) {
  const caller = identifyCaller(request)
  if (!caller) {
    return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
  }
  request.token = caller
}
