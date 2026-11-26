/**
 * The auto-reply engine's decisions, kept free of the database and of
 * WhatsApp so every rule that keeps it from misfiring is testable directly.
 *
 * Incoming message text is untrusted. Here it is only ever compared against
 * rules. It never becomes a recipient, a rule, config, or part of a reply.
 */

import { createHash } from 'node:crypto'

export const FORMAT_VERSION = 1
export const MODES = ['off', 'dry_run', 'live']
export const DEFAULT_TIMEZONE = 'Asia/Singapore'
export const DEFAULT_PAUSE_AFTER_MANUAL_REPLY_MINUTES = 30

// Text a rule can be answered with. Reactions, protocol messages and unknown
// payloads are never answered, so they are deliberately absent.
export const MESSAGE_TYPES = ['text', 'image', 'video', 'doc', 'audio', 'voice', 'sticker', 'location', 'contact', 'album']

export const LIMITS = {
  maxTemplateBytes: 64 * 1024,
  maxRules: 100,
  maxKeywords: 100,
  maxChats: 500,
  maxRegexLength: 200,
  // Backtracking budget: the input length times the product of every
  // repeat's maximum count. One unbounded repeat over 500 characters fits;
  // two, or a handful of {0,40}s in a row, do not.
  maxRegexCost: 1e7,
  maxTemplateRegexCost: 2e7,
  maxTemplateProbeMs: 250,
  // Keywords and exact text look at this much of a message.
  maxMatchChars: 2000,
  // A regex sees less: even a pattern that passes every check below can be
  // polynomial, and this keeps the worst case small.
  maxRegexInputChars: 500,
  maxResponseChars: 4096,
  maxNameChars: 40,
  maxWindows: 10,
  maxStatusChars: 200,
  maxInstructionsChars: 4000,
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
export const SENDER_KINDS = ['saved', 'unknown']
export const LLM_DEFAULTS = { context_messages: 10, max_chars: 400 }
const LLM_KEYS = ['type', 'model', 'instructions', 'context_messages', 'max_chars', 'fallback_text']
const LLM_MODEL = /^[A-Za-z0-9._:/-]{1,64}$/
const NAME_PLACEHOLDERS = ['name', 'first_name']

const PLACEHOLDERS = ['name', 'first_name', 'date', 'time']
const RESPONSE_TYPES = ['text', 'llm']
const TOP_LEVEL_KEYS = ['format', 'name', 'version', 'description', 'scope', 'options', 'rules', 'fallback']
const SCOPE_KEYS = ['allowlist', 'chats', 'all_dms', 'blocklist']
const OPTION_KEYS = [
  'timezone', 'cooldown_minutes', 'once_per_chat', 'quiet_hours', 'active_hours',
  'pause_after_manual_reply_minutes', 'max_replies_per_contact_per_hour', 'max_replies_per_contact_per_day',
  'conversation', 'flood', 'loop',
]

export const DEFAULT_CONVERSATION = { gap_minutes: 30, max_replies: 5, backoff_base_minutes: 1, handoff_text: null }
export const DEFAULT_FLOOD = { max_messages: 8, window_seconds: 60, mute_minutes: 360 }
export const DEFAULT_LOOP = { reply_within_seconds: 3, streak: 3, mute_minutes: 1440 }
export const HANDOFF_RULE_ID = '_handoff'
const CONTACT_CAP_KEYS = ['max_replies_per_contact_per_hour', 'max_replies_per_contact_per_day']
const RULE_KEYS = ['id', 'match', 'response', 'cooldown_minutes', 'once_per_chat', 'quiet_hours', 'active_hours', ...CONTACT_CAP_KEYS]
const MATCH_KEYS = ['keywords', 'keywords_mode', 'exact', 'regex', 'types', 'chats', 'from']
const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/
const CHAT_JID = /^(?:\d{5,20}@s\.whatsapp\.net|\d{1,30}@lid|[\d-]{5,60}@g\.us)$/
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// ─── Validation ──────────────────────────────────────────────────────

// Shared by every regex in the template being validated. Validation is
// synchronous, so one module-level budget is safe.
let regexBudget = null

/**
 * Check a rule-set template and return it normalized.
 * Accepts the JSON text or an already-parsed object.
 * Returns { ok, errors: [{ path, message }], ruleSet }.
 */
export function validateRuleSet(input) {
  regexBudget = { cost: LIMITS.maxTemplateRegexCost, ms: LIMITS.maxTemplateProbeMs }
  const errors = []
  const fail = (path, message) => errors.push({ path, message })

  let doc = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > LIMITS.maxTemplateBytes) {
      fail('', `Template is larger than ${LIMITS.maxTemplateBytes / 1024} KB`)
      return { ok: false, errors, warnings: [], ruleSet: null }
    }
    try {
      doc = JSON.parse(input)
    } catch (err) {
      fail('', `Not valid JSON: ${err.message}`)
      return { ok: false, errors, warnings: [], ruleSet: null }
    }
  } else if (isPlainObject(input) && Buffer.byteLength(JSON.stringify(input), 'utf8') > LIMITS.maxTemplateBytes) {
    fail('', `Template is larger than ${LIMITS.maxTemplateBytes / 1024} KB`)
    return { ok: false, errors, warnings: [], ruleSet: null }
  }

  if (!isPlainObject(doc)) {
    fail('', 'Template must be a JSON object')
    return { ok: false, errors, warnings: [], ruleSet: null }
  }

  unknownKeys(doc, TOP_LEVEL_KEYS, '', fail)

  if (doc.format !== FORMAT_VERSION) fail('format', `Must be ${FORMAT_VERSION}`)
  const name = requiredText(doc.name, 'name', 100, fail)
  const version = requiredText(doc.version, 'version', 40, fail)
  const description = optionalText(doc.description, 'description', 1000, fail)

  const scope = validateScope(doc.scope, fail)
  const options = validateSetOptions(doc.options, fail)

  const rules = []
  if (!Array.isArray(doc.rules)) {
    fail('rules', 'Must be a list of rules')
  } else if (doc.rules.length > LIMITS.maxRules) {
    fail('rules', `At most ${LIMITS.maxRules} rules`)
  } else {
    doc.rules.forEach((rule, i) => {
      const normalized = validateRule(rule, `rules[${i}]`, fail, { requireMatch: true })
      if (normalized) rules.push(normalized)
    })
  }

  let fallback = null
  if (doc.fallback !== undefined && doc.fallback !== null) {
    fallback = validateRule(doc.fallback, 'fallback', fail, { requireMatch: false })
  }

  if (Array.isArray(doc.rules) && doc.rules.length === 0 && !fallback) {
    fail('rules', 'Add at least one rule or a fallback')
  }

  const ids = [...rules, ...(fallback ? [fallback] : [])].map(r => r.id)
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) fail('rules', `Rule id "${id}" is used more than once`)
    seen.add(id)
  }

  // Rule indexes only line up when every rule validated.
  if (!errors.length) llmGroupErrors({ scope, rules, fallback }, fail)

  if (errors.length) return { ok: false, errors, warnings: [], ruleSet: null }
  const ruleSet = { format: FORMAT_VERSION, name, version, description, scope, options, rules, fallback }
  return { ok: true, errors: [], warnings: ruleSetWarnings(ruleSet), ruleSet }
}

