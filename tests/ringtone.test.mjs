import test from 'node:test'
import assert from 'node:assert/strict'
import { createRingtone, RING_MAX_MS } from '../src/panel/ringtone.js'

/**
 * The incoming call used to be silent: the only audio was her spoken line, so a
 * muted or slow synthesis left nothing to hear. The ring is tested on its own
 * element, with fake timers and a fake audio element.
 */

function fakeElement({ rejectPlay = false } = {}) {
  const el = {
    src: '',
    loop: false,
    volume: 1,
    currentTime: 0,
    played: 0,
    paused: 0,
    play() {
      el.played += 1
      return rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()
    },
    pause() {
      el.paused += 1
    },
  }
  return el
}

function clock() {
  let now = 0
  const timers = new Map()
  let seq = 0
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

test('a call rings on its own element, looped, at the configured volume', () => {
  const el = fakeElement()
  const c = clock()
  const events = []
  const ring = createRingtone({
    element: el,
    now: c.now,
    setTimeoutImpl: c.setTimeout,
    clearTimeoutImpl: c.clearTimeout,
    onStatus: (status, detail) => events.push([status, detail]),
  })

  assert.equal(ring.ringing, false)
  assert.equal(ring.start('/amadeus/sound/incoming', 0.7), 'playing')
  assert.equal(el.src, '/amadeus/sound/incoming')
  assert.equal(el.loop, true)
  assert.equal(el.volume, 0.7)
  assert.equal(el.played, 1)
  assert.equal(ring.ringing, true)
  assert.deepEqual(events.at(-1), ['playing', '/amadeus/sound/incoming'])
})

test('answering stops the ring immediately', () => {
  const el = fakeElement()
  const c = clock()
  const ring = createRingtone({ element: el, now: c.now, setTimeoutImpl: c.setTimeout, clearTimeoutImpl: c.clearTimeout })
  ring.start('/ring', 0.5)
  assert.equal(ring.stop('answered'), 'stopped')
  assert.equal(ring.ringing, false)
  assert.equal(el.paused, 1)
  assert.equal(el.currentTime, 0)
  assert.equal(ring.stop('again'), 'idle', 'stopping twice is not an error')
})

test('a ring that is never answered gives up by itself', async () => {
  const el = fakeElement()
  const c = clock()
  const events = []
  const ring = createRingtone({
    element: el,
    now: c.now,
    setTimeoutImpl: c.setTimeout,
    clearTimeoutImpl: c.clearTimeout,
    onStatus: (status, detail) => events.push([status, detail]),
  })
  ring.start('/ring', 0.5)
  await c.advance(RING_MAX_MS + 10)
  assert.equal(ring.ringing, false)
  assert.deepEqual(events.at(-1), ['timeout', 'max-duration'])
  assert.equal(el.paused, 1)
})

test('a blocked autoplay rings again on the first gesture', async () => {
  const el = fakeElement({ rejectPlay: true })
  const c = clock()
  let retry = null
  const events = []
  const ring = createRingtone({
    element: el,
    now: c.now,
    setTimeoutImpl: c.setTimeout,
    clearTimeoutImpl: c.clearTimeout,
    onStatus: (status, detail) => events.push([status, detail]),
    armGestureRetry: (fn) => {
      retry = fn
    },
  })
  ring.start('/ring', 0.5)
  await c.advance(1)
  assert.deepEqual(events.at(-1), ['blocked', 'autoplay'])
  assert.equal(typeof retry, 'function', 'the panel must be able to retry after a click')
  el.play = () => {
    el.played += 1
    return Promise.resolve()
  }
  retry()
  assert.equal(el.played, 2)
})

test('a missing or undecodable media file is reported as unavailable, not autoplay', async () => {
  const el = fakeElement()
  el.play = () => Promise.reject(new Error('NotSupportedError: failed to load'))
  const events = []
  let retry = null
  const ring = createRingtone({
    element: el,
    onStatus: (status, detail) => events.push([status, detail]),
    armGestureRetry: (fn) => { retry = fn },
  })
  ring.start('/missing.wav')
  await Promise.resolve()
  assert.equal(ring.ringing, false)
  assert.equal(events.at(-1)[0], 'unavailable')
  assert.equal(retry, null)
})

test('a late playback rejection cannot revive a call after it was answered', async () => {
  const el = fakeElement()
  let rejectPlay
  el.play = () => new Promise((_, reject) => { rejectPlay = reject })
  const events = []
  const ring = createRingtone({ element: el, onStatus: (status) => events.push(status) })
  ring.start('/ring')
  ring.stop('answered')
  rejectPlay(new Error('NotAllowedError'))
  await Promise.resolve()
  assert.equal(ring.ringing, false)
  assert.equal(events.at(-1), 'stopped')
})

test('no ring element or url degrades instead of throwing', () => {
  const ring = createRingtone({ element: null })
  assert.equal(ring.start('/ring', 0.5), 'unavailable')
  const el = fakeElement()
  const withEl = createRingtone({ element: el })
  assert.equal(withEl.start('', 0.5), 'unavailable')
  assert.equal(el.played, 0)
})

test('volume is clamped into the element range', () => {
  const el = fakeElement()
  const ring = createRingtone({ element: el })
  ring.start('/ring', 3)
  assert.equal(el.volume, 1)
  ring.start('/ring', -1)
  assert.equal(el.volume, 0)
})
