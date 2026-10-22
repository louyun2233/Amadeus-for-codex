import test from 'node:test'
import assert from 'node:assert/strict'
import { ActiveTurnLedger, TURN_STALE_MS } from '../src/host/task-policy.mjs'

/**
 * "目标达成" showed up in the middle of the task the user was watching.
 *
 * The completion event itself is written at the right moment - the problem was
 * *which* turn it belonged to: while the agent works it spawns `codex exec`
 * helpers, and each of those is its own session with its own task_complete.
 * Only the outermost turn may be spoken about.
 */

test('the user turn is announced, a nested helper is not', () => {
  const ledger = new ActiveTurnLedger()
  assert.deepEqual(ledger.observe({ kind: 'start', turnId: 'user' }), { nested: false, active: 1 })
  assert.deepEqual(ledger.observe({ kind: 'start', turnId: 'helper' }), { nested: true, active: 2 })
  assert.deepEqual(ledger.observe({ kind: 'complete', turnId: 'helper' }), { nested: true, active: 1 })
  assert.deepEqual(ledger.observe({ kind: 'complete', turnId: 'user' }), { nested: false, active: 0 })
})

test('a helper that finishes while the main turn runs stays quiet', () => {
  const ledger = new ActiveTurnLedger()
  ledger.observe({ kind: 'start', turnId: 'user' })
  const helper = ledger.observe({ kind: 'start', turnId: 'helper-2' })
  assert.equal(helper.nested, true)
  const done = ledger.observe({ kind: 'complete', turnId: 'helper-2' })
  assert.equal(done.nested, true, 'the main turn is still running, so this is not "the task"')
  assert.equal(ledger.hasActive(), true)
})

test('an aborted helper does not silence the main turn', () => {
  const ledger = new ActiveTurnLedger()
  ledger.observe({ kind: 'start', turnId: 'user' })
  ledger.observe({ kind: 'start', turnId: 'helper' })
  // the watcher maps `turn_aborted` to the `failed` boundary
  ledger.observe({ kind: 'failed', turnId: 'helper' })
  assert.equal(ledger.observe({ kind: 'complete', turnId: 'user' }).nested, false)
})

test('a turn that never ends goes stale instead of blocking announcements', () => {
  let now = 1_000_000
  const ledger = new ActiveTurnLedger({ now: () => now, staleMs: TURN_STALE_MS })
  ledger.observe({ kind: 'start', turnId: 'crashed-helper' })
  assert.equal(ledger.hasActive(), true)
  now += TURN_STALE_MS + 1
  assert.equal(ledger.hasActive(), false, 'a crashed helper must not mute the next task')
  assert.equal(ledger.observe({ kind: 'start', turnId: 'next' }).nested, false)
})

test('an event without a turn id never claims to be nested', () => {
  const ledger = new ActiveTurnLedger()
  ledger.observe({ kind: 'start', turnId: 'user' })
  assert.deepEqual(ledger.observe({ kind: 'complete', turnId: null }), { nested: false, active: 1 })
})
