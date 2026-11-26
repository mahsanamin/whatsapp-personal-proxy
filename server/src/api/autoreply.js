import { requireScope } from '../middleware/token.js'
import { requireSession } from '../middleware/session.js'
import { toJid } from '../util/jid.js'
import { expandJids, canonicalJid, resolveNames } from '../db/lidmap.js'
import { isOwnJid } from '../wa/client.js'
import { senderIdentity, writeGeneratedReply } from '../wa/autoreply.js'
import {
  MODES, MESSAGE_TYPES, validateRuleSet, findMatchingRule, renderResponse, scopeRefusal,
  decide, stateChangeRefusal, usesModel, MODEL_REFUSAL,
} from '../util/autoreply.js'
import {
  isEnabled, setEnabled, listRuleSets, getRuleSet, createRuleSet, updateRuleSet,
  deleteRuleSet, setRuleSetState, isAllowlisted, listDecisions, contactSnapshot,
  listContacts, saveContact, unmuteContact, senderKey,
  getServerLimits, saveLimitOverrides, clearLimitOverrides,
} from '../db/autoreply.js'
import { LIMIT_BOUNDS, validateLimitsPatch } from '../util/autoreplyLimits.js'

const manage = requireScope('autoreply:manage')

/** The template as text: uploaded text is kept verbatim, an object is pretty-printed. */
function templateText(body) {
  const template = body?.template
  if (typeof template === 'string') return template
  if (template && typeof template === 'object') return JSON.stringify(template, null, 2)
  return null
}

function invalid(reply, errors) {
  return reply.code(400).send({
    error: `Template is not valid: ${errors[0].path ? `${errors[0].path}: ` : ''}${errors[0].message}`,
    code: 'BAD_INPUT',
    details: errors,
  })
}

function settings() {
  const { limits, defaults, overridden } = getServerLimits()
  return { enabled: isEnabled(), limits, defaults, overridden, bounds: LIMIT_BOUNDS }
}

const isSession = (request) => Boolean(request.session?.authenticated)
const refuse = (reply, refusal) => reply.code(refusal.status).send({ error: refusal.error, code: refusal.code })

const notFound = (reply) => reply.code(404).send({ error: 'Rule set not found', code: 'NOT_FOUND' })

