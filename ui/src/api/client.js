const BASE = '/api'

// Fired when the console session is gone. Most callers swallow their errors
// (the chat list polls and ignores failures), so without one shared signal an
// expired login leaves the page looking normal while nothing updates.
export const UNAUTHORIZED_EVENT = 'wpp:unauthorized'

export function signalUnauthorized() {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

export async function api(path, opts = {}) {
  const { body, headers: extraHeaders, ...rest } = opts
  const isBodyRequest = body !== undefined

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: {
      ...(isBodyRequest ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...rest,
    ...(isBodyRequest ? { body: JSON.stringify(body) } : {}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    // A wrong password is also a 401, but carries its own code.
    if (res.status === 401 && err.code === 'UNAUTHORIZED') signalUnauthorized()
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status, code: err.code })
  }

  return res.json()
}