/**
 * A model reply is for direct chats only: in a group the history would carry
 * other members' words, and the reply would be read by all of them. A rule
 * reaches the groups in its own match.chats, or, with none listed, every
 * group in scope.chats.
 */
function llmGroupErrors({ scope, rules, fallback }, fail) {
  const check = (rule, path) => {
    if (rule.response?.type !== 'llm') return
    const reach = rule.match?.chats?.length ? rule.match.chats : scope.chats
    if (reach.some(jid => jid.endsWith('@g.us'))) {
      fail(`${path}.response`, 'A model-written reply is for direct chats only. List only direct chats in this rule\'s match.chats, or take the groups out of scope.chats')
    }
  }
  rules.forEach((rule, i) => check(rule, `rules[${i}]`))
  if (fallback) check(fallback, 'fallback')
}

const usesName = (text) => typeof text === 'string' && NAME_PLACEHOLDERS.some(key => text.includes(`{${key}}`))

/**
 * Things that are allowed but probably not meant. A sender who is not in the
 * address book is never named (their profile name is their own choice), so a
 * name placeholder in a reply they can receive renders empty.
 */
function ruleSetWarnings(ruleSet) {
  const warnings = []
  const all = [...ruleSet.rules, ...(ruleSet.fallback ? [ruleSet.fallback] : [])]
  let reachesUnknown = false
  all.forEach((rule, i) => {
    const path = rule === ruleSet.fallback ? 'fallback' : `rules[${i}]`
    if (rule.match?.from !== 'unknown') return
    reachesUnknown = true
    const texts = [rule.response?.text, rule.response?.fallback_text]
    if (texts.some(usesName)) {
      warnings.push({ path: `${path}.response`, message: 'This rule only answers unknown senders, so {name} and {first_name} render empty here' })
    }
  })
  // A rule may allow one contact more replies than the set does. That is
  // allowed, but it should be visible, so a raised cap is never an accident.
  all.forEach((rule, i) => {
    const path = rule === ruleSet.fallback ? 'fallback' : `rules[${i}]`
    for (const key of CONTACT_CAP_KEYS) {
      const setCap = ruleSet.options[key]
      if (rule[key] !== undefined && setCap && rule[key] > setCap) {
        warnings.push({ path: `${path}.${key}`, message: `This rule allows ${rule[key]}, more than the set's ${setCap}. The server's cap still applies` })
      }
    }
  })
  if (reachesUnknown && usesName(ruleSet.options.conversation.handoff_text)) {
    warnings.push({ path: 'options.conversation.handoff_text', message: 'Unknown senders can get the handoff, and {name} and {first_name} render empty for them' })
  }
  return warnings
}

function unknownKeys(obj, allowed, path, fail) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(join(path, key), `Unknown field. Allowed: ${allowed.join(', ')}`)
  }
}

const join = (path, key) => (path ? `${path}.${key}` : key)

function requiredText(value, path, max, fail) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(path, 'Required text')
    return null
  }
  if (value.length > max) fail(path, `At most ${max} characters`)
  return value.trim()
}

function optionalText(value, path, max, fail) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    fail(path, 'Must be text')
    return ''
  }
  if (value.length > max) fail(path, `At most ${max} characters`)
  return value.trim()
}

function validateScope(scope, fail) {
  const out = { allowlist: true, chats: [], all_dms: false, blocklist: [] }
  if (scope === undefined || scope === null) return out
  if (!isPlainObject(scope)) {
    fail('scope', 'Must be an object')
    return out
  }
  unknownKeys(scope, SCOPE_KEYS, 'scope', fail)
  if (scope.allowlist !== undefined) {
    if (typeof scope.allowlist !== 'boolean') fail('scope.allowlist', 'Must be true or false')
    else out.allowlist = scope.allowlist
  }
  if (scope.all_dms !== undefined) {
    if (typeof scope.all_dms !== 'boolean') fail('scope.all_dms', 'Must be true or false')
    else out.all_dms = scope.all_dms
  }
  if (scope.chats !== undefined) out.chats = validateChats(scope.chats, 'scope.chats', fail)
  if (scope.blocklist !== undefined) out.blocklist = validateChats(scope.blocklist, 'scope.blocklist', fail)
  if (!out.allowlist && !out.all_dms && out.chats.length === 0) {
    fail('scope', 'Reaches nobody. Turn on allowlist or all_dms, or list chats')
  }
  return out
}

function validateChats(chats, path, fail) {
  if (!Array.isArray(chats)) {
    fail(path, 'Must be a list of chat JIDs')
    return []
  }
  if (chats.length > LIMITS.maxChats) fail(path, `At most ${LIMITS.maxChats} chats`)
  const out = []
  chats.forEach((jid, i) => {
    if (typeof jid !== 'string' || !CHAT_JID.test(jid)) {
      fail(`${path}[${i}]`, 'Must be a full chat JID such as 15555550100@s.whatsapp.net or 1203630000@g.us')
    } else {
      out.push(jid)
    }
  })
  return out
}

/**
 * One window or a list of them, normalized to a list. Each window may name the
 * days it applies to; a window that crosses midnight belongs to the day it
 * started. Active-hours windows may carry a status for an LLM reply.
 */
function validateHours(value, path, fail, { allowStatus = false } = {}) {
  if (value === undefined) return undefined
  if (value === null) return null
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0 || list.length > LIMITS.maxWindows) {
    fail(path, `Must be a window or a list of 1 to ${LIMITS.maxWindows} windows`)
    return null
  }
  const out = []
  list.forEach((window, i) => {
    const at = Array.isArray(value) ? `${path}[${i}]` : path
    const parsed = validateWindow(window, at, fail, allowStatus)
    if (parsed) out.push(parsed)
  })
  return out.length === list.length ? out : null
}

