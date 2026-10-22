import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSfxPlayer, createMotionSequence, maySpeakTap, resolveSfxName, SFX_COOLDOWN_MS,
} from '../src/panel/sfx.js'

/**
 * Motion effects must be additive: they can overlap speech, but they can never
 * queue behind it, delay it, or cancel it (that is what the speech queue's own
 * decisions are for). These tests pin the decision logic only — the audio
 * element itself is wired in main.js.
 */

function harness({ enabled = true, volume = 0.5 } = {}) {
  let now = 1_000_000
  const played = []
  const skipped = []
  const player = createSfxPlayer({
    play: (name, v) => played.push({ name, volume: v }),
    now: () => now,
    volume,
    enabled: () => enabled,
    onSkip: (reason, detail) => skipped.push({ reason, detail }),
  })
  return {
    player,
    played,
    skipped,
    advance: (ms) => { now += ms },
  }
}

test('a trigger plays the effect with the configured volume', () => {
  const h = harness({ volume: 0.35 })
  assert.equal(h.player.trigger('tapBody_00'), 'played')
  assert.deepEqual(h.played, [{ name: 'tapBody_00', volume: 0.35 }])
})

test('a burst of triggers collapses into one effect', () => {
  const h = harness()
  for (let i = 0; i < 5; i++) h.player.trigger('tapBody_00')
  assert.equal(h.played.length, 1, 'tapping five times must not stack five sounds')
  assert.equal(h.skipped.filter((s) => s.reason === 'cooldown').length, 4)
})

test('after the cooldown the next effect is allowed', () => {
  const h = harness()
  h.player.trigger('tapBody_00')
  h.advance(SFX_COOLDOWN_MS)
  assert.equal(h.player.trigger('tapBody_00'), 'played')
  assert.equal(h.played.length, 2)
})

test('muting speech also silences the effects', () => {
  const h = harness({ enabled: false })
  assert.equal(h.player.trigger('tapBody_00'), 'disabled')
  assert.equal(h.played.length, 0)
})

test('a failing audio element never reaches the caller', () => {
  const skipped = []
  const player = createSfxPlayer({
    play: () => {
      throw new Error('autoplay blocked')
    },
    onSkip: (reason, detail) => skipped.push({ reason, detail }),
  })
  assert.equal(player.trigger('tapBody_00'), 'played')
  assert.equal(skipped[0].reason, 'error')
  assert.match(skipped[0].detail, /autoplay blocked/)
})

test('reset clears the cooldown', () => {
  const h = harness()
  h.player.trigger('tapBody_00')
  assert.equal(h.player.trigger('tapBody_00'), 'cooldown')
  h.player.reset()
  assert.equal(h.player.trigger('tapBody_00'), 'played')
})

test('motion groups resolve to the sound names shipped with the model', () => {
  const map = { flick_head: 'flickHead', tap_body: 'tapBody', pinch_in: 'pinchIn' }
  assert.equal(resolveSfxName(map, 'tap_body'), 'tapBody_00')
  assert.equal(resolveSfxName(map, 'tap_body', 2), 'tapBody_02')
  assert.equal(resolveSfxName(map, 'tap_body', 3), null)
  assert.equal(resolveSfxName(map, 'flick_head'), 'flickHead_00')
  assert.equal(resolveSfxName(map, 'unknown_group'), null)
  assert.equal(resolveSfxName(null, 'tap_body'), null)
})

test('motion variants change without repeating and stay aligned with their sound', () => {
  const sequence = createMotionSequence({ random: () => 0 })
  const indices = [sequence.next('tap_body'), sequence.next('tap_body'), sequence.next('tap_body')]
  assert.deepEqual(indices, [0, 1, 2])
  assert.equal(sequence.next('flick_head'), 0, 'groups rotate independently')
  assert.deepEqual(indices.map((i) => resolveSfxName({ tap_body: 'tapBody' }, 'tap_body', i)),
    ['tapBody_00', 'tapBody_01', 'tapBody_02'])
})

test('tap voice is suppressed while an answer or call is active', () => {
  const idle = { voiceEnabled: true, turnPending: false, speechBusy: false, callPending: false }
  assert.equal(maySpeakTap(idle), true)
  for (const key of ['turnPending', 'speechBusy', 'callPending']) {
    assert.equal(maySpeakTap({ ...idle, [key]: true }), false, key)
  }
  assert.equal(maySpeakTap({ ...idle, voiceEnabled: false }), false)
})

test('volume may be a getter so a settings change takes effect immediately', () => {
  const played = []
  let level = 0.2
  const player = createSfxPlayer({
    play: (name, v) => played.push(v),
    volume: () => level,
    now: () => 1_000_000,
  })
  player.trigger('tapBody_00')
  player.reset()
  level = 0.8
  player.trigger('tapBody_00')
  assert.deepEqual(played, [0.2, 0.8])
})
