import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { TtsService } from '../src/core/tts.mjs'
import { splitLocalSpeech, LOCAL_QWEN_CHUNK_MAX } from '../src/core/parse.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

function wavFixture({ streaming = true } = {}) {
  const wav = Buffer.alloc(1244, 7)
  wav.write('RIFF', 0); wav.writeUInt32LE(streaming ? 0xffffffff : wav.length - 8, 4)
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(streaming ? 0xffffffff : wav.length - 44, 40)
  return wav
}

function sseResponse(audio = wavFixture(), { ending = 'done', corrupt = false, split = false } = {}) {
  const events = [
    { type: 'speech.audio.delta', audio: audio.subarray(0, 500).toString('base64') },
    { type: 'speech.audio.delta', audio: corrupt ? '???' : audio.subarray(500).toString('base64') },
    ...(ending === 'done' ? [{ type: 'speech.audio.done', usage: { output_tokens: 1 } }] :
      ending === 'error' ? [{ type: 'error', error: { code: 'generation_interrupted' } }] : []),
  ]
  const wire = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  const body = split ? new ReadableStream({ start(controller) {
    for (let i = 0; i < wire.length; i += 13) controller.enqueue(wire.subarray(i, i + 13))
    controller.close()
  } }) : wire
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

function localTts(paths) {
  const config = new ConfigStore(paths)
  config.update({ voice: { provider: 'qwen-local', name: 'kurisu_reference_fax' } })
  return new TtsService({ paths, config, secretStore: null, localQwenReady: async () => true })
}

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
      return sseResponse()
    }
    const result = await tts.synthesize('こんにちは。', { voice: 'ja-JP-NanamiNeural' })
    assert.equal(result.provider, 'qwen-local')
    assert.equal(result.mime, 'audio/wav')
    assert.equal(requests[0].url, 'http://127.0.0.1:7860/v1/audio/speech')
    assert.equal(requests[0].body.model, 'Qwen/Qwen3-TTS-12Hz-0.6B-Base')
    assert.equal(requests[0].body.voice, 'kurisu_reference_fax')
    assert.equal(requests[0].body.response_format, 'wav')
    assert.equal(requests[0].body.stream_format, 'sse')
    assert.equal(requests[0].body.language, 'japanese')
    assert.equal(requests[0].body.max_new_tokens, 96)
    assert.equal((await tts.synthesize('こんにちは。', { voice: 'another-voice' })).cached, true)
    const expressive = await tts.synthesize('こんにちは。', { emotion: 'blush', rate: '+20%', pitch: '+30Hz' })
    assert.equal(expressive.cached, true, 'facial expression must reuse the original clone audio')
    assert.equal(expressive.id, result.id)
    assert.deepEqual(expressive.audio, result.audio)
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
      return sseResponse()
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

test('local SSE chunks split across network reads preserve original WAV bytes', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    const audio = wavFixture()
    globalThis.fetch = async () => sseResponse(audio, { split: true })
    const result = await localTts(paths).synthesize('音声の確認です。')
    assert.deepEqual(result.audio, audio)
    assert.deepEqual(fs.readFileSync(path.join(paths.voiceCacheDir, result.id + '.wav')), audio)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('partial local audio followed by an SSE error or missing completion is never cached', async () => {
  for (const ending of ['error', 'eof']) {
    const paths = tempPaths(), originalFetch = globalThis.fetch
    try {
      const tts = localTts(paths)
      globalThis.fetch = async () => sseResponse(wavFixture(), { ending })
      await assert.rejects(tts.synthesize('途中で止まるテスト。'), /中途中断|未完整生成/)
      assert.deepEqual(fs.readdirSync(paths.voiceCacheDir), [])
      globalThis.fetch = async () => sseResponse()
      assert.equal((await tts.synthesize('途中で止まるテスト。')).cached, false)
    } finally { globalThis.fetch = originalFetch; cleanup(paths) }
  }
})

test('corrupt SSE base64, corrupt WAV and truncated finite WAV cannot enter cache', async () => {
  const finite = wavFixture({ streaming: false })
  const brokenHeader = wavFixture(); brokenHeader.writeUInt32LE(1, 28)
  for (const fixture of [() => sseResponse(wavFixture(), { corrupt: true }),
    () => sseResponse(Buffer.alloc(1244, 7)), () => sseResponse(finite.subarray(0, -2)),
    () => sseResponse(wavFixture().subarray(0, -1)), () => sseResponse(brokenHeader)]) {
    const paths = tempPaths(), originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => fixture()
      await assert.rejects(localTts(paths).synthesize('破損した音声のテスト。'), /损坏/)
      assert.deepEqual(fs.readdirSync(paths.voiceCacheDir), [])
    } finally { globalThis.fetch = originalFetch; cleanup(paths) }
  }
})