function validateWindow(value, path, fail, allowStatus) {
  const keys = allowStatus ? ['start', 'end', 'days', 'status'] : ['start', 'end', 'days']
  if (!isPlainObject(value)) {
    fail(path, 'Must be { "start": "HH:MM", "end": "HH:MM" }, optionally with "days"')
    return null
  }
  unknownKeys(value, keys, path, fail)
  // Days alone mean the whole of those days.
  const allDay = value.start === undefined && value.end === undefined && value.days !== undefined
  if (!allDay) {
    const ok = CLOCK.test(value.start) && CLOCK.test(value.end)
    if (!ok) {
      fail(path, 'start and end must be 24-hour times such as "22:00"')
      return null
    }
    if (value.start === value.end) {
      fail(path, 'start and end must differ')
      return null
    }
  }
  const out = allDay ? { start: null, end: null, days: null } : { start: value.start, end: value.end, days: null }
  if (value.days !== undefined && value.days !== null) {
    const days = Array.isArray(value.days) ? value.days.map(d => (typeof d === 'string' ? d.toLowerCase() : d)) : null
    if (!days || days.length === 0 || days.some(d => !WEEKDAYS.includes(d))) {
      fail(join(path, 'days'), `Must be a non-empty list of: ${WEEKDAYS.join(', ')}`)
      return null
    }
    out.days = [...new Set(days)]
  }
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !value.status.trim() || value.status.length > LIMITS.maxStatusChars) {
      fail(join(path, 'status'), `Must be text of up to ${LIMITS.maxStatusChars} characters`)
      return null
    }
    out.status = value.status.trim()
  }
  return out
}

function validateMinutes(value, path, fail, { min = 0, max = 60 * 24 * 30 } = {}) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `Must be a number of minutes from ${min} to ${max}`)
    return undefined
  }
  return value
}

function validateBool(value, path, fail) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    fail(path, 'Must be true or false')
    return undefined
  }
  return value
}

function validateSetOptions(options, fail) {
  const out = {
    timezone: DEFAULT_TIMEZONE,
    cooldown_minutes: 60,
    once_per_chat: false,
    quiet_hours: null,
    active_hours: null,
    pause_after_manual_reply_minutes: DEFAULT_PAUSE_AFTER_MANUAL_REPLY_MINUTES,
    max_replies_per_contact_per_hour: null,
    max_replies_per_contact_per_day: null,
    conversation: { ...DEFAULT_CONVERSATION },
    flood: { ...DEFAULT_FLOOD },
    loop: { ...DEFAULT_LOOP },
  }
  if (options === undefined || options === null) return out
  if (!isPlainObject(options)) {
    fail('options', 'Must be an object')
    return out
  }
  unknownKeys(options, OPTION_KEYS, 'options', fail)
  if (options.timezone !== undefined) {
    if (!isTimezone(options.timezone)) fail('options.timezone', 'Unknown timezone. Use an IANA name such as Asia/Singapore')
    else out.timezone = options.timezone
  }
  const cooldown = validateMinutes(options.cooldown_minutes, 'options.cooldown_minutes', fail)
  if (cooldown !== undefined) out.cooldown_minutes = cooldown
  const once = validateBool(options.once_per_chat, 'options.once_per_chat', fail)
  if (once !== undefined) out.once_per_chat = once
  const quiet = validateHours(options.quiet_hours, 'options.quiet_hours', fail)
  if (quiet !== undefined) out.quiet_hours = quiet
  const active = validateHours(options.active_hours, 'options.active_hours', fail, { allowStatus: true })
  if (active !== undefined) out.active_hours = active
  const pause = validateMinutes(options.pause_after_manual_reply_minutes, 'options.pause_after_manual_reply_minutes', fail)
  if (pause !== undefined) out.pause_after_manual_reply_minutes = pause
  for (const key of CONTACT_CAP_KEYS) {
    const value = validateContactCap(options[key], `options.${key}`, fail)
    if (value !== undefined) out[key] = value
  }

  out.conversation = validateGroup(options.conversation, 'options.conversation', DEFAULT_CONVERSATION, fail, {
    gap_minutes: { min: 1, max: 24 * 60 },
    max_replies: { min: 1, max: 100 },
    backoff_base_minutes: { min: 0, max: 24 * 60, fraction: true },
  })
  if (isPlainObject(options.conversation) && options.conversation.handoff_text !== undefined && options.conversation.handoff_text !== null) {
    const handoff = validateResponse({ type: 'text', text: options.conversation.handoff_text }, 'options.conversation.handoff_text', fail)
    out.conversation.handoff_text = handoff ? handoff.text : null
  }
  out.flood = validateGroup(options.flood, 'options.flood', DEFAULT_FLOOD, fail, {
    max_messages: { min: 2, max: 1000 },
    window_seconds: { min: 5, max: 3600 },
    mute_minutes: { min: 1, max: 60 * 24 * 30 },
  })
  out.loop = validateGroup(options.loop, 'options.loop', DEFAULT_LOOP, fail, {
    reply_within_seconds: { min: 1, max: 60 },
    streak: { min: 2, max: 20 },
    mute_minutes: { min: 1, max: 60 * 24 * 30 },
  })
  return out
}

const validateContactCap = (value, path, fail) => validateCount(value, path, fail, { min: 1, max: 1000 })

function validateCount(value, path, fail, { min, max, fraction = false }) {
  if (value === undefined || value === null) return undefined
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max &&
    (fraction || Number.isInteger(value))
  if (!ok) {
    fail(path, `Must be ${fraction ? 'a number' : 'a whole number'} from ${min} to ${max}`)
    return undefined
  }
  return value
}

/** A small object of numeric settings, each falling back to its default. */
function validateGroup(value, path, defaults, fail, ranges) {
  const out = { ...defaults }
  if (value === undefined || value === null) return out
  if (!isPlainObject(value)) {
    fail(path, 'Must be an object')
    return out
  }
  unknownKeys(value, Object.keys(defaults), path, fail)
  for (const [key, range] of Object.entries(ranges)) {
    const parsed = validateCount(value[key], `${path}.${key}`, fail, range)
    if (parsed !== undefined) out[key] = parsed
  }
  return out
}

export function isTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch (_) {
    return false
  }
}