export default async function autoreplyRoutes(fastify) {
  fastify.get('/autoreply/settings', { preHandler: manage }, async () => settings())

  // The kill switch. Console only: turning it on lets the server send.
  fastify.put('/autoreply/settings', { preHandler: requireSession }, async (request, reply) => {
    const { enabled } = request.body || {}
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Field "enabled" must be true or false', code: 'BAD_INPUT' })
    }
    setEnabled(enabled)
    return settings()
  })

  // Console only, like the kill switch: raising a cap lets the server send more.
  // Rule sets are not touched, so a live one stays live.
  fastify.put('/autoreply/limits', { preHandler: requireSession }, async (request, reply) => {
    const { ok, errors, values } = validateLimitsPatch(request.body)
    if (!ok) return reply.code(400).send({ error: errors.join('; '), code: 'BAD_INPUT', details: errors })
    saveLimitOverrides(values)
    return settings()
  })

  fastify.delete('/autoreply/limits', { preHandler: requireSession }, async () => {
    clearLimitOverrides()
    return settings()
  })

  fastify.get('/autoreply/rulesets', { preHandler: manage }, async () => listRuleSets())

  fastify.post('/autoreply/rulesets', { preHandler: manage }, async (request, reply) => {
    const text = templateText(request.body)
    if (text === null) {
      return reply.code(400).send({ error: 'Field "template" required (JSON text or object)', code: 'BAD_INPUT' })
    }
    const { ok, errors, ruleSet } = validateRuleSet(text)
    if (!ok) return invalid(reply, errors)
    if (usesModel(ruleSet) && !isSession(request)) return refuse(reply, MODEL_REFUSAL)
    return reply.code(201).send(createRuleSet(text, ruleSet))
  })

  fastify.get('/autoreply/rulesets/:id', { preHandler: manage }, async (request, reply) => {
    return getRuleSet(request.params.id) || notFound(reply)
  })

  fastify.get('/autoreply/rulesets/:id/download', { preHandler: manage }, async (request, reply) => {
    const row = getRuleSet(request.params.id)
    if (!row) return notFound(reply)
    const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule-set'
    return reply
      .header('Content-Disposition', `attachment; filename="${slug}.json"`)
      .type('application/json; charset=utf-8')
      .send(row.template)
  })

  fastify.put('/autoreply/rulesets/:id', { preHandler: manage }, async (request, reply) => {
    if (!getRuleSet(request.params.id)) return notFound(reply)
    const text = templateText(request.body)
    if (text === null) {
      return reply.code(400).send({ error: 'Field "template" required (JSON text or object)', code: 'BAD_INPUT' })
    }
    const { ok, errors, ruleSet } = validateRuleSet(text)
    if (!ok) return invalid(reply, errors)
    if (usesModel(ruleSet) && !isSession(request)) return refuse(reply, MODEL_REFUSAL)
    return updateRuleSet(request.params.id, text, ruleSet)
  })

  fastify.patch('/autoreply/rulesets/:id', { preHandler: manage }, async (request, reply) => {
    const { mode, active } = request.body || {}
    if (mode !== undefined && !MODES.includes(mode)) {
      return reply.code(400).send({ error: `Field "mode" must be one of ${MODES.join(', ')}`, code: 'BAD_INPUT' })
    }
    if (active !== undefined && typeof active !== 'boolean') {
      return reply.code(400).send({ error: 'Field "active" must be true or false', code: 'BAD_INPUT' })
    }
    if (mode === undefined && active === undefined) {
      return reply.code(400).send({ error: 'Send "mode", "active", or both', code: 'BAD_INPUT' })
    }

    const current = getRuleSet(request.params.id)
    if (!current) return notFound(reply)

    const refusal = stateChangeRefusal({
      isSession: Boolean(request.session?.authenticated),
      current,
      next: { mode, active },
    })
    if (refusal) return refuse(reply, refusal)

    const checked = validateRuleSet(current.template)
    if (active === true && !checked.ok) {
      return reply.code(400).send({ error: 'Fix the template before activating it', code: 'BAD_INPUT' })
    }
    if (active === true && usesModel(checked.ruleSet) && !isSession(request)) return refuse(reply, MODEL_REFUSAL)
    return setRuleSetState(current.id, { mode, active })
  })

  fastify.delete('/autoreply/rulesets/:id', { preHandler: manage }, async (request, reply) => {
    if (!deleteRuleSet(request.params.id)) return notFound(reply)
    return { ok: true }
  })

  fastify.post('/autoreply/validate', { preHandler: manage }, async (request, reply) => {
    const text = templateText(request.body)
    if (text === null) {
      return reply.code(400).send({ error: 'Field "template" required (JSON text or object)', code: 'BAD_INPUT' })
    }
    const { ok, errors, warnings, ruleSet } = validateRuleSet(text)
    return {
      valid: ok,
      errors,
      warnings,
      summary: ok
        ? { name: ruleSet.name, version: ruleSet.version, rules: ruleSet.rules.length, fallback: Boolean(ruleSet.fallback), scope: ruleSet.scope }
        : null,
    }
  })

  // Simulate one incoming message. Nothing is sent and nothing is logged. An
  // "llm" rule does call the model, so the reply is fresh every time.
  fastify.post('/autoreply/test', {
    preHandler: manage,
    // A test of an "llm" rule calls the model gateway, which costs money.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = request.body || {}
    const chatJid = toJid(body.chat)
    if (!chatJid) {
      return reply.code(400).send({ error: 'Field "chat" must be a number or JID', code: 'BAD_INPUT' })
    }
    if (typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'Field "text" required', code: 'BAD_INPUT' })
    }
    const type = body.type ?? 'text'
    if (!MESSAGE_TYPES.includes(type)) {
      return reply.code(400).send({ error: `Field "type" must be one of ${MESSAGE_TYPES.join(', ')}`, code: 'BAD_INPUT' })
    }
    if (body.saved !== undefined && typeof body.saved !== 'boolean') {
      return reply.code(400).send({ error: 'Field "saved" must be true or false', code: 'BAD_INPUT' })
    }

    let ruleSet
    let rulesetId = null
    const text = templateText(body)
    if (text !== null) {
      const result = validateRuleSet(text)
      if (!result.ok) return invalid(reply, result.errors)
      ruleSet = result.ruleSet
      if (usesModel(ruleSet) && !isSession(request)) return refuse(reply, MODEL_REFUSAL)
    } else if (body.ruleset_id) {
      const row = getRuleSet(body.ruleset_id)
      if (!row) return notFound(reply)
      const result = validateRuleSet(row.template)
      if (!result.ok) return invalid(reply, result.errors)
      ruleSet = result.ruleSet
      if (usesModel(ruleSet) && !isSession(request)) return refuse(reply, MODEL_REFUSAL)
      rulesetId = row.id
    } else {
      return reply.code(400).send({ error: 'Send "template" or "ruleset_id"', code: 'BAD_INPUT' })
    }

    const nowMs = Date.now()
    const aliases = expandJids(chatJid)
    // The address book decides who counts as saved, as it does for a real
    // message. "saved" and "sender_name" let the owner try the other case.
    // A token sees no saved names: only the console reads the address book.
    const sender = senderIdentity(chatJid)
    const senderSaved = body.saved ?? sender.senderSaved
    const ownName = typeof body.sender_name === 'string' ? body.sender_name : null
    const senderName = senderSaved ? (ownName ?? (isSession(request) ? sender.senderName : null)) : null
    const message = { type, text: body.text, chatAliases: aliases, senderName, senderSaved }

    const scopeReason = scopeRefusal(ruleSet.scope, {
      chatJid, aliases, allowlisted: isAllowlisted(aliases), isOwn: isOwnJid(chatJid),
    })
    const rule = findMatchingRule(ruleSet, message)
    const decision = scopeReason
      ? { action: 'skip', reason: scopeReason, rule: null, text: null }
      : decide({
        ruleSet,
        message,
        nowMs,
        stats: contactSnapshot({ ruleSet, rulesetId, chatJid, senderJid: chatJid, text: body.text, action: 'sent', nowMs }).stats,
        limits: getServerLimits().limits,
      })

    let generated = false
    if (decision.action === 'reply' && decision.generate) {
      const written = await writeGeneratedReply({ decision, ruleSet, message, chatAliases: aliases, messageId: null, nowMs })
      generated = written.generated
      decision.reason = written.reason
      decision.text = written.text
      if (!written.text) decision.action = 'skip'
    }

    reply.header('Cache-Control', 'no-store')
    return {
      chat: chatJid,
      in_scope: !scopeReason,
      scope_reason: scopeReason,
      sender_saved: senderSaved,
      match: rule
        ? {
          rule_id: rule.id,
          response_type: rule.response.type,
          reply: rule.response.type === 'text'
            ? renderResponse(rule.response, { senderName, senderSaved, nowMs, timezone: ruleSet.options.timezone })
            : null,
        }
        : null,
      decision: {
        action: decision.action === 'reply' ? 'would_send' : 'skip',
        reason: decision.reason,
        rule_id: decision.rule?.id ?? null,
        reply: decision.text,
        generated,
      },
    }
  })

  fastify.get('/autoreply/contacts', { preHandler: manage }, async () => {
    const rows = listContacts(Date.now())
    const names = resolveNames([...new Set(rows.flatMap(r => [r.chat_jid, r.sender_jid].filter(Boolean)))])
    return rows.map(row => ({
      ...row,
      name: names.get(row.sender_jid || row.chat_jid) || null,
    }))
  })

  // Muting only ever stops replies, so a token may do it.
  fastify.post('/autoreply/contacts/:jid/mute', { preHandler: manage }, async (request, reply) => {
    const chatJid = toJid(request.params.jid)
    if (!chatJid) {
      return reply.code(400).send({ error: 'A number or chat JID is required', code: 'BAD_INPUT' })
    }
    const minutes = request.body?.minutes ?? 24 * 60
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 365) {
      return reply.code(400).send({ error: 'Field "minutes" must be from 1 to 525600', code: 'BAD_INPUT' })
    }
    const nowMs = Date.now()
    const key = canonicalJid(chatJid)
    saveContact(key, { muted_until: nowMs + minutes * 60_000, mute_reason: 'manual' }, nowMs)
    return { ok: true, contact: key, muted_until: nowMs + minutes * 60_000 }
  })

  // Unmuting lets replies flow again, so like everything else that can lead
  // to a send it is console only.
  fastify.delete('/autoreply/contacts/:jid/mute', { preHandler: requireSession }, async (request, reply) => {
    const raw = String(request.params.jid || '')
    // A sender muted inside a group is addressed as "<group>|<sender>".
    const [chatPart, senderPart] = raw.split('|')
    const chatJid = toJid(chatPart)
    if (!chatJid) {
      return reply.code(400).send({ error: 'A number or chat JID is required', code: 'BAD_INPUT' })
    }
    const keys = senderPart
      ? expandJids(senderPart).map(alias => senderKey(chatJid, alias))
      : expandJids(chatJid)
    unmuteContact(keys, Date.now())
    return { ok: true }
  })

  fastify.get('/autoreply/decisions', { preHandler: manage }, async (request) => {
    const limit = parseInt(request.query?.limit || '100', 10) || 100
    return listDecisions({ limit, rulesetId: request.query?.ruleset_id || null })
  })
}
