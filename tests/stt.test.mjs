import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SttService,
  baseMime,
  fileForMime,
  langForApi,
  STT_MAX_BYTES,
  DEFAULT_STT_BASE_URL,
} from '../src/core/stt.mjs'

/**
 * The speech-to-text channel is the one feature that could turn a broken
 * configuration into a dead mic button, so the contract is: refuse with a
 * reason the panel can act on, never throw at the caller, never log or return
 * audio, and never call upstream with a payload the provider would reject.
 */

function service({ provider = 'api', key = 'sk-test-key', baseUrl = null, model = null, fetchImpl, timeoutMs } = {}) {
  const secretStore = {
    get(name) {
      if (name === 'sttApiKey') return key
      if (name === 'openaiBaseUrl') return baseUrl
      return null
    },
  }
  const config = {
    getPath(path) {
      if (path === 'speechInput.provider') return provider
      if (path === 'speechInput.lang') return 'zh-CN'
      if (path === 'speechInput.apiModel') return model
      return undefined
    },
  }
  return new SttService({ config, secretStore, fetchImpl, timeoutMs })
}

function recorder(result = { ok: true, status: 200, body: '{"text":"你好"}' }) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts })
      if (result instanceof Error) throw result
      return {
        ok: result.ok,
        status: result.status,
        text: async () => result.body,
      }
    },
  }
}

