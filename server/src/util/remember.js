const DAY_MS = 24 * 60 * 60 * 1000

/** Lifetime of a console session when "remember me" is not ticked. */
export const DEFAULT_SESSION_MS = 7 * DAY_MS

/**
 * Lifetimes the login form may ask for. Sessions are rolling, so each one is
 * measured from the last visit, not from sign-in.
 *
 * `forever` is 400 days because browsers cap cookie lifetimes there (Chrome
 * clamps anything longer); with rolling renewal a console used at least once
 * a year never asks for the password again.
 */
export const REMEMBER_MS = Object.freeze({
  '30d': 30 * DAY_MS,
  '60d': 60 * DAY_MS,
  forever: 400 * DAY_MS,
})

/**
 * Session lifetime for a login request's `remember` value. Missing or empty
 * means the default; anything else unknown returns null so the route can
 * reject it rather than silently picking a lifetime.
 */
export function sessionMaxAgeMs(remember) {
  if (remember === undefined || remember === null || remember === '' || remember === false) {
    return DEFAULT_SESSION_MS
  }
  return Object.hasOwn(REMEMBER_MS, remember) ? REMEMBER_MS[remember] : null
}