test('raw HTTP 200 WAV cannot silently replace the required completion event', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(wavFixture(), { headers: { 'Content-Type': 'audio/wav' } })
    await assert.rejects(localTts(paths).synthesize('完了確認のテスト。'), /未返回可验证完成状态/)
    assert.deepEqual(fs.readdirSync(paths.voiceCacheDir), [])
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('valid existing streaming WAV cache remains unchanged; only structurally broken cache is regenerated', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async () => { calls += 1; return sseResponse() }
    const tts = localTts(paths)
    const first = await tts.synthesize('既存の声をそのまま使う。')
    assert.equal((await tts.synthesize('既存の声をそのまま使う。')).cached, true)
    assert.equal(calls, 1)
    const file = path.join(paths.voiceCacheDir, first.id + '.wav')
    fs.writeFileSync(file, Buffer.alloc(1244, 7))
    assert.equal((await tts.synthesize('既存の声をそのまま使う。')).cached, false)
    assert.equal(calls, 2)
    assert.deepEqual(fs.readFileSync(file), first.audio)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('long local synthesis uses bounded sequential segments and joins original PCM exactly', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    const text = '最初に、落ち着いて状況を確かめましょう。'.repeat(3) + '次に、結果を一つずつ比べれば、どこが変わったのかわかるはずよ。'
    const chunks = splitLocalSpeech(text), sent = [], originals = []
    let active = 0, maxActive = 0
    globalThis.fetch = async (url, options) => {
      active += 1; maxActive = Math.max(active, maxActive)
      const body = JSON.parse(options.body)
      sent.push(body)
      const audio = wavFixture()
      audio.fill(sent.length, 44)
      originals.push(audio.subarray(44))
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      return sseResponse(audio)
    }
    const tts = localTts(paths)
    const [a, b] = await Promise.all([tts.synthesize(text), tts.synthesize(text)])
    assert.deepEqual(sent.map(row => row.input), chunks)
    assert.equal(chunks.join(''), text)
    assert.ok(chunks.every(row => [...row].length <= LOCAL_QWEN_CHUNK_MAX))
    assert.equal(maxActive, 1)
    assert.ok(sent.every(row => row.voice === 'kurisu_reference_fax' && row.model === 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'))
    assert.deepEqual(a.audio.subarray(44), Buffer.concat(originals))
    assert.deepEqual(b.audio, a.audio)
    assert.equal(a.audio.readUInt32LE(4), a.audio.length - 8)
    assert.equal((await tts.synthesize(text)).cached, true)
    assert.equal(sent.length, chunks.length)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('a failed later segment cannot cache a partial long reply; retry reuses completed pieces', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    const text = 'あ'.repeat(70) + '、' + 'い'.repeat(30) + '。'
    const chunks = splitLocalSpeech(text)
    assert.equal(chunks.length, 2)
    let count = 0
    globalThis.fetch = async () => { count += 1; return sseResponse(wavFixture(), { ending: count === 2 ? 'error' : 'done' }) }
    const tts = localTts(paths)
    await assert.rejects(tts.synthesize(text), /中途中断/)
    assert.equal(fs.readdirSync(paths.voiceCacheDir).filter(file => file.endsWith('.wav')).length, 1)
    const result = await tts.synthesize(text)
    assert.equal(result.cached, false)
    assert.equal(count, 3)
    assert.equal(result.audio.length, 44 + 1200 * 2)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('old long single-pass cache is preserved but not reused; short clone cache identity stays compatible', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    const text = 'あ'.repeat(70) + '、' + 'い'.repeat(30) + '。'
    const legacyId = crypto.createHash('sha256').update([
      'qwen-local', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base:kurisu_reference_fax:wav-v1', 'neutral', '+0%', '+0Hz', text,
    ].join('\u0001')).digest('hex').slice(0, 32)
    const tts = localTts(paths), old = wavFixture()
    fs.writeFileSync(path.join(paths.voiceCacheDir, legacyId + '.wav'), old)
    fs.writeFileSync(path.join(paths.voiceCacheDir, legacyId + '.json'), JSON.stringify({ ext: 'wav', mime: 'audio/wav', provider: 'qwen-local', words: [] }))
    let count = 0
    globalThis.fetch = async () => { count += 1; return sseResponse() }
    const result = await tts.synthesize(text)
    assert.notEqual(result.id, legacyId)
    assert.equal(count, 2)
    assert.deepEqual(fs.readFileSync(path.join(paths.voiceCacheDir, legacyId + '.wav')), old)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})

test('segments with different PCM formats cannot be concatenated into distorted playback', async () => {
  const paths = tempPaths(), originalFetch = globalThis.fetch
  try {
    const text = 'あ'.repeat(70) + '、' + 'い'.repeat(30) + '。'
    let count = 0
    globalThis.fetch = async () => {
      const audio = wavFixture()
      if (++count === 2) { audio.writeUInt32LE(22050, 24); audio.writeUInt32LE(44100, 28) }
      return sseResponse(audio)
    }
    await assert.rejects(localTts(paths).synthesize(text), /格式不一致/)
    assert.equal(fs.readdirSync(paths.voiceCacheDir).filter(file => file.endsWith('.wav')).length, 2)
  } finally { globalThis.fetch = originalFetch; cleanup(paths) }
})
