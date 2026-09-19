import { db } from '../db/index.js'
import { expandJids } from '../db/lidmap.js'
import { isGroup } from './jid.js'
import { isOwnJid } from '../wa/client.js'

/**
 * The single decision point for "may this caller message this JID".
 *
 * Every send route asks this. It used to be duplicated per route, which is how
 * group sends ended up with no allow-list check at all while DMs had one.
 *
 * Returns null when allowed, or { status, error, code } to send back.
 */
export function checkSendPermission(request, jid, route = null) {
  if (!jid) {
    return { status: 400, error: 'A destination is required', code: 'BAD_INPUT' }
  }

  const scopes = request.token?.scopes || []
  const isSession = request.session?.authenticated
  const isPersonal = isOwnJid(jid)

  // Keep /personal/send's contract exact. Check the scope first so a token
  // without personal:send cannot probe which numbers belong to the owner.
  if (route === 'personal') {
    if (!isSession && !scopes.includes('personal:send')) {
      return { status: 403, error: 'Missing scope: personal:send', code: 'MISSING_SCOPE' }
    }
    if (!isPersonal) {
      return {
        status: 403,
        error: 'Number is not one of the owner\'s personal numbers',
        code: 'NOT_PERSONAL_NUMBER',
      }
    }
    return null
  }

  // The console is the owner. It may message anyone.
  if (isSession) return null

  if (isGroup(jid)) {
    if (!scopes.includes('groups:send')) {
      return { status: 403, error: 'Missing scope: groups:send', code: 'MISSING_SCOPE' }
    }
    if (!isAllowed(jid)) {
      return {
        status: 403,
        error: 'Group is not on the allow list. Add it in the console under Allow list.',
        code: 'NOT_WHITELISTED',
      }
    }
    return null
  }

  if (isPersonal) {
    if (!scopes.includes('personal:send')) {
      return { status: 403, error: 'Missing scope: personal:send', code: 'MISSING_SCOPE' }
    }
    return null
  }

  if (!scopes.includes('others:send')) {
    return { status: 403, error: 'Missing scope: others:send', code: 'MISSING_SCOPE' }
  }
  if (!isAllowed(jid)) {
    return {
      status: 403,
      error: 'Recipient is not on the allow list. Add them in the console under Allow list.',
      code: 'NOT_WHITELISTED',
    }
  }
  return null
}

function isAllowed(jid) {
  try {
    const lookup = db.prepare('SELECT id FROM whitelist WHERE jid = ?')
    return expandJids(jid).some(alias => Boolean(lookup.get(alias)))
  } catch (_) {
    // Fail closed: an unreadable allow list must not become an open one.
    return false
  }
}

/** Reply with the refusal, or return false if the send may proceed. */
export function refuseIfNotAllowed(request, reply, jid, route = null) {
  const refusal = checkSendPermission(request, jid, route)
  if (!refusal) return false
  reply.code(refusal.status).send({ error: refusal.error, code: refusal.code })
  return true
}
