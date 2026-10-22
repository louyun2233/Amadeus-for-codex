/**
 * Bounded diagnostic minimisation, applied at every logging boundary.
 *
 * Learned from Code-Codex's `runtime-redaction`: the *only* reliable place to
 * keep prompts, paths and credentials out of a support artefact is the writer
 * that produces it. `notify.log` used to store Codex's raw notify payload -
 * the whole user prompt, the working directory and the reply - and the audit
 * trail stored whatever text an operation carried.
 *
 * Rules:
 *   - keep what makes a report useful: codes, ports, timings, kinds, booleans
 *   - drop what identifies the user: file paths, emails, URLs with a query
 *     string, anything that looks like a credential, and the contents of the
 *     fields Codex fills with conversation
 *   - never grow: every output is bounded, and a failure returns "[redacted]"
 *     rather than the original text
 */

export const MAX_LOG_TEXT = 1200
const MAX_INPUT_TEXT = 8000
const MAX_DEPTH = 6
const MAX_ENTRIES = 128

/** Field names whose *value* is conversation, a path or a credential. */
const PRIVATE_KEY_HINTS = [
  'token',
  'cookie',
  'password',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'api_key',
]
const PRIVATE_EXACT = [
  'content',
  'text',
  'body',
  'prompt',
  'messages',
  'input-messages',
  'last-assistant-message',
  'title',
  'filename',
  'name',
  'raw',
  'data',
  'commandline',
  'command',
  'sessionid',
  'accountid',
  'thread-id',
  'turn-id',
  'cwd',
]

function privateKey(key) {
  const flat = String(key || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (PRIVATE_KEY_HINTS.some((hint) => flat.includes(hint.replace(/_/g, '')))) return true
  if (PRIVATE_EXACT.some((exact) => flat === exact.replace(/[^a-z0-9]/g, ''))) return true
  return flat.endsWith('path') || flat.endsWith('url') || flat.endsWith('uri')
}

/** A local URL keeps its origin and path; the query can carry the session token. */
function safeUrl(raw) {
  try {
    const url = new URL(raw)
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    // Only our own loopback panel URL is worth keeping, and only its origin and
    // path: a remote URL's path can carry anything, so it is dropped whole.
    return local ? `${url.origin}${url.pathname}` : '[url]'
  } catch {
    return '[url]'
  }
}

export function redactText(input) {
  let out
  try {
    out = String(input ?? '').slice(0, MAX_INPUT_TEXT)
  } catch {
    return '[redacted]'
  }
  out = out
    .replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g, safeUrl)
    // Windows drive or UNC path, POSIX home/system path. The drive form needs
    // an opening boundary, otherwise `http://…` looks like `p:\`.
    .replace(/(^|[\s"'=(,;])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]*/g, '$1[path]')
    .replace(/\/(?:Users|home|tmp|var|etc|opt|mnt)\/[^\s"'<>]*/g, '[path]')
    .replace(/~[\\/][^\s"'<>]*/g, '[path]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, '[credential]')
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|token|secret|password|cookie|authorization)\b\s*[:=]\s*[^\s,;"']+/gi,
      '[credential]',
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length > MAX_LOG_TEXT) out = `${out.slice(0, MAX_LOG_TEXT)} [truncated]`
  return out
}

/**
 * Redact a JSON-ish value: private keys lose their value entirely, everything
 * else goes through `redactText`. Depth and width are bounded so a hostile or
 * merely huge payload cannot turn into a log entry.
 */
export function redactValue(input, { depth = 0, budget = { left: 256 } } = {}) {
  if (budget.left <= 0 || depth > MAX_DEPTH) return '[truncated]'
  budget.left -= 1
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return redactString(input, depth, budget)
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (typeof input === 'bigint') return String(input)
  if (Array.isArray(input)) {
    return input.slice(0, MAX_ENTRIES).map((item) => redactValue(item, { depth: depth + 1, budget }))
  }
  if (typeof input === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(input).slice(0, MAX_ENTRIES)) {
      out[redactText(key).slice(0, 160)] = privateKey(key)
        ? '[redacted]'
        : redactValue(value, { depth: depth + 1, budget })
    }
    return out
  }
  return '[redacted]'
}

/**
 * A string that *is* JSON is redacted as JSON.
 *
 * Old log lines stored Codex's payload as an escaped JSON string, so plain text
 * redaction walked straight past it - prompt included. Re-parsing costs one
 * `JSON.parse` on something that already looked like an object.
 */
function redactString(value, depth, budget) {
  const trimmed = value.trim()
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (looksJson) {
    try {
      return redactValue(JSON.parse(trimmed), { depth: depth + 1, budget })
    } catch {
      /* not JSON after all: fall through to text redaction */
    }
  }
  return redactText(value)
}

/**
 * One log line, redacted whatever shape it has.
 *
 * Our own lines look like `[time] argv=<json> kind=…`; older lines wrapped the
 * payload in a string. Both end up minimised, which is what the support report
 * needs - it must not depend on the log having been written by a recent build.
 */
export function redactLogLine(line) {
  const text = String(line ?? '')
  const at = text.indexOf('argv=')
  if (at < 0) return redactText(text)
  const head = text.slice(0, at + 'argv='.length)
  const tail = text.slice(at + 'argv='.length)
  const kindAt = tail.indexOf(' kind=')
  const payloadText = kindAt >= 0 ? tail.slice(0, kindAt) : tail
  const rest = kindAt >= 0 ? tail.slice(kindAt) : ''
  let payload
  try {
    payload = redactValue(JSON.parse(payloadText))
  } catch {
    payload = redactText(payloadText)
  }
  return `${redactText(head)}${JSON.stringify(payload)}${redactText(rest)}`
}

/** One JSON-safe line, always usable as a log entry even for exotic input. */
export function redactJson(value) {
  try {
    return JSON.stringify(redactValue(value))
  } catch {
    return '"[redacted]"'
  }
}
