const BASE = '/api'

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
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status, code: err.code })
  }

  return res.json()
}
