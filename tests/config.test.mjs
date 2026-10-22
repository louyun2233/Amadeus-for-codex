import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ConfigStore, applyPatch, maskConfig } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

test('applyPatch accepts whitelisted values', () => {
  const cfg = { voice: { enabled: true, rate: '+0%' }, chat: { keepRecent: 20 } }
  const { config, rejected } = applyPatch(cfg, {
    voice: { enabled: false, rate: '+10%' },
    chat: { keepRecent: 30 },
  })
  assert.equal(config.voice.enabled, false)
  assert.equal(config.voice.rate, '+10%')
  assert.equal(config.chat.keepRecent, 30)
  assert.deepEqual(rejected, [])
  // original untouched
  assert.equal(cfg.voice.enabled, true)
})

test('applyPatch rejects unknown paths and malformed values', () => {
  const { config, rejected } = applyPatch({ voice: {} }, {
    'voice.__proto__x': 1,
    evil: { path: 'x' },
    voice: { provider: 'not-a-provider', rate: 'fast' },
  })
  assert.ok(rejected.includes('evil.path'))
  assert.ok(rejected.includes('voice.provider'))
  assert.ok(rejected.includes('voice.rate'))
  assert.equal(config.evil, undefined)
  assert.equal(config.voice.provider, undefined)
})

test('numeric bounds are clamped by validation, not by coercion', () => {
  const { rejected } = applyPatch({}, { chat: { keepRecent: 99999 } })
  assert.deepEqual(rejected, ['chat.keepRecent'])
})

test('local Qwen voice settings are accepted', () => {
  const { config, rejected } = applyPatch({ voice: {} }, {
    voice: { provider: 'qwen-local', name: 'kurisu_reference_fax', localModel: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' },
  })
  assert.deepEqual(rejected, [])
  assert.equal(config.voice.provider, 'qwen-local')
  assert.equal(config.voice.localModel, 'Qwen/Qwen3-TTS-12Hz-0.6B-Base')
})

test('config persists and merges with defaults', () => {
  const paths = tempPaths()
  try {
    const store = new ConfigStore(paths)
    store.update({ voice: { enabled: true }, broadcast: { enabled: true } })
    const reloaded = new ConfigStore(paths)
    assert.equal(reloaded.getPath('voice.enabled'), true)
    assert.equal(reloaded.getPath('broadcast.enabled'), true)
    assert.equal(reloaded.getPath('panel.onboardingSeen'), false)
    // defaults still present
    assert.equal(reloaded.getPath('chat.provider'), 'codex-exec')
  } finally {
    cleanup(paths)
  }
})

test('saved settings are validated before they reach the runtime', () => {
  const paths = tempPaths()
  try {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      chat: { provider: 'unknown', keepRecent: 80, compressThreshold: 20 },
      memory: { enabled: true },
      unexpected: { value: 1 },
    }))
    const store = new ConfigStore(paths)
    assert.equal(store.getPath('chat.provider'), 'codex-exec')
    assert.equal(store.getPath('chat.keepRecent'), 20)
    assert.equal(store.getPath('chat.compressThreshold'), 40)
    assert.equal(store.getPath('memory.enabled'), true)
    assert.equal(store.get().unexpected, undefined)
  } finally {
    cleanup(paths)
  }
})

test('maskConfig removes anything that looks like a credential', () => {
  const masked = maskConfig({ chatApiKey: 'sk-secret', nested: { token: 'abc' }, safe: 'ok' })
  assert.equal(masked.chatApiKey, '***')
  assert.equal(masked.nested.token, '***')
  assert.equal(masked.safe, 'ok')
})
