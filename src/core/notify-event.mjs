/**
 * Codex `notify` payload -> broadcast event kind.
 *
 * Codex hands the hook one JSON blob as the last CLI argument, and that shape
 * is not a stable contract (it differs between builds). The mapping therefore
 * lives in its own module with its own tests instead of inside the hook
 * script: the first version of the hook only knew `goal.*complete`,
 * `task.*complete` and `turn.completed`, while real Codex sends
 * `agent-turn-complete` - so every finished task was filed as a plain
 * `turn-end` and the announcement never fired.
 *
 * Names are compared with the separators stripped, so `agent-turn-complete`,
 * `turn.completed`, `task_complete` and `goalComplete` all land on the same
 * kind, while `turn-incomplete` deliberately does not.
 */

const COMPLETE_NAMES = /^(?:agent)?(?:goal|task|turn)complete(?:d)?$/
const FAILURE_HINTS = ['"error"', 'failed', '"status":"error"', '"status": "error"']

function eventName(evt) {
  const type = evt && (evt.type || evt.event)
  return typeof type === 'string' ? type : ''
}

/**
 * @param {unknown} payload raw last-argv string from Codex
 * @returns {{kind: 'task-complete'|'task-failed'|'turn-end'|'unknown', type: string, origin: 'panel'|'codex'}}
 */
export function classifyNotifyEvent(payload, { dataRoot = '' } = {}) {
  const text = String(payload ?? '')
  const lower = text.toLowerCase()
  if (FAILURE_HINTS.some((hint) => lower.includes(hint))) {
    return { kind: 'task-failed', type: '', origin: 'codex' }
  }

  let evt = null
  try {
    evt = JSON.parse(text)
  } catch {
    return { kind: 'unknown', type: '', origin: 'codex' }
  }

  const type = eventName(evt)
  const origin = notifyOrigin(evt, dataRoot)
  const normalized = type.toLowerCase().replace(/[^a-z]/g, '')
  if (COMPLETE_NAMES.test(normalized)) return { kind: 'task-complete', type, origin }
  return { kind: 'turn-end', type, origin }
}

/**
 * Which turn is this - the user's Codex task, or a chat the panel itself ran?
 *
 * The panel talks to Codex through `codex exec` in `<data>/runtime/chatcwd`,
 * so the `cwd` in the notify payload tells the two apart. Without this the
 * finished-task announcement fired for the panel's own conversation and she
 * said her reply *and* "target achieved" on top of it.
 */
export function notifyOrigin(evt, dataRoot) {
  const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const cwd = normalize(evt && evt.cwd)
  const root = normalize(dataRoot)
  if (!cwd || !root) return 'codex'
  return cwd === root || cwd.startsWith(`${root}/`) ? 'panel' : 'codex'
}

/**
 * The turn id, used to keep the notify hook and the rollout watcher from
 * announcing the same turn twice. Never logged (the log redactor treats it as
 * private) - it only lives in the daemon's in-memory ledger.
 */
export function notifyTurnId(payload) {
  try {
    const evt = JSON.parse(String(payload ?? ''))
    const id = evt?.['turn-id'] || evt?.turnId || evt?.['turn_id'] || null
    return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null
  } catch {
    return null
  }
}
