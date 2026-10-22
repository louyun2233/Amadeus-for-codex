const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const SENSITIVE_KEY = /(key|token|secret|password|authorization|passwd|credential)/i

function currentLevel() {
  const raw = String(process.env.AMADEUS_LOG_LEVEL || 'info').toLowerCase()
  return LEVELS[raw] ?? LEVELS.info
}

/** Mask any value that looks like a secret. Never log raw keys. */
export function mask(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (value.length <= 8) return '***'
    return value.slice(0, 3) + '***' + value.slice(-2)
  }
  if (Array.isArray(value)) return value.map(mask)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? (v ? '***' : '') : mask(v)
    }
    return out
  }
  return value
}

export function redactText(text) {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***')
    .replace(/(sk-[A-Za-z0-9._\-]{6,})/g, 'sk-***')
}

function emit(level, args) {
  if (LEVELS[level] < currentLevel()) return
  const ts = new Date().toISOString()
  const parts = args.map((a) => {
    if (typeof a === 'string') return redactText(a)
    try {
      return JSON.stringify(mask(a))
    } catch {
      return String(a)
    }
  })
  const line = `[${ts}] ${level.toUpperCase()} ${parts.join(' ')}`
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stderr.write(line + '\n')
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
}

export function createChildLogger(scope) {
  return {
    debug: (...a) => emit('debug', [scope, ...a]),
    info: (...a) => emit('info', [scope, ...a]),
    warn: (...a) => emit('warn', [scope, ...a]),
    error: (...a) => emit('error', [scope, ...a]),
  }
}
