// The server-wide auto-reply limits that the console may change. `.env` gives
// the defaults (config.autoreply); a value saved from the console overrides one
// of them. The lower bounds match the env parsing in config.js, so the console
// can never set a limit that `.env` would have refused.

export const LIMIT_BOUNDS = {
  // 5 seconds is the floor for the same reason as in config.js: a menu answered
  // with "1", "2" or "3" must not be dropped for arriving too soon.
  minGapSeconds: { min: 5, max: 3600 },
  maxPerChatPerHour: { min: 1, max: 100 },
  maxPerChatPerDay: { min: 1, max: 1000 },
  maxPerHour: { min: 1, max: 1000 },
  maxAgeSeconds: { min: 30, max: 600 },
}

export const LIMIT_FIELDS = Object.keys(LIMIT_BOUNDS)

export function isValidLimit(field, value) {
  const bounds = LIMIT_BOUNDS[field]
  return Boolean(bounds) && Number.isInteger(value) && value >= bounds.min && value <= bounds.max
}

/**
 * Checks a change from the console. Every field is optional, but each one given
 * must be a whole number inside its bounds, and unknown fields are refused so a
 * typo is reported instead of silently ignored.
 */
export function validateLimitsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Send an object of limits, for example { "minGapSeconds": 30 }'], values: {} }
  }
  const errors = []
  const values = {}
  for (const [field, value] of Object.entries(input)) {
    const bounds = LIMIT_BOUNDS[field]
    if (!bounds) {
      errors.push(`Unknown limit "${field}"`)
    } else if (!isValidLimit(field, value)) {
      errors.push(`"${field}" must be a whole number from ${bounds.min} to ${bounds.max}`)
    } else {
      values[field] = value
    }
  }
  if (!errors.length && !Object.keys(values).length) errors.push('No limits given')
  return { ok: errors.length === 0, errors, values }
}

/**
 * The limits in force: each saved override that is still valid, else the
 * default. A stored value that is no longer valid (bounds tightened, a hand
 * edit) falls back to the default rather than loosening anything.
 */
export function mergeLimits(defaults, overrides = {}) {
  const limits = { ...defaults }
  const overridden = []
  for (const field of LIMIT_FIELDS) {
    const value = overrides[field]
    if (isValidLimit(field, value) && value !== defaults[field]) {
      limits[field] = value
      overridden.push(field)
    }
  }
  return { limits, overridden }
}