function validateRule(rule, path, fail, { requireMatch }) {
  if (!isPlainObject(rule)) {
    fail(path, 'Must be an object')
    return null
  }
  unknownKeys(rule, RULE_KEYS, path, fail)
  const out = { id: null, match: null, response: null }

  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) {
    fail(join(path, 'id'), 'Required: letters, digits, "_" or "-", up to 64 characters')
  } else {
    out.id = rule.id
  }

  if (requireMatch || rule.match !== undefined) {
    out.match = validateMatch(rule.match, join(path, 'match'), fail, { requireCondition: requireMatch })
  }
  out.response = validateResponse(rule.response, join(path, 'response'), fail)

  const cooldown = validateMinutes(rule.cooldown_minutes, join(path, 'cooldown_minutes'), fail)
  if (cooldown !== undefined) out.cooldown_minutes = cooldown
  const once = validateBool(rule.once_per_chat, join(path, 'once_per_chat'), fail)
  if (once !== undefined) out.once_per_chat = once
  const quiet = validateHours(rule.quiet_hours, join(path, 'quiet_hours'), fail)
  if (quiet !== undefined) out.quiet_hours = quiet
  const active = validateHours(rule.active_hours, join(path, 'active_hours'), fail, { allowStatus: true })
  if (active !== undefined) out.active_hours = active
  for (const key of CONTACT_CAP_KEYS) {
    const value = validateContactCap(rule[key], join(path, key), fail)
    if (value !== undefined) out[key] = value
  }

  return out
}

function validateMatch(match, path, fail, { requireCondition }) {
  if (!isPlainObject(match)) {
    fail(path, 'Must be an object')
    return null
  }
  unknownKeys(match, MATCH_KEYS, path, fail)
  const out = { keywords: [], keywords_mode: 'any', exact: [], regex: null, types: ['text'], chats: [], from: null }

  if (match.keywords !== undefined) {
    if (!Array.isArray(match.keywords) || match.keywords.length === 0) {
      fail(join(path, 'keywords'), 'Must be a non-empty list of words or phrases')
    } else if (match.keywords.length > LIMITS.maxKeywords) {
      fail(join(path, 'keywords'), `At most ${LIMITS.maxKeywords} keywords`)
    } else {
      match.keywords.forEach((kw, i) => {
        const normalized = typeof kw === 'string' ? normalizeWords(kw) : ''
        if (!normalized || kw.length > 100) {
          fail(`${join(path, 'keywords')}[${i}]`, 'Must be a word or phrase of up to 100 characters')
        } else {
          out.keywords.push(normalized)
        }
      })
    }
  }
  if (match.keywords_mode !== undefined) {
    if (!['any', 'all'].includes(match.keywords_mode)) fail(join(path, 'keywords_mode'), 'Must be "any" or "all"')
    else out.keywords_mode = match.keywords_mode
  }

  if (match.exact !== undefined) {
    const list = Array.isArray(match.exact) ? match.exact : [match.exact]
    if (list.length === 0 || list.length > LIMITS.maxKeywords) {
      fail(join(path, 'exact'), `Must be text or a list of 1 to ${LIMITS.maxKeywords} texts`)
    }
    list.forEach((text, i) => {
      const normalized = typeof text === 'string' ? normalizeExact(text) : ''
      if (!normalized || text.length > 500) fail(`${join(path, 'exact')}[${i}]`, 'Must be text of up to 500 characters')
      else out.exact.push(normalized)
    })
  }

  if (match.regex !== undefined) {
    const problem = regexProblem(match.regex, regexBudget)
    if (problem) fail(join(path, 'regex'), problem)
    else out.regex = match.regex
  }

  if (match.types !== undefined) {
    if (!Array.isArray(match.types) || match.types.length === 0) {
      fail(join(path, 'types'), `Must be a non-empty list of: ${MESSAGE_TYPES.join(', ')}`)
    } else {
      const bad = match.types.filter(t => !MESSAGE_TYPES.includes(t))
      if (bad.length) fail(join(path, 'types'), `Unknown type ${bad.map(t => JSON.stringify(t)).join(', ')}. Allowed: ${MESSAGE_TYPES.join(', ')}`)
      else out.types = [...new Set(match.types)]
    }
  }

  if (match.chats !== undefined) out.chats = validateChats(match.chats, join(path, 'chats'), fail)

  if (match.from !== undefined) {
    if (!SENDER_KINDS.includes(match.from)) fail(join(path, 'from'), 'Must be "saved" or "unknown"')
    else out.from = match.from
  }

  const hasCondition = out.keywords.length || out.exact.length || out.regex ||
    match.types !== undefined || out.chats.length || out.from
  if (requireCondition && !hasCondition) {
    fail(path, 'Needs at least one of keywords, exact, regex, types, chats or from. Use "fallback" to answer everything else')
  }
  return out
}

function validateResponse(response, path, fail) {
  if (!isPlainObject(response)) {
    fail(path, 'Must be an object such as { "type": "text", "text": "..." }')
    return null
  }
  if (!RESPONSE_TYPES.includes(response.type)) {
    fail(join(path, 'type'), 'Must be "text" or "llm"')
    return null
  }
  if (response.type === 'llm') return validateLlmResponse(response, path, fail)
  unknownKeys(response, ['type', 'text'], path, fail)
  const text = validateReplyText(response.text, join(path, 'text'), fail)
  return text === null ? null : { type: 'text', text }
}

function validateReplyText(text, path, fail) {
  if (typeof text !== 'string' || !text.trim()) {
    fail(path, 'Required text')
    return null
  }
  if (text.length > LIMITS.maxResponseChars) {
    fail(path, `At most ${LIMITS.maxResponseChars} characters`)
  }
  for (const [, key] of text.matchAll(/\{([^{}\s]*)\}/g)) {
    if (!PLACEHOLDERS.includes(key)) {
      fail(path, `Unknown placeholder {${key}}. Available: ${PLACEHOLDERS.map(p => `{${p}}`).join(', ')}`)
    }
  }
  return text
}

/**
 * A reply written by a language model. The template sets the model and the
 * owner's instructions; the model only ever writes the text.
 */
function validateLlmResponse(response, path, fail) {
  unknownKeys(response, LLM_KEYS, path, fail)
  const out = { type: 'llm', model: null, instructions: null, ...LLM_DEFAULTS, fallback_text: null }
  if (typeof response.model !== 'string' || !LLM_MODEL.test(response.model)) {
    fail(join(path, 'model'), 'Required: the gateway model name, such as "chat" or "smart"')
  } else {
    out.model = response.model
  }
  if (typeof response.instructions !== 'string' || !response.instructions.trim()) {
    fail(join(path, 'instructions'), 'Required text: how the model should write the reply')
  } else if (response.instructions.length > LIMITS.maxInstructionsChars) {
    fail(join(path, 'instructions'), `At most ${LIMITS.maxInstructionsChars} characters`)
  } else {
    out.instructions = response.instructions.trim()
  }
  const context = validateCount(response.context_messages, join(path, 'context_messages'), fail, { min: 0, max: 30 })
  if (context !== undefined) out.context_messages = context
  const maxChars = validateCount(response.max_chars, join(path, 'max_chars'), fail, { min: 20, max: 1000 })
  if (maxChars !== undefined) out.max_chars = maxChars
  if (response.fallback_text !== undefined && response.fallback_text !== null) {
    out.fallback_text = validateReplyText(response.fallback_text, join(path, 'fallback_text'), fail)
  }
  return out.model && out.instructions ? out : null
}

