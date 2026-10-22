import test from 'node:test'
import assert from 'node:assert/strict'
import { TtsService } from '../src/core/tts.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

function harness({ key = 'test-key', model = 'qwen3-tts-vc-2026-01-22', voice = 'test_clone_voice' } = {}) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  config.update({ voice: {
    enabled: true, provider: 'dashscope', name: voice, dashscopeModel: model, stability: true,
  } })
  const tts = new TtsService({
    paths,
    config,
    secretStore: { get: (name) => name === 'ttsApiKey' ? key : null },
  })
  return { paths, config, tts }
}

test('configured voice remains stable when the cloud key is absent', async () => {
  const h = harness({ key: null })
  try {
    assert.equal(h.tts.providerId(), 'dashscope')
    await assert.rejects(h.tts.synthesize('こんにちは。'), /no Aliyun.*key/)
  } finally {
    cleanup(h.paths)
  }
})

test('a cloud failure does not silently substitute another speaker', async () => {
  const h = harness()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 503, text: async () => 'unavailable' }
  }
  try {
    await assert.rejects(h.tts.synthesize('こんにちは。'), /dashscope http 503/)
    assert.equal(calls, 1, 'Edge fallback must not be requested')
  } finally {
    globalThis.fetch = originalFetch
    cleanup(h.paths)
  }
})

test('a configured cloned voice ID and model are sent through the existing TTS channel', async () => {
  const h = harness()
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null })
    if (requests.length === 1) {
      return { ok: true, text: async () => JSON.stringify({ output: { audio: { url: 'https://example.test/audio' } } }) }
    }
    return { ok: true, arrayBuffer: async () => Buffer.alloc(1200, 7) }
  }
  try {
    const result = await h.tts.synthesize('こんにちは。')
    assert.equal(result.provider, 'dashscope')
    assert.equal(result.audio.length, 1200)
    assert.equal(requests[0].body.model, 'qwen3-tts-vc-2026-01-22')
    assert.equal(requests[0].body.input.voice, 'test_clone_voice')
    assert.equal(requests[0].body.input.language_type, 'Japanese')
    assert.equal(requests.length, 2)
  } finally {
    globalThis.fetch = originalFetch
    cleanup(h.paths)
  }
})
