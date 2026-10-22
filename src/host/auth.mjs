import crypto from 'node:crypto'

export function newToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function isLoopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === ''
  )
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Every route goes through the same check — this is the fix for the DSH
 * version where only the RPC bridge was protected and /memory, /chat and /stt
 * were reachable by anyone who could reach the port.
 */
export function authorize(req, url, token) {
  if (!isLoopback(req)) return { ok: false, status: 403, reason: 'forbidden' }
  const header = req.headers.authorization || ''
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : ''
  const fromQuery = url.searchParams.get('token') || ''
  const provided = fromHeader || fromQuery
  if (!provided || !timingSafeEqual(provided, token)) {
    return { ok: false, status: 401, reason: 'unauthorized' }
  }
  return { ok: true }
}

export const SESSION_COOKIE = 'amadeus_session'

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

/**
 * Authentication for the local daemon.
 *
 * - CLI/MCP/notify authenticate with `Authorization: Bearer <token>`.
 * - The browser panel exchanges the one-time `?token=` in the URL for an
 *   HttpOnly session cookie, so the long-lived token does not stay in the
 *   address bar and is never readable from JavaScript.
 */
export function createAuth(token, { sessionTtlMs = 12 * 60 * 60 * 1000 } = {}) {
  const sessions = new Map()

  const prune = () => {
    const now = Date.now()
    for (const [id, exp] of sessions) if (exp < now) sessions.delete(id)
  }

  return {
    token,
    issueSession() {
      prune()
      const id = crypto.randomBytes(24).toString('base64url')
      sessions.set(id, Date.now() + sessionTtlMs)
      return id
    },
    cookieHeader(id) {
      const maxAge = Math.floor(sessionTtlMs / 1000)
      return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
    },
    hasCookieSession(req) {
      const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (!id) return false
      const exp = sessions.get(id)
      if (!exp || exp < Date.now()) {
        sessions.delete(id)
        return false
      }
      return true
    },
    /** Validate a request; `exchange` is true when ?token= was used. */
    check(req, url) {
      if (!isLoopback(req)) return { ok: false, status: 403, reason: 'forbidden' }
      const header = req.headers.authorization || ''
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (bearer && timingSafeEqual(bearer, token)) return { ok: true, kind: 'bearer' }
      const fromQuery = url.searchParams.get('token') || ''
      if (fromQuery && timingSafeEqual(fromQuery, token)) {
        return { ok: true, kind: 'token-exchange', sessionId: this.issueSession() }
      }
      if (this.hasCookieSession(req)) return { ok: true, kind: 'cookie' }
      return { ok: false, status: 401, reason: 'unauthorized' }
    },
    sessionCount() {
      prune()
      return sessions.size
    },
  }
}