// ─── Regex safety ────────────────────────────────────────────────────

/**
 * JavaScript regexes have no timeout, and a slow pattern blocks the whole
 * server, ingestion included. So refuse the shapes that backtrack
 * exponentially (a quantified group that itself repeats or alternates,
 * backreferences), bound how much any pattern can backtrack by estimating it
 * from its repeats, and finally time hostile inputs built from the pattern's
 * own characters.
 *
 * `budget` is shared across one template so many rules cannot add up to a
 * slow template either.
 */
export function regexProblem(pattern, budget = { cost: LIMITS.maxTemplateRegexCost, ms: LIMITS.maxTemplateProbeMs }) {
  if (typeof pattern !== 'string' || !pattern) return 'Must be a non-empty pattern'
  if (pattern.length > LIMITS.maxRegexLength) return `At most ${LIMITS.maxRegexLength} characters`
  let compiled
  try {
    compiled = new RegExp(pattern, 'i')
  } catch (err) {
    return `Not a valid pattern: ${err.message}`
  }

  const shape = scanRegex(pattern)
  if (shape.backreference) return 'Backreferences are not allowed'
  if (shape.nestedQuantifier) {
    return 'A repeated group may not contain its own repeats or alternatives, for example (a+)+ or (a|b)*. These can freeze the server'
  }
  if (shape.cost > LIMITS.maxRegexCost) {
    return 'Pattern could backtrack too much on a long message. Use at most one *, + or {n,}, keep {n,m} ranges small, or use keywords instead'
  }
  budget.cost -= shape.cost
  if (budget.cost < 0) return 'The regexes in this template together could backtrack too much. Use fewer or simpler patterns'

  const n = LIMITS.maxRegexInputChars
  for (const probe of regexProbes(pattern, n)) {
    const started = process.hrtime.bigint()
    compiled.test(probe)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    budget.ms -= ms
    if (ms > 25) return 'Pattern is too slow on long messages'
    if (budget.ms < 0) return 'The regexes in this template are too slow together on long messages'
  }
  return null
}

/** Long inputs made of the characters the pattern itself looks for. */
function regexProbes(pattern, n) {
  const literal = [...new Set(pattern.replace(/\\[dDwWsSbB]/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '').toLowerCase())]
    .filter(c => c.trim())
    .slice(0, 8)
  const chars = [...new Set([...literal, 'a', '1', 'é', ' '])]
  const probes = chars.map(c => c.repeat(n))
  if (literal.length > 1) probes.push(literal.join('').repeat(Math.ceil(n / literal.length)).slice(0, n))
  probes.push(`${'ab'.repeat(n / 2 - 1)}!`)
  return probes
}

function scanRegex(pattern) {
  const n = LIMITS.maxRegexInputChars
  // Start positions times the product of every repeat's maximum count is a
  // ceiling on how far a pattern without nested repeats can backtrack.
  const result = { backreference: false, nestedQuantifier: false, cost: n }
  const charge = (q) => { result.cost *= (q.unbounded ? n : q.max) + 1 }
  // Each open group remembers whether it holds a repeat or an alternative.
  const stack = [{ risky: false }]
  let inClass = false

  const quantifierAt = (i) => {
    const c = pattern[i]
    if (c === '*' || c === '+') return { unbounded: true, max: n, length: 1 }
    if (c === '?') return { unbounded: false, max: 1, length: 1 }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i))
      if (m) {
        const unbounded = m[2] !== undefined && m[3] === ''
        const max = unbounded ? n : Number(m[3] ?? m[1])
        return { unbounded, max: Math.min(max, n), length: m[0].length, repeats: m[2] !== undefined || Number(m[1]) > 1 }
      }
    }
    return null
  }

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      if (!inClass && (/[1-9]/.test(next) || next === 'k')) result.backreference = true
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') { inClass = true; continue }
    if (c === '(') { stack.push({ risky: false }); continue }
    if (c === '|') { stack[stack.length - 1].risky = true; continue }
    if (c === ')') {
      const group = stack.length > 1 ? stack.pop() : { risky: false }
      const q = quantifierAt(i + 1)
      if (q) {
        charge(q)
        if (group.risky && (q.unbounded || q.repeats)) result.nestedQuantifier = true
        stack[stack.length - 1].risky = true
        i += q.length
        if (pattern[i + 1] === '?') i++
      } else if (group.risky) {
        stack[stack.length - 1].risky = true
      }
      continue
    }
    const q = quantifierAt(i)
    if (q) {
      charge(q)
      stack[stack.length - 1].risky = true
      i += q.length - 1
      if (pattern[i + 1] === '?') i++
    }
  }
  return result
}

// ─── Matching ────────────────────────────────────────────────────────

/** Lowercase words separated by single spaces; punctuation drops out. */
export function normalizeWords(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
}

/** A short fingerprint of a message's words, so repeats can be spotted without storing them. */
export function textHash(text) {
  const words = normalizeWords(String(text ?? '').slice(0, LIMITS.maxMatchChars))
  return words ? createHash('sha256').update(words).digest('hex').slice(0, 16) : null
}

