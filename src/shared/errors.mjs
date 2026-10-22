/**
 * Structured failure. Tool handlers must return these instead of throwing raw
 * errors so the model always receives an actionable, non-crashing result.
 */
export class AmadeusError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'AmadeusError'
    this.code = code
    this.degrade = options.degrade ?? null
    this.detail = options.detail ?? null
  }
  toResult() {
    return {
      ok: false,
      code: this.code,
      reason: this.message,
      degrade: this.degrade,
      detail: this.detail,
    }
  }
}

export const ErrorCode = {
  NOT_FOUND: 'not_found',
  INVALID_ARGUMENT: 'invalid_argument',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  UNAVAILABLE: 'unavailable',
  DEGRADED: 'degraded',
  INTERNAL: 'internal',
}

export function ok(value = {}) {
  return { ok: true, ...value }
}

/** Wrap an async handler so it never throws across the tool boundary. */
export function guard(fn) {
  return async (...args) => {
    try {
      const out = await fn(...args)
      return out === undefined ? ok() : out
    } catch (e) {
      if (e instanceof AmadeusError) return e.toResult()
      return {
        ok: false,
        code: ErrorCode.INTERNAL,
        reason: e && e.message ? e.message : String(e),
      }
    }
  }
}
