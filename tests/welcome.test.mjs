import test from 'node:test'
import assert from 'node:assert/strict'
import { speakWelcomeWhenReady } from '../src/panel/welcome.js'

test('local welcome is queued only after the clone has synthesized it', async () => {
  let now = 0
  let attempts = 0
  let spoken = 0
  let waiting = 0
  const result = await speakWelcomeWhenReady({
    provider: 'qwen-local',
    prepare: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Qwen still starting')
      return { ready: attempts >= 3 }
    },
    speak: async () => { spoken += 1 },
    onWaiting: () => { waiting += 1 },
    clock: () => now,
    sleep: async (ms) => { now += ms },
  })
  assert.equal(result, 'sent')
  assert.equal(attempts, 3)
  assert.equal(waiting, 2)
  assert.equal(spoken, 1)
})

test('a user interaction cancels a late welcome', async () => {
  let cancelled = false
  let spoken = 0
  const result = await speakWelcomeWhenReady({
    provider: 'qwen-local',
    prepare: async () => { cancelled = true; return { ready: true } },
    shouldCancel: () => cancelled,
    speak: async () => { spoken += 1 },
  })
  assert.equal(result, 'cancelled')
  assert.equal(spoken, 0)
})

test('an unavailable clone times out without silently using another voice', async () => {
  let now = 0
  let timedOut = 0
  let spoken = 0
  const result = await speakWelcomeWhenReady({
    provider: 'qwen-local',
    prepare: async () => ({ ready: false, reason: 'offline' }),
    speak: async () => { spoken += 1 },
    onTimeout: () => { timedOut += 1 },
    maxWaitMs: 20,
    retryMs: 10,
    clock: () => now,
    sleep: async (ms) => { now += ms },
  })
  assert.equal(result, 'timeout')
  assert.equal(timedOut, 1)
  assert.equal(spoken, 0)
})

test('other voice providers do not need local Qwen preparation', async () => {
  let prepared = 0
  let spoken = 0
  const result = await speakWelcomeWhenReady({
    provider: 'edge',
    prepare: async () => { prepared += 1 },
    speak: async () => { spoken += 1 },
  })
  assert.equal(result, 'sent')
  assert.equal(prepared, 0)
  assert.equal(spoken, 1)
})
