import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ProactiveScheduler,
  WILL_BASELINE,
  idleScaleFor,
} from '../src/core/scheduler.mjs'

/**
 * State-driven pacing.
 *
 * From the multi-character story-mode notes: who speaks should follow an inner
 * state, and the state should move by deltas rather than be assigned absolute
 * values. Single-character translation: her mood scales the idle threshold
 * instead of a bare timer deciding everything.
 *
 * Baseline (will 50) must reproduce the old timer exactly — that is why the
 * existing scheduler suite still passes untouched.
 */

const MIN = 60 * 1000
const HOUR = 60 * MIN

function harness() {
  let now = 1_700_000_000_000
  const delivered = []
  const state = { lastCallAt: 0, callCount: 0, lastUserAt: 0, lastProactiveAt: 0 }
  const config = {
    value: {
      voice: { enabled: true },
      proactive: { callEnabled: false, callIntervalMs: 10 * HOUR, idleEnabled: true, idleMs: HOUR },
    },
    get() {
      return this.value
    },
  }
  const scheduler = new ProactiveScheduler({
    clock: () => now,
    config,
    state,
    complete: async () => '【soft】\nJP: ねぇ\nCN: 喂',
    deliver: (line) => delivered.push(line),
    report: () => {},
  })
  return {
    scheduler,
    state,
    delivered,
    at: (t) => { now = t },
    advance: (ms) => { now += ms },
    now: () => now,
  }
}

test('idleScaleFor is 1.0 at baseline and bounded at the extremes', () => {
  assert.equal(idleScaleFor(WILL_BASELINE), 1)
  assert.equal(idleScaleFor(100), 0.5)
  assert.equal(idleScaleFor(0), 1.5)
  assert.equal(idleScaleFor(undefined), 1, 'a state file without mood behaves as before')
  assert.ok(idleScaleFor(1000) >= 0.4)
})

test('being talked to raises her appetite, and a question raises it more', () => {
  const plain = harness()
  plain.scheduler.noteInteraction({ text: '今天天气不错' })
  const asked = harness()
  asked.scheduler.noteInteraction({ text: '你觉得呢？' })
  assert.ok(asked.state.will > plain.state.will, 'a question should lift will further')
  assert.ok(plain.state.will > WILL_BASELINE)
})

test('mood is clamped and drift is always the other end of the same bar', () => {
  const h = harness()
  for (let i = 0; i < 40; i++) h.scheduler.noteInteraction({ text: '再说说？' })
  assert.equal(h.state.will, 100, 'will cannot exceed 100')
  assert.equal(h.state.part, 100)
  const status = h.scheduler.status()
  assert.equal(status.drift, 100 - status.part)
  assert.ok(status.drift >= 0 && status.drift <= 100)
})

test('mood decays back toward baseline instead of staying spiked', () => {
  const h = harness()
  h.scheduler.noteInteraction({ text: '你会怎么想？' })
  const spiked = h.state.will
  assert.ok(spiked > WILL_BASELINE)
  for (let i = 0; i < 80; i++) {
    h.advance(MIN)
    h.scheduler.tick()
  }
  assert.ok(h.state.will < spiked, 'the spike must fade')
  assert.ok(Math.abs(h.state.will - WILL_BASELINE) < 3, `settled at ${h.state.will}`)
})

test('high mood makes her speak sooner than the configured idle time', async () => {
  const h = harness()
  await h.scheduler.tick() // first tick only establishes the call baseline
  h.scheduler.noteInteraction({ text: '我们继续聊这个吧？' })
  for (let i = 0; i < 10; i++) h.advance(MIN), h.scheduler.noteInteraction({ text: '嗯？' })
  const sinceLastInteraction = h.now()
  const threshold = HOUR * idleScaleFor(h.state.will)
  assert.ok(threshold < HOUR, `expected a shortened threshold, got ${Math.round(threshold / MIN)}min`)

  h.at(h.now() + threshold - MIN) // just short of the scaled threshold
  await h.scheduler.tick()
  assert.equal(h.delivered.length, 0)
  // NOTE: decay nudges the threshold up on every tick, so nudge well past it —
  // the claim being tested is "before the configured idle time", not "one tick later"
  h.advance(15 * MIN)
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'idle', 'she opens up before the full idle time')
  assert.ok(h.now() - sinceLastInteraction < HOUR, 'and still sooner than the configured 60 minutes')
})

test('low mood makes her wait longer than the configured idle time', async () => {
  const h = harness()
  await h.scheduler.tick() // establish the call baseline first, or the tick
  // below would return `call-baseline` and this test would pass for the wrong reason
  h.state.will = 5
  h.state.part = 5
  h.scheduler.noteInteraction({ text: '嗯' })
  h.state.will = 5 // force it back down for the assertion
  h.state.lastUserAt = h.now()

  h.advance(HOUR + MIN) // past the configured idle time
  await h.scheduler.tick()
  assert.equal(h.delivered.length, 0, 'a withdrawn mood holds her back')
})
