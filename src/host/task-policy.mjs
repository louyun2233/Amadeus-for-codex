/**
 * Which turn boundaries are worth speaking about.
 *
 * A Desktop turn is not the only thing Codex runs: while the agent works it
 * spawns `codex exec` helpers, and each of those is its own session with its own
 * `task_started` / `task_complete`. Announcing those made "目标达成" show up in
 * the middle of the task the user was actually watching - reported as "she
 * detects the end too early".
 *
 * The rule: a boundary is announced only when it belongs to the turn the user
 * started. A turn that begins while another one is still running is nested, and
 * so is a completion that leaves another turn running. Turns that never report
 * an end go stale after `staleMs`, so one crashed helper cannot silence the
 * announcements forever.
 */

export const TURN_STALE_MS = 10 * 60 * 1000

export class ActiveTurnLedger {
  constructor({ now = () => Date.now(), staleMs = TURN_STALE_MS } = {}) {
    this.now = now
    this.staleMs = staleMs
    this.turns = new Map()
  }

  #prune() {
    const now = this.now()
    for (const [id, info] of this.turns) {
      if (now - info.startedAt > this.staleMs) this.turns.delete(id)
    }
  }

  /** @returns {{nested: boolean, active: number}} */
  observe({ kind, turnId } = {}) {
    if (!turnId) return { nested: false, active: this.turns.size }
    this.#prune()
    if (kind === 'start') {
      const nested = this.turns.size > 0
      this.turns.set(String(turnId), { startedAt: this.now() })
      return { nested, active: this.turns.size }
    }
    if (kind === 'complete' || kind === 'failed') {
      this.turns.delete(String(turnId))
      // another turn still running means this one was a nested helper
      return { nested: this.turns.size > 0, active: this.turns.size }
    }
    return { nested: this.turns.size > 0, active: this.turns.size }
  }

  hasActive() {
    this.#prune()
    return this.turns.size > 0
  }

  get size() {
    return this.turns.size
  }
}
