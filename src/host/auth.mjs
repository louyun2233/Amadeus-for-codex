import crypto from 'node:crypto'

export function newToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function isLoopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1'
  )
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function localHost(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || !host || /[\s/@?#\\]/.test(host)) return false
  try {
    const parsed = new URL('http://' + host)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return false
    return !req.socket?.localPort || Number(parsed.port || 80) === req.socket.localPort
  } catch {
    return false
  }
}

/** Native, CLI and MCP clients authenticate only with a header over loopback. */
export function createAuth(token) {
  if (typeof token !== 'string' || !token || token.length > 256) throw new Error('invalid daemon token')
  return {
    check(req, url) {
      if (!isLoopback(req) || !localHost(req) || req.headers.origin !== undefined ||
          req.headers['sec-fetch-site'] !== undefined) {
        return { ok: false, status: 403, reason: 'forbidden' }
      }
      if (url.searchParams.has('token')) return { ok: false, status: 401, reason: 'unauthorized' }
      const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (bearer && bearer.length <= 256 && timingSafeEqual(bearer, token)) return { ok: true, kind: 'bearer' }
      return { ok: false, status: 401, reason: 'unauthorized' }
    },
  }
}
