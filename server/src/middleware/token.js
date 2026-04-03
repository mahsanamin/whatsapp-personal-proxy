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