/** Case and spacing do not matter for "exact"; punctuation does. */
export function normalizeExact(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The first rule whose every condition holds, then the fallback.
 * `message` is { type, text, chatAliases, senderSaved }. `eligible` can pass
 * over a rule whose conditions hold, so the next one gets its turn.
 * Returns the rule or null.
 */
export function findMatchingRule(ruleSet, message, eligible = () => true) {
  const text = String(message.text ?? '').slice(0, LIMITS.maxMatchChars)
  const words = ` ${normalizeWords(text)} `
  const exact = normalizeExact(text)
  const regexInput = text.slice(0, LIMITS.maxRegexInputChars)
  const aliases = message.chatAliases || []
  const saved = Boolean(message.senderSaved)
  const input = { type: message.type, words, exact, regexInput, aliases, saved }

  for (const rule of ruleSet.rules) {
    if (ruleMatches(rule.match, input) && eligible(rule)) return rule
  }
  if (ruleSet.fallback) {
    // Without a match block the fallback answers text, not every sticker.
    const match = ruleSet.fallback.match || FALLBACK_MATCH
    if (ruleMatches(match, input) && eligible(ruleSet.fallback)) {
      return ruleSet.fallback
    }
  }
  return null
}

const FALLBACK_MATCH = { keywords: [], keywords_mode: 'any', exact: [], regex: null, types: ['text'], chats: [], from: null }

function ruleMatches(match, { type, words, exact, regexInput, aliases, saved }) {
  if (!match) return false
  if (!match.types.includes(type)) return false
  if (match.chats.length && !match.chats.some(jid => aliases.includes(jid))) return false
  if (match.from && (match.from === 'saved') !== saved) return false
  if (match.keywords.length) {
    const hit = (kw) => words.includes(` ${kw} `)
    const ok = match.keywords_mode === 'all' ? match.keywords.every(hit) : match.keywords.some(hit)
    if (!ok) return false
  }
  if (match.exact.length && !match.exact.includes(exact)) return false
  if (match.regex) {
    try {
      if (!new RegExp(match.regex, 'i').test(regexInput)) return false
    } catch (_) {
      return false
    }
  }
  return true
}

// ─── Who may be answered ─────────────────────────────────────────────

/**
 * Whether a chat is inside a rule set's scope. Returns null when it is, or a
 * reason. Groups are reached only by their explicit JID, never through the
 * allow list or all_dms.
 */
export function scopeRefusal(scope, { chatJid, aliases = [chatJid], allowlisted = false, isOwn = false }) {
  if (typeof chatJid !== 'string' || !chatJid) return 'no_chat'
  if (isOwn) return 'own_chat'
  if (chatJid === 'status@broadcast' || chatJid.endsWith('@broadcast')) return 'broadcast'
  if (chatJid.endsWith('@newsletter')) return 'newsletter'
  if ((scope.blocklist || []).some(jid => aliases.includes(jid))) return 'blocklisted'
  if (chatJid.endsWith('@g.us')) {
    return scope.chats.includes(chatJid) ? null : 'group_not_listed'
  }
  if (!/@(s\.whatsapp\.net|lid)$/.test(chatJid)) return 'unsupported_chat'
  if (scope.chats.some(jid => aliases.includes(jid))) return null
  if (scope.all_dms) return null
  if (scope.allowlist && allowlisted) return null
  return 'out_of_scope'
}

// ─── Live messages only ──────────────────────────────────────────────

// proto.WebMessageInfo.StubType.CIPHERTEXT: what Baileys upserts in place of
// a message it could not decrypt. It asks the sender's device to resend, and
// the resend arrives later under the same id with a fresh timestamp.
export const CIPHERTEXT_STUB = 2

// How far the sender's timestamp may sit from the moment this server received
// the message. A live message arrives within seconds. One that was sent long
// before it reached us was held somewhere, so it is not a live conversation.
export const MAX_DELIVERY_DELAY_SECONDS = 60
// WhatsApp stamps the time, so a timestamp ahead of our clock means one of
// the two clocks is wrong. Allow a little drift and no more.
export const MAX_FUTURE_SECONDS = 10

// Message content that is never a new thing someone said: edits, deletes,
// disappearing-message settings, pins, poll votes, reactions.
const NON_CONTENT_KEYS = [
  'protocolMessage', 'editedMessage', 'pollUpdateMessage', 'reactionMessage', 'encReactionMessage',
  'keepInChatMessage', 'pinInChatMessage', 'senderKeyDistributionMessage',
]
const MEDIA_TYPES = ['image', 'video', 'doc', 'audio', 'voice', 'sticker']

/** Is this raw Baileys message the stub left by a failed decryption? */
export function isDecryptFailure(raw) {
  return raw?.messageStubType === CIPHERTEXT_STUB && typeof raw?.key?.id === 'string' && raw.key.id !== ''
}

/**
 * The cheap first filter, run on every stored message. Whatever it refuses is
 * not a candidate at all and is never logged: history sync and reconnect
 * catch-up (Baileys delivers offline messages as 'append', not 'notify') pass
 * through here by the thousand.
 * Returns null when the message goes on to the gate, or a reason.
 */
export function liveMessageRefusal({ upsertType, message, raw }) {
  if (upsertType !== 'notify') return 'not_live'
  if (isDecryptFailure(raw)) return 'decrypt_failed'
  if (!message) return 'unparsed'
  if (message.is_from_me) return 'from_me'
  if (typeof message.jid !== 'string') return 'no_chat'
  if (message.jid.endsWith('@broadcast')) return 'broadcast'
  if (message.jid.endsWith('@newsletter')) return 'newsletter'
  return null
}

/**
 * The gate an in-scope live message must pass before any rule is looked at.
 * A message is answered only when every condition holds, so anything doubtful
 * is skipped. Each refusal is logged with its reason.
 *
 *   redelivered    the id failed to decrypt earlier and was resent: its
 *                  timestamp is the resend time, so it may be days old
 *   protocol       an edit, delete, reaction, poll vote or other non-message
 *   unsupported_type, no_content
 *   no_timestamp, too_old (sent too long before now)
 *   stale          sent long before this server received it
 *   clock_skew     stamped in the future
 *
 * `content` is the unwrapped raw message content, `receivedAtMs` the moment
 * ingestion saw it.
 */
export function answerRefusal({ message, content, redelivered, sentAtSeconds, receivedAtMs, nowMs, maxAgeSeconds }) {
  if (redelivered) return 'redelivered'
  if (content && NON_CONTENT_KEYS.some(key => content[key])) return 'protocol'
  if (!MESSAGE_TYPES.includes(message.type)) return 'unsupported_type'
  if (!hasContent(message)) return 'no_content'
  if (!Number.isFinite(sentAtSeconds) || sentAtSeconds <= 0) return 'no_timestamp'
  if (nowMs / 1000 - sentAtSeconds > maxAgeSeconds) return 'too_old'
  if (!Number.isFinite(receivedAtMs)) return 'no_timestamp'
  const delaySeconds = receivedAtMs / 1000 - sentAtSeconds
  if (delaySeconds > MAX_DELIVERY_DELAY_SECONDS) return 'stale'
  if (delaySeconds < -MAX_FUTURE_SECONDS) return 'clock_skew'
  return null
}

function hasContent(message) {
  if (MEDIA_TYPES.includes(message.type)) return Boolean(message.media_key || message.media_url)
  return typeof message.body === 'string' && message.body.trim() !== ''
}

/**
 * Whether an outgoing message means the owner has taken over the chat: a real
 * message, recent, and not one the auto-replier sent itself.
 */
export function isManualReply({ message, sentAtSeconds, nowMs, maxAgeSeconds, isBotMessage }) {
  if (!message?.is_from_me) return false
  if (isBotMessage) return false
  if (!MESSAGE_TYPES.includes(message.type)) return false
  if (!Number.isFinite(sentAtSeconds)) return false
  return Math.abs(nowMs / 1000 - sentAtSeconds) <= maxAgeSeconds
}

// ─── Time of day ─────────────────────────────────────────────────────

/** Minutes since local midnight in a timezone. */
export function localMinutes(nowMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const hour = Number(parts.find(p => p.type === 'hour').value)
  const minute = Number(parts.find(p => p.type === 'minute').value)
  return hour * 60 + minute
}

/** Minutes since local midnight and the local weekday ('mon'...) in a timezone. */
export function localClock(nowMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(nowMs))
  const value = (type) => parts.find(p => p.type === type).value
  return {
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
    day: value('weekday').slice(0, 3).toLowerCase(),
  }
}

const toMinutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))

/**
 * Whether a local time falls in a window; a window may wrap past midnight.
 * `day` is only needed when the window names days. The part of a window after
 * midnight belongs to the day it started, so a Friday 22:00-02:00 window
 * covers Saturday 01:00 and not Friday 01:00.
 */
export function inWindow(minutes, window, day = null) {
  if (window.start === null) return !window.days || window.days.includes(day)
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  let startedOn = day
  let inside
  if (start < end) {
    inside = minutes >= start && minutes < end
  } else if (minutes >= start) {
    inside = true
  } else {
    inside = minutes < end
    if (day) startedOn = WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]
  }
  if (!inside) return false
  return !window.days || window.days.includes(startedOn)
}

/** The first window of a list that holds the given local clock, or null. */
export function findWindow(windows, { minutes, day }) {
  return (windows || []).find(window => inWindow(minutes, window, day)) || null
}

// ─── The decision ────────────────────────────────────────────────────

/**
 * Track how often a contact answers within seconds of our sends. People take
 * longer than that; another bot does not. Only the first message after each
 * of our sends is judged, so the messages our own limits swallow in between
 * neither build nor reset the streak.
 * Returns { streak, checkedSentAt }.
 */
export function nextLoopStreak({ previousStreak = 0, lastSentAt, checkedSentAt = null, incomingAt, replyWithinSeconds }) {
  if (!lastSentAt || incomingAt < lastSentAt) return { streak: previousStreak, checkedSentAt }
  if (checkedSentAt === lastSentAt) return { streak: previousStreak, checkedSentAt }
  const fast = incomingAt - lastSentAt <= replyWithinSeconds * 1000
  return { streak: fast ? previousStreak + 1 : 0, checkedSentAt: lastSentAt }
}

/**
 * Where the current conversation began. A conversation is a run of messages
 * with no gap longer than gap_minutes; the owner replying by hand also starts
 * a fresh one, so the reply budget resets once they have stepped back out.
 */
export function conversationStart({ previousStart, lastIncomingAt, lastManualReplyAt, nowMs, gapMinutes }) {
  let start = previousStart && lastIncomingAt && nowMs - lastIncomingAt <= gapMinutes * 60_000
    ? previousStart
    : nowMs
  if (lastManualReplyAt && lastManualReplyAt > start) start = lastManualReplyAt
  return start
}

/** The wait before the nth reply of a conversation: base, then doubling. */
export function backoffMs(repliesSoFar, baseMinutes) {
  if (repliesSoFar < 1 || baseMinutes <= 0) return 0
  return baseMinutes * 60_000 * 2 ** Math.min(repliesSoFar - 1, 20)
}

/**
 * The caps for one decision. A per-contact cap comes from the matched rule,
 * else the set, else the server, and the server's cap is always the ceiling:
 * a template may be stricter than the server, never looser.
 */
export function effectiveLimits(options, limits, rule = null) {
  const pick = (key, server) => {
    const template = rule?.[key] ?? options[key]
    return template ? Math.min(template, server) : server
  }
  return {
    perContactHour: pick('max_replies_per_contact_per_hour', limits.maxPerChatPerHour),
    perContactDay: pick('max_replies_per_contact_per_day', limits.maxPerChatPerDay),
    perHour: limits.maxPerHour,
    minGapMs: limits.minGapSeconds * 1000,
  }
}

/**
 * Decide what to do with one in-scope incoming message.
 *
 * `stats` describes this contact (all its aliases), with reply counts for the
 * same action kind as the decision (sends for live, dry runs for dry-run):
 *   contactMute: { until, reason }     muted contact (manual, loop)
 *   senderMute:  { until, reason }     muted sender inside a group (flood)
 *   lastManualReplyAt                  the owner last wrote here by hand
 *   floodCount                         messages from this sender in the flood window
 *   loopStreak                         replies that came back within seconds of ours
 *   conversationReplies, conversationHandoffSent, conversationLastReplyAt
 *   lastReplyAt                        any reply to this contact
 *   ruleLastReplyAt: { [ruleId]: ms }, rulesReplied: [ruleId]
 *   sameTextRuleIds: [ruleId]          rules that already answered this text this conversation
 *   contactRepliesLastHour, contactRepliesLastDay   replies from every rule, not just the matched one
 *   globalRepliesLastHour
 * `limits` are the server's caps: { minGapSeconds, maxPerChatPerHour, maxPerChatPerDay, maxPerHour }.
 *
 * Returns { action: 'reply' | 'skip' | 'mute', reason, rule, text, mute }.
 * 'mute' carries { target: 'contact' | 'sender', minutes, reason }.
 * A reply from an "llm" rule has text null and carries
 * generate: { status, fallbackText } for the caller to write it.
 */
