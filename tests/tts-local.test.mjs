import test from 'node:test'
import assert from 'node:assert/strict'
import { TtsService } from '../src/core/tts.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

test('local Qwen clone is synthesized and cached without switching speakers', async () => {
  const paths = tempPaths()
  const originalFetch = globalThis.fetch
  const requests = []
  try {
    const config = new ConfigStore(paths)
    config.update({ voice: {
      enabled: true,
      provider: 'qwen-local',
      name: 'kurisu_reference_fax',
      localModel: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
    } })
    const tts = new TtsService({ paths, config, secretStore: null })
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [] }) }
      }
      requests.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, arrayBuffer: async () => Buffer.alloc(1200, 7) }
    }
    const result = await tts.synthesize('こんにちは。', { voice: 'ja-JP-NanamiNeural' })
    assert.equal(result.provider, 'qwen-local')
    assert.equal(result.mime, 'audio/wav')
    assert.equal(requests[0].url, 'http://127.0.0.1:7860/v1/audio/speech')
    assert.equal(requests[0].body.model, 'Qwen/Qwen3-TTS-12Hz-0.6B-Base')
    assert.equal(requests[0].body.voice, 'kurisu_reference_fax')
    assert.equal(requests[0].body.response_format, 'wav')
    assert.equal(requests[0].body.language, 'japanese')
    assert.equal(requests[0].body.max_new_tokens, 96)
    assert.equal((await tts.synthesize('こんにちは。', { voice: 'another-voice' })).cached, true)
    assert.equal(requests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    cleanup(paths)
  }
})

test('local Qwen failure is shown without an Edge fallback', async () => {
  const paths = tempPaths()
  const originalFetch = globalThis.fetch
  let calls = 0
  try {
    const config = new ConfigStore(paths)
    config.update({ voice: { provider: 'qwen-local', name: 'kurisu_reference_fax', stability: true } })
    const tts = new TtsService({ paths, config, secretStore: null })
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [] }) }
      }
      calls += 1
      return { ok: false, status: 503, text: async () => '{"error":"model unavailable"}' }
    }
    await assert.rejects(tts.synthesize('こんにちは。'), /本地 Qwen TTS HTTP 503/)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    cleanup(paths)
  }
})

test('every local speech request waits through a cold start without changing voice', async () => {
  const paths = tempPaths()
  const originalFetch = globalThis.fetch
  let readinessAttempts = 0
  const requests = []
  try {
    const config = new ConfigStore(paths)
    config.update({ voice: { provider: 'qwen-local', name: 'kurisu_reference_fax' } })
    const tts = new TtsService({
      paths, config, secretStore: null,
      localQwenReady: async () => ++readinessAttempts >= 3,
      localQwenWaitMs: 1000,
      localQwenRetryMs: 1,
    })
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, arrayBuffer: async () => Buffer.alloc(1200, 7) }
    }
    const result = await tts.synthesize('起動中です。', { voice: 'another-voice' })
    assert.equal(result.provider, 'qwen-local')
    assert.equal(readinessAttempts, 3)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.voice, 'kurisu_reference_fax')
  } finally {
    globalThis.fetch = originalFetch
    cleanup(paths)
  }
})

test('local speech reports a bounded startup failure without an Edge fallback', async () => {
  const paths = tempPaths()
  const originalFetch = globalThis.fetch
  let requests = 0
  try {
    const config = new ConfigStore(paths)
    config.update({ voice: { provider: 'qwen-local', name: 'kurisu_reference_fax' } })
    const tts = new TtsService({
      paths, config, secretStore: null,
      localQwenReady: async () => false,
      localQwenWaitMs: 10,
      localQwenRetryMs: 1,
    })
    globalThis.fetch = async () => { requests += 1; throw new Error('unexpected fetch') }
    await assert.rejects(tts.synthesize('起動中です。'), /等待冷启动后仍无法连接/)
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
    cleanup(paths)
  }
})
