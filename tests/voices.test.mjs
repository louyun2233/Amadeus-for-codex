import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceLibrary, DEFAULT_VOICE } from '../src/core/voices.mjs'
import { TtsService } from '../src/core/tts.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * The voice catalog is 默认 + 导入. A curated speaker menu shipped male presets
 * nobody asked for, so what has to stay true is: the built-in default, and
 * exactly what the user brought in - validated, deduplicated, removable, and
 * routable to the right engine.
 */

function library() {
  const paths = tempPaths()
  return { paths, voices: new VoiceLibrary(paths) }
}

test('the built-in default is the only preset', () => {
  assert.equal(DEFAULT_VOICE.provider, 'edge')
  assert.match(DEFAULT_VOICE.id, /^ja-JP-.*Neural$/)
  assert.equal(DEFAULT_VOICE.builtin, true)
})

test('imports are validated before they are stored', () => {
  const { paths, voices } = library()
  try {
    assert.equal(voices.list().length, 0)
    assert.throws(() => voices.add({ id: 'hello' }), /语音 ID/)
    assert.throws(() => voices.add({ id: 'ja-JP-MayuNeural', provider: 'nope' }), /provider/)
    assert.throws(() => voices.add({ id: DEFAULT_VOICE.id }), /默认音色/)

    const edge = voices.add({ id: 'ja-JP-MayuNeural', label: '麻友' })
    assert.equal(edge.provider, 'edge')
    assert.equal(edge.label, '麻友')
    assert.equal(voices.list().length, 1)

    const system = voices.add({
      id: 'Microsoft Huihui Desktop',
      label: '慧慧',
      provider: 'system',
    })
    assert.equal(system.provider, 'system')
    const cloned = voices.add({ id: 'qwen_clone_123', label: '红莉栖', provider: 'dashscope' })
    assert.equal(cloned.provider, 'dashscope')
    const local = voices.add({ id: 'kurisu_reference_fax', label: '本地红莉栖', provider: 'qwen-local' })
    assert.equal(local.provider, 'qwen-local')
    assert.throws(() => voices.add({ id: '../unsafe', provider: 'qwen-local' }), /本地 Qwen 音色 ID/)
    assert.throws(() => voices.add({ id: 'voice with spaces', provider: 'dashscope' }), /阿里云音色 ID/)
    assert.throws(() => voices.add({ id: 'Cherry', provider: 'dashscope' }), /默认音色/)
    assert.equal(voices.list().length, 4)
  } finally {
    cleanup(paths)
  }
})

test('an import without a label falls back to its id, and duplicates are reused', () => {
  const { paths, voices } = library()
  try {
    const first = voices.add({ id: 'ja-JP-AoiNeural' })
    assert.equal(first.label, 'ja-JP-AoiNeural')
    const again = voices.add({ id: 'ja-JP-AoiNeural', label: '别的名字' })
    assert.equal(again.label, first.label, 'the same voice is never stored twice')
    assert.equal(voices.list().length, 1)
  } finally {
    cleanup(paths)
  }
})

test('lookup covers the default, the imports and unknown ids', () => {
  const { paths, voices } = library()
  try {
    voices.add({ id: 'ja-JP-ShioriNeural', label: '诗织' })
    assert.equal(voices.find(DEFAULT_VOICE.id).builtin, true)
    assert.equal(voices.find('ja-JP-ShioriNeural').label, '诗织')
    assert.equal(voices.find('ja-JP-NotImportedNeural'), null)
    assert.equal(voices.find(undefined), null)
  } finally {
    cleanup(paths)
  }
})

test('removing an import leaves the rest alone', () => {
  const { paths, voices } = library()
  try {
    voices.add({ id: 'ja-JP-ShioriNeural' })
    voices.add({ id: 'ja-JP-MayuNeural' })
    assert.deepEqual(voices.remove('ja-JP-ShioriNeural'), { removed: 1 })
    assert.deepEqual(voices.remove('ja-JP-ShioriNeural'), { removed: 0 })
    assert.deepEqual(
      voices.list().map((v) => v.id),
      ['ja-JP-MayuNeural'],
    )
  } finally {
    cleanup(paths)
  }
})

test('a system voice is rendered by the OS and cached like any other', async () => {
  const paths = tempPaths()
  try {
    const config = new ConfigStore(paths)
    const voices = new VoiceLibrary(paths)
    voices.add({ id: 'Microsoft Huihui Desktop', label: '慧慧', provider: 'system' })
    const calls = []
    const systemTts = {
      synthesize: async ({ text, voice }) => {
        calls.push({ text, voice })
        return { audio: Buffer.alloc(600, 7), mime: 'audio/wav', words: [] }
      },
    }
    const tts = new TtsService({ paths, config, secretStore: null, voices, systemTts })

    const out = await tts.synthesize('こんにちは', { voice: 'Microsoft Huihui Desktop' })
    assert.equal(out.provider, 'system')
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.audio.length, 600)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].voice, 'Microsoft Huihui Desktop')

    const cached = await tts.synthesize('こんにちは', { voice: 'Microsoft Huihui Desktop' })
    assert.equal(cached.cached, true)
    assert.equal(calls.length, 1, 'the second request is served from the cache')
  } finally {
    cleanup(paths)
  }
})

test('a source-configured system voice works without a panel library import', async () => {
  const paths = tempPaths()
  try {
    const config = new ConfigStore(paths)
    config.update({ voice: { enabled: true, provider: 'system', name: 'Example Voice' } })
    const systemTts = {
      available: () => true,
      synthesize: async ({ voice }) => ({ audio: Buffer.alloc(600, 7), mime: 'audio/wav', words: [], voice }),
    }
    const tts = new TtsService({ paths, config, secretStore: null, systemTts })
    assert.equal(tts.providerId(), 'system')
    const out = await tts.synthesize('こんにちは')
    assert.equal(out.provider, 'system')
    assert.equal(out.audio.length, 600)
  } finally {
    cleanup(paths)
  }
})

test('a system voice without a system engine degrades instead of throwing raw', async () => {
  const paths = tempPaths()
  try {
    const config = new ConfigStore(paths)
    const voices = new VoiceLibrary(paths)
    voices.add({ id: 'Microsoft Huihui Desktop', provider: 'system' })
    const tts = new TtsService({ paths, config, secretStore: null, voices, systemTts: null })
    await assert.rejects(
      () => tts.synthesize('こんにちは', { voice: 'Microsoft Huihui Desktop' }),
      (e) => {
        assert.equal(e.degrade, 'no-system-voice')
        return true
      },
    )
  } finally {
    cleanup(paths)
  }
})