export function decide({ ruleSet, message, nowMs, stats = {}, limits }) {
  const options = ruleSet.options
  const skip = (reason, rule = null) => ({ action: 'skip', reason, rule, text: null, mute: null })
  const mute = (target, minutes, reason) => ({ action: 'mute', reason, rule: null, text: null, mute: { target, minutes, reason } })

  for (const muted of [stats.contactMute, stats.senderMute]) {
    if (muted?.until && muted.until > nowMs) return skip(`muted:${muted.reason || 'manual'}`)
  }

  if ((stats.floodCount || 0) > options.flood.max_messages) {
    return mute('sender', options.flood.mute_minutes, 'flood')
  }
  if ((stats.loopStreak || 0) >= options.loop.streak) {
    return mute('contact', options.loop.mute_minutes, 'loop')
  }

  const pauseMs = options.pause_after_manual_reply_minutes * 60_000
  if (pauseMs > 0 && stats.lastManualReplyAt && nowMs - stats.lastManualReplyAt < pauseMs) {
    return skip('manual_reply_pause')
  }

  // A rule outside its active hours is passed over, so a schedule can be
  // written as one rule per window, each falling through to the next.
  const clock = localClock(nowMs, options.timezone)
  let outside = null
  let window = null
  const rule = findMatchingRule(ruleSet, message, (candidate) => {
    const active = candidate.active_hours !== undefined ? candidate.active_hours : options.active_hours
    window = active ? findWindow(active, clock) : null
    if (active && !window) {
      outside ||= candidate
      return false
    }
    return true
  })
  if (!rule) return outside ? skip('outside_active_hours', outside) : skip('no_match')

  const quiet = rule.quiet_hours !== undefined ? rule.quiet_hours : options.quiet_hours
  if (quiet && findWindow(quiet, clock)) return skip('quiet_hours', rule)
  const render = { ...message, nowMs, timezone: options.timezone }

  // The counts are this contact's replies from every rule. Only the cap they
  // are held to depends on which rule matched.
  const caps = effectiveLimits(options, limits, rule)

  // Limits that apply to any reply, the handoff included.
  const sharedLimit = () => {
    if (stats.lastReplyAt && nowMs - stats.lastReplyAt < caps.minGapMs) return 'min_gap'
    if ((stats.contactRepliesLastHour || 0) >= caps.perContactHour) return 'contact_hourly_limit'
    if ((stats.contactRepliesLastDay || 0) >= caps.perContactDay) return 'contact_daily_limit'
    if ((stats.globalRepliesLastHour || 0) >= caps.perHour) return 'global_hourly_limit'
    return null
  }

  const conversation = options.conversation
  if ((stats.conversationReplies || 0) >= conversation.max_replies) {
    if (!conversation.handoff_text || stats.conversationHandoffSent) return skip('conversation_cap', rule)
    const limited = sharedLimit()
    if (limited) return skip(limited, rule)
    const handoff = { id: HANDOFF_RULE_ID, response: { type: 'text', text: conversation.handoff_text } }
    return {
      action: 'reply',
      reason: 'conversation_cap_handoff',
      rule: handoff,
      text: renderResponse(handoff.response, render),
      mute: null,
    }
  }

  const once = rule.once_per_chat !== undefined ? rule.once_per_chat : options.once_per_chat
  if (once && (stats.rulesReplied || []).includes(rule.id)) return skip('once_per_chat', rule)

  const cooldownMs = (rule.cooldown_minutes !== undefined ? rule.cooldown_minutes : options.cooldown_minutes) * 60_000
  const ruleLast = stats.ruleLastReplyAt?.[rule.id]
  if (ruleLast && nowMs - ruleLast < cooldownMs) return skip('cooldown', rule)

  if ((stats.sameTextRuleIds || []).includes(rule.id)) return skip('duplicate_text', rule)

  const wait = backoffMs(stats.conversationReplies || 0, conversation.backoff_base_minutes)
  if (wait && stats.conversationLastReplyAt && nowMs - stats.conversationLastReplyAt < wait) {
    return skip('backoff', rule)
  }

  const limited = sharedLimit()
  if (limited) return skip(limited, rule)

  if (rule.response.type === 'llm') {
    // The text is written after every limit has passed, by the caller, which
    // owns the network. A model's output never decides anything here.
    return {
      action: 'reply',
      reason: null,
      rule,
      text: null,
      mute: null,
      generate: {
        status: window?.status || null,
        fallbackText: rule.response.fallback_text ? renderText(rule.response.fallback_text, render) : null,
      },
    }
  }

  return {
    action: 'reply',
    reason: null,
    rule,
    text: renderResponse(rule.response, render),
    mute: null,
  }
}

// ─── Rendering ───────────────────────────────────────────────────────

/** Contact names are chosen by the sender, so keep them short and single-line. */
export function cleanName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...cleaned].slice(0, LIMITS.maxNameChars).join('').trim()
}

export function renderResponse(response, context) {
  if (response.type !== 'text') throw new Error(`Unsupported response type ${response.type}`)
  return renderText(response.text, context)
}

/**
 * Fill a reply's placeholders. A sender who is not in the address book
 * (senderSaved false) is never named: their profile name is their own choice,
 * so the name placeholders render empty and the punctuation around them is
 * tidied ("Hi {first_name}, ok" becomes "Hi, ok").
 */
export function renderText(text, { senderName, senderSaved, nowMs, timezone }) {
  const name = senderSaved === false ? '' : cleanName(senderName)
  const neutral = senderSaved === false ? '' : 'there'
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs))
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs))
  const values = {
    name: name || neutral,
    first_name: name.split(' ')[0] || neutral,
    date,
    time,
  }
  let blanked = false
  const out = text.replace(/( ?)\{(name|first_name|date|time)\}/g, (_, space, key) => {
    if (values[key]) return space + values[key]
    blanked = true
    return ''
  })
  if (!blanked) return out
  return out
    .replace(/[ \t]+([,.!?])/g, '$1')
    .replace(/,([.!?])/g, '$1')
    .replace(/^[ \t,]+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
}

// ─── Who may change what ─────────────────────────────────────────────

/** Whether any rule's reply is written by a model. */
export function usesModel(ruleSet) {
  return [...(ruleSet?.rules || []), ...(ruleSet?.fallback ? [ruleSet.fallback] : [])]
    .some(rule => rule.response?.type === 'llm')
}

/**
 * A model reply is written from the chat's recent messages, and the text ends
 * up in the test result and the decision log. An API key with autoreply:manage
 * alone must not be able to read chats that way (that is what channels:read is
 * for), so rule sets with model replies need the console or a key that was
 * also given autoreply:llm on purpose.
 */
export const MODEL_SCOPE = 'autoreply:llm'

export const MODEL_REFUSAL = {
  status: 403,
  error: `Rule sets whose replies a model writes need the ${MODEL_SCOPE} scope or the web console`,
  code: 'MISSING_SCOPE',
}

/** The console, or a token holding autoreply:llm. */
export function mayUseModel({ isSession, scopes }) {
  return Boolean(isSession) || (Array.isArray(scopes) && scopes.includes(MODEL_SCOPE))
}

/**
 * An API key may manage rule sets but must never be able to make the server
 * send: that would let it reach people its send scopes do not cover. So any
 * change that leaves a rule set both active and live needs the console.
 * Returns null when allowed, or { status, error, code }.
 */
export function stateChangeRefusal({ isSession, current, next }) {
  if (isSession) return null
  const mode = next.mode ?? current.mode
  const active = next.active ?? current.active
  if (next.mode === 'live' || (active && mode === 'live')) {
    return {
      status: 403,
      error: 'Only the web console can put a rule set live',
      code: 'MISSING_SCOPE',
    }
  }
  return null
}
