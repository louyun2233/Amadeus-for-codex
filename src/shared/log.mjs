import { redactText as minimiseText, redactValue } from '../core/redact.mjs'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel() {
  const raw = String(process.env.AMADEUS_LOG_LEVEL || 'info').toLowerCase()
  return LEVELS[raw] ?? LEVELS.info
}

/** Mask any value that looks like a secret. Never log raw keys. */
export function mask(value) {
  return redactValue(value)
}

export function redactText(text) {
  return minimiseText(text)
}

function emit(level, args) {
  if (LEVELS[level] < currentLevel()) return
  const ts = new Date().toISOString()
  const parts = args.map((a) => {
    if (typeof a === 'string') return redactText(a)
    try {
      return JSON.stringify(mask(a))
    } catch {
      return '[unserializable]'
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