test('mime and language helpers normalise what the browser sends', () => {
  assert.equal(baseMime('audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(baseMime(undefined), '')
  assert.equal(fileForMime('audio/webm;codecs=opus'), 'audio.webm')
  assert.equal(fileForMime('audio/mp4'), 'audio.m4a')
  assert.equal(fileForMime('application/octet-stream'), 'audio.webm')

  assert.equal(langForApi('zh-CN'), 'zh')
  assert.equal(langForApi('ja-JP'), 'ja')
  assert.equal(langForApi('en'), 'en')
  assert.equal(langForApi(''), null)
  assert.equal(langForApi('../../etc/passwd'), null)
})

test('the browser provider tells the panel to keep its own path', async () => {
  const { calls, fetchImpl } = recorder()
  const stt = service({ provider: 'browser', fetchImpl })
  await assert.rejects(() => stt.transcribe(Buffer.from('audio'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.degrade, 'use-browser')
    return true
  })
  assert.equal(calls.length, 0, 'the browser path must not call upstream')
})

test('a switched-off provider explains itself', async () => {
  const stt = service({ provider: 'none', fetchImpl: recorder().fetchImpl })
  await assert.rejects(() => stt.transcribe(Buffer.from('audio'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.degrade, 'mic-disabled')
    return true
  })
})

test('an api provider without a key refuses before spending a request', async () => {
  const { calls, fetchImpl } = recorder()
  const stt = service({ key: null, fetchImpl })
  const described = stt.describe()
  assert.equal(described.ready, false)
  assert.equal(described.degrade, 'missing-key')
  assert.ok(described.reason.includes('AMADEUS_STT_API_KEY'), described.reason)
  assert.equal(stt.isReady(), false)

  await assert.rejects(() => stt.transcribe(Buffer.from('audio'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.degrade, 'missing-key')
    return true
  })
  assert.equal(calls.length, 0)
})

test('a self-hosted endpoint does not need a key', async () => {
  const { calls, fetchImpl } = recorder({ ok: true, status: 200, body: '{"text":"  你好  "}' })
  const stt = service({ key: null, baseUrl: 'http://127.0.0.1:8080/v1/', fetchImpl })
  const described = stt.describe()
  assert.equal(described.ready, true)
  assert.equal(described.selfHosted, true)
  assert.equal(described.endpoint, 'http://127.0.0.1:8080')

  const out = await stt.transcribe(Buffer.from('fake-audio'), { mime: 'audio/webm;codecs=opus' })
  assert.equal(out.text, '你好')
  assert.equal(calls.length, 1)
  // trailing slashes in the configured base URL must not produce `//audio/...`
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/audio/transcriptions')
  assert.equal(calls[0].opts.headers.Authorization, undefined)
})

test('a transcription request carries the model, the language and the audio', async () => {
  const { calls, fetchImpl } = recorder({ ok: true, status: 200, body: '{"text":"测试音频"}' })
  const stt = service({ fetchImpl })
  const out = await stt.transcribe(Buffer.from('fake-audio-bytes'), { mime: 'audio/webm' })

  assert.equal(out.text, '测试音频')
  assert.equal(out.provider, 'api')
  assert.equal(out.bytes, 'fake-audio-bytes'.length)
  assert.equal(calls.length, 1)

  const [call] = calls
  assert.equal(call.url, `${DEFAULT_STT_BASE_URL}/audio/transcriptions`)
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-test-key')
  assert.ok(call.opts.body instanceof FormData)
  assert.equal(call.opts.body.get('model'), 'whisper-1')
  assert.equal(call.opts.body.get('language'), 'zh')
  assert.equal(call.opts.body.get('response_format'), 'json')
  assert.equal(call.opts.body.get('file').type, 'audio/webm')

  // Serialise the real multipart body: that is what the provider actually sees.
  const wire = await new Response(call.opts.body).text()
  assert.match(wire, /name="file"/)
  assert.match(wire, /filename="audio\.webm"/)
  assert.ok(wire.includes('fake-audio-bytes'), 'the audio bytes must be in the body')
})

test('the configured model is used when one is set', async () => {
  const { calls, fetchImpl } = recorder()
  const stt = service({ model: 'whisper-large-v3', fetchImpl })
  await stt.transcribe(Buffer.from('x'), { mime: 'audio/webm' })
  assert.equal(calls[0].opts.body.get('model'), 'whisper-large-v3')
})

test('audio that upstream would reject never leaves the machine', async () => {
  const { calls, fetchImpl } = recorder()
  const stt = service({ fetchImpl })

  await assert.rejects(() => stt.transcribe(Buffer.alloc(0), { mime: 'audio/webm' }), /empty audio/)
  await assert.rejects(
    () => stt.transcribe(Buffer.from('x'), { mime: 'application/json' }),
    /unsupported audio type/,
  )
  await assert.rejects(
    () => stt.transcribe(Buffer.alloc(STT_MAX_BYTES + 1, 1), { mime: 'audio/webm' }),
    /audio too large/,
  )
  assert.equal(calls.length, 0)
})

test('upstream failures are classified instead of thrown raw', async () => {
  const rejected = service({
    fetchImpl: recorder({ ok: false, status: 401, body: '{"error":"bad key"}' }).fetchImpl,
  })
  await assert.rejects(() => rejected.transcribe(Buffer.from('x'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.code, 'degraded')
    assert.equal(e.degrade, 'api-key-rejected')
    return true
  })

  const broken = service({
    fetchImpl: recorder({ ok: false, status: 500, body: 'boom' }).fetchImpl,
  })
  await assert.rejects(() => broken.transcribe(Buffer.from('x'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.code, 'unavailable')
    assert.equal(e.degrade, 'stt-upstream')
    return true
  })

  const offline = service({
    fetchImpl: recorder(Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }))
      .fetchImpl,
  })
  await assert.rejects(() => offline.transcribe(Buffer.from('x'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.degrade, 'stt-unreachable')
    return true
  })

  const timedOut = service({
    fetchImpl: recorder(Object.assign(new Error('aborted'), { name: 'AbortError' })).fetchImpl,
  })
  await assert.rejects(() => timedOut.transcribe(Buffer.from('x'), { mime: 'audio/webm' }), (e) => {
    assert.equal(e.degrade, 'stt-timeout')
    assert.match(e.message, /timed out/)
    return true
  })
})

test('the service description never carries the key or the audio', () => {
  const stt = service({ key: 'sk-do-not-leak', baseUrl: 'https://example.invalid/v1' })
  const described = JSON.stringify(stt.describe())
  assert.ok(!described.includes('sk-do-not-leak'))
  assert.ok(!described.includes('/v1'), 'only scheme+host is reported')
  assert.equal(stt.describe().keyConfigured, true)
})

test('a non-JSON upstream answer is still shaped like a transcript', async () => {
  const { fetchImpl } = recorder({ ok: true, status: 200, body: 'plain text, not json' })
  const out = await service({ fetchImpl }).transcribe(Buffer.from('x'), { mime: 'audio/webm' })
  assert.equal(out.text, 'plain text, not json')
})
