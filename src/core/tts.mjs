import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { synthesize as edgeSynthesize, EDGE_VOICES } from './edge-tts.mjs'
import { normalizeEmotion } from './emotion.mjs'
import { sanitizeForSpeech } from './speech-text.mjs'
import { splitLocalSpeech, LOCAL_QWEN_CHUNK_MAX } from './parse.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'
import { ensureLocalQwen } from './local-qwen-service.mjs'

const logger = createChildLogger('[tts]')

const MAX_CACHE_FILES = 200

/** 阿里云百炼（通义千问语音）—— 与 Amadeus2026 用的是同一家服务。 */
const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const LOCAL_QWEN_URL = 'http://127.0.0.1:7860/v1/audio/speech'
const LOCAL_QWEN_WAIT_MS = 360000
const LOCAL_QWEN_RETRY_MS = 5000
const DEFAULT_EDGE_VOICE = 'ja-JP-NanamiNeural'

function validLocalWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE') return false
  const declared = audio.readUInt32LE(4)
  const streaming = declared === 0xffffffff
  if (!streaming && declared + 8 !== audio.length) return false
  let offset = 12, alignment = 0, hasData = false
  while (offset + 8 <= audio.length) {
    const tag = audio.toString('ascii', offset, offset + 4)
    let size = audio.readUInt32LE(offset + 4)
    offset += 8
    if (tag === 'data' && streaming && size === 0xffffffff) size = audio.length - offset
    if (offset + size > audio.length) return false
    if (tag === 'fmt ') {
      if (alignment || size < 16) return false
      const channels = audio.readUInt16LE(offset + 2)
      const rate = audio.readUInt32LE(offset + 4)
      alignment = audio.readUInt16LE(offset + 12)
      if (audio.readUInt16LE(offset) !== 1 || channels < 1 || channels > 2 || rate < 8000 || rate > 192000 ||
          audio.readUInt16LE(offset + 14) !== 16 || alignment !== channels * 2 ||
          audio.readUInt32LE(offset + 8) !== rate * alignment) return false
    } else if (tag === 'data') {
      if (!alignment || hasData || size === 0 || size % alignment) return false
      hasData = true
    }
    offset += size + (size & 1)
  }
  return hasData && offset === audio.length
}

async function completedLocalWav(response) {
  // The local service streams WAV with unknown RIFF lengths and may end an
  // HTTP 200 early after a generation failure. SSE provides the completion or
  // error event that raw audio lacks. Keep its original PCM bytes unchanged.
  if (!response.headers?.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new AmadeusError(ErrorCode.UNAVAILABLE, '本地 Qwen TTS 未返回可验证完成状态的语音流')
  }
  const chunks = [], decoder = new TextDecoder()
  let pending = '', data = [], complete = false, receivedBytes = 0, audioBytes = 0
  const fail = (message) => { throw new AmadeusError(ErrorCode.UNAVAILABLE, message) }
  const event = () => {
    if (!data.length) return
    let payload
    try { payload = JSON.parse(data.join('\n')) } catch { fail('本地 Qwen TTS 语音流格式损坏') }
    data = []
    if (payload?.type === 'error') fail('本地 Qwen TTS 合成中途中断，未播放或缓存不完整语音')
    if (payload?.type === 'speech.audio.delta') {
      const encoded = payload.audio
      if (complete || typeof encoded !== 'string' || !encoded.length || encoded.length % 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('本地 Qwen TTS 音频片段损坏')
      const chunk = Buffer.from(encoded, 'base64')
      if (chunk.toString('base64') !== encoded) fail('本地 Qwen TTS 音频片段损坏')
      audioBytes += chunk.length
      if (audioBytes > 48 * 1024 * 1024) fail('本地 Qwen TTS 音频超过安全长度')
      chunks.push(chunk)
    } else if (payload?.type === 'speech.audio.done') {
      if (complete || !chunks.length) fail('本地 Qwen TTS 完成事件无有效音频')
      complete = true
    }
  }
  const lines = () => {
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line === '') event()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  try {
    for await (const chunk of response.body) {
      receivedBytes += chunk.length
      if (receivedBytes > 64 * 1024 * 1024) fail('本地 Qwen TTS 语音流超过安全长度')
      pending += decoder.decode(chunk, { stream: true })
      lines()
    }
    pending += decoder.decode()
    lines()
  } catch (error) {
    if (error instanceof AmadeusError) throw error
    fail('本地 Qwen TTS 语音流传输中断，未缓存不完整语音')
  }
  if (!complete || pending.trim() || data.length) fail('本地 Qwen TTS 语音未完整生成，未缓存不完整语音')
  const audio = Buffer.concat(chunks, audioBytes)
  if (!validLocalWav(audio)) fail('本地 Qwen TTS 返回的 WAV 数据损坏，未缓存')
  return audio
}

function joinLocalWavs(parts) {
  // Rebuild only the WAV container. No resampling, crossfade, pitch changes,
  // silence removal or added samples: each segment keeps its original PCM.
  let format = null, size = 0
  const pcm = []
  for (const audio of parts) {
    if (!validLocalWav(audio)) throw new AmadeusError(ErrorCode.UNAVAILABLE, '本地 Qwen TTS 分段音频损坏')
    let offset = 12
    while (offset + 8 <= audio.length) {
      const tag = audio.toString('ascii', offset, offset + 4)
      let length = audio.readUInt32LE(offset + 4)
      offset += 8
      if (tag === 'data' && length === 0xffffffff) length = audio.length - offset
      if (tag === 'fmt ') {
        const current = audio.subarray(offset, offset + 16)
        if (format && !format.equals(current)) throw new AmadeusError(ErrorCode.UNAVAILABLE, '本地 Qwen TTS 分段音频格式不一致')
        format = current
      } else if (tag === 'data') {
        pcm.push(audio.subarray(offset, offset + length))
        size += length
        if (size > 48 * 1024 * 1024) throw new AmadeusError(ErrorCode.UNAVAILABLE, '本地 Qwen TTS 音频过长')
      }
      offset += length + (length & 1)
    }
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(size + 36, 4)
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16)
  format.copy(header, 20)
  header.write('data', 36); header.writeUInt32LE(size, 40)
  return Buffer.concat([header, ...pcm], 44 + size)
}

function cacheKey(req) {
  return crypto
    .createHash('sha256')
    .update([req.provider, req.voice, req.emotion, req.rate, req.pitch, req.text].join('\u0001'))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Voice service.
 *
 * Fixes three defects found in the DSH implementation:
 *  1. no process-global mutable style (that race is gone together with
 *     express-as; see edge-tts.mjs)
 *  2. the cache lives on disk with an LRU bound instead of holding up to
 *     ~240MB of audio buffers in memory
 *  3. identical concurrent requests are de-duplicated through `inflight`
 */
export class TtsService {
  constructor({
    paths, config, secretStore, voices = null, systemTts = null,
    localQwenReady = ensureLocalQwen,
    localQwenWaitMs = LOCAL_QWEN_WAIT_MS,
    localQwenRetryMs = LOCAL_QWEN_RETRY_MS,
  }) {
    this.paths = paths
    this.config = config
    this.secretStore = secretStore
    this.voices = voices
    this.systemTts = systemTts
    this.localQwenReady = localQwenReady
    this.localQwenWaitMs = localQwenWaitMs
    this.localQwenRetryMs = localQwenRetryMs
    this.inflight = new Map()
    fs.mkdirSync(paths.voiceCacheDir, { recursive: true })
  }

  providers() {
    return {
      edge: {
        id: 'edge',
        available: true,
        requiresKey: false,
        voices: EDGE_VOICES,
      },
      dashscope: {
        id: 'dashscope',
        available: Boolean(this.secretStore?.get('ttsApiKey')),
        requiresKey: true,
      },
      'qwen-local': { id: 'qwen-local', available: true, requiresKey: false },
      system: { id: 'system', available: Boolean(this.systemTts?.available?.()), requiresKey: false },
      openai: {
        id: 'openai',
        available: Boolean(this.secretStore?.get('ttsApiKey')),
        requiresKey: true,
      },
      none: { id: 'none', available: true, requiresKey: false },
    }
  }

  providerId() {
    const configured = this.config.getPath('voice.provider') || 'edge'
    if (configured === 'none') return 'none'
    if (configured === 'dashscope' && !this.secretStore?.get('ttsApiKey')) {
      // A new install can still use the built-in Edge voice without a key.
      // A selected *custom* cloud voice must not silently become someone else.
      const defaultCloudVoice = (this.config.getPath('voice.name') || 'Cherry') === 'Cherry'
      return defaultCloudVoice || this.config.getPath('voice.stability') === false ? 'edge' : 'dashscope'
    }
    if (configured === 'openai' && !this.secretStore?.get('ttsApiKey')) {
      logger.warn('openai tts requested but no key configured; degrading to edge')
      return 'edge'
    }
    return configured
  }

  #metaFile(id) {
    return path.join(this.paths.voiceCacheDir, `${id}.json`)
  }

  #audioFile(id, ext = 'mp3') {
    return path.join(this.paths.voiceCacheDir, `${id}.${ext}`)
  }

  #readCache(id) {
    try {
      const meta = JSON.parse(fs.readFileSync(this.#metaFile(id), 'utf8'))
      const audio = fs.readFileSync(this.#audioFile(id, meta.ext || 'mp3'))
      if (audio.length < 200) throw new Error('cache entry too small')
      if (meta.provider === 'qwen-local' && !validLocalWav(audio)) throw new Error('invalid local WAV cache')
      fs.utimesSync(this.#audioFile(id, meta.ext || 'mp3'), new Date(), new Date())
      return { ...meta, audio }
    } catch {
      return null
    }
  }

  #writeCache(id, { audio, words, mime, provider, style }) {
    // The extension follows the container so a WAV voice is not stored as .mp3.
    const ext = /wav/i.test(String(mime || '')) ? 'wav' : 'mp3'
    fs.writeFileSync(this.#audioFile(id, ext), audio, { mode: 0o600 })
    fs.writeFileSync(
      this.#metaFile(id),
      JSON.stringify({ words, mime, provider, style, ext, ts: Date.now() }),
      { mode: 0o600 },
    )
    this.#evict()
  }

  #evict() {
    let files
    try {
      files = fs
        .readdirSync(this.paths.voiceCacheDir)
        .filter((f) => f.endsWith('.mp3') || f.endsWith('.wav'))
        .map((f) => {
          const full = path.join(this.paths.voiceCacheDir, f)
          return { full, atime: fs.statSync(full).atimeMs }
        })
        .sort((a, b) => a.atime - b.atime)
    } catch {
      return
    }
    const excess = files.length - MAX_CACHE_FILES
    for (let i = 0; i < excess; i++) {
      const base = files[i].full.replace(/\.(mp3|wav)$/, '')
      for (const leftover of [`${base}.mp3`, `${base}.wav`, `${base}.json`]) {
        try {
          fs.unlinkSync(leftover)
        } catch {
          /* the other container or a missing meta file */
        }
      }
    }
  }

  /**
   * Synthesize one sentence. Returns audio bytes plus word timings.
   * Never throws for "provider not configured": it degrades to the default.
   */
  async synthesize(text, { voice, emotion, rate, pitch } = {}) {
    // Markdown, emoji and bare URLs were being handed to the provider verbatim,
    // which is where "the audio stutters and then vanishes" came from.
    const clean = sanitizeForSpeech(text)
    if (clean.length === 0) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'empty text')
    }
    if (clean.length > 300) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'text too long (max 300)')
    }

    const provider = this.providerId()
    if (provider === 'none') {
      throw new AmadeusError(ErrorCode.DEGRADED, 'voice is disabled in settings', {
        degrade: 'voice-disabled',
      })
    }

    const req = {
      provider,
      text: clean,
      // A local clone is the sole speaker for every Amadeus speech path.
      // Ignore per-request overrides so a tool or stale panel cannot switch voices.
      voice: provider === 'qwen-local'
        ? this.config.getPath('voice.name') || ''
        : voice || this.config.getPath('voice.name') || 'ja-JP-NanamiNeural',
      emotion: normalizeEmotion(emotion, 'neutral'),
      rate: rate || this.config.getPath('voice.rate') || '+0%',
      pitch: pitch || this.config.getPath('voice.pitch') || '+0Hz',
      intensity: this.config.getPath('voice.emotionIntensity') ?? 1,
    }
    if (provider === 'qwen-local' && !req.voice) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, '本地克隆音色 ID 未配置')
    }

    // An imported Windows voice is rendered by the operating system: offline,
    // no key, and the only route that can use a voice the user installed.
    if (provider === 'system' || (provider !== 'qwen-local' && this.voices?.find(req.voice)?.provider === 'system')) {
      return this.#synthesizeWithSystem(req)
    }

    if (provider === 'edge' && !/Neural$/.test(req.voice)) {
      req.voice = DEFAULT_EDGE_VOICE
    }

    // 阿里云百炼。声线稳定模式（默认）下失败会明确报错；只有用户关闭
    // 稳定模式时才允许退回 Edge，避免同一段回答突然换成另一个人。
    if (provider === 'dashscope') {
      try {
        return await this.#synthesizeDashscope(req)
      } catch (e) {
        if (this.config.getPath('voice.stability') !== false) throw e
        logger.warn(
          'dashscope tts failed, falling back to the built-in Edge voice:',
          e && e.message ? e.message : e,
        )
        if (!/Neural$/.test(req.voice)) req.voice = DEFAULT_EDGE_VOICE
        req.provider = 'edge'
      }
    }

    if (provider === 'qwen-local') return this.#synthesizeLocalQwen(req)

    const id = cacheKey(req)
    const cached = this.#readCache(id)
    if (cached) return { id, cached: true, ...cached }
    if (this.inflight.has(id)) return this.inflight.get(id)

    const task = (async () => {
      const result = await edgeSynthesize({
        text: req.text,
        voice: req.voice,
        emotion: req.emotion,
        rate: req.rate,
        pitch: req.pitch,
        intensity: req.intensity,
      })
      this.#writeCache(id, {
        audio: result.audio,
        words: result.words,
        mime: result.mime,
        provider: req.provider,
        style: result.style,
      })
      return {
        id,
        cached: false,
        audio: result.audio,
        words: result.words,
        mime: result.mime,
        provider: req.provider,
      }
    })()

    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  /**
   * 阿里云百炼（DashScope）qwen3-tts-flash：返回音频 URL，下载后按 mp3 缓存。
   * Amadeus2026 用的是同一家服务；它的"声音复刻"音色需要账号开通复刻模型，
   * 这里默认走可用的通用音色，导入的复刻音色 ID 也走同一条链路。
   */
  async #synthesizeDashscope(req) {
    const key = this.secretStore?.get('ttsApiKey')
    if (!key) {
      throw new AmadeusError(ErrorCode.DEGRADED, 'no Aliyun (DashScope) key configured', {
        degrade: 'missing-tts-key',
      })
    }
    const id = cacheKey({ ...req, provider: 'dashscope' })
    const cached = this.#readCache(id)
    if (cached) return { id, cached: true, ...cached }
    if (this.inflight.has(id)) return this.inflight.get(id)

    const model = this.config.getPath('voice.dashscopeModel') || 'qwen3-tts-flash'
    const task = (async () => {
      const res = await fetch(DASHSCOPE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          input: { text: req.text, voice: req.voice, language_type: 'Japanese' },
        }),
        signal: AbortSignal.timeout(30000),
      })
      const body = await res.text()
      if (!res.ok) {
        throw new AmadeusError(
          ErrorCode.UNAVAILABLE,
          `dashscope http ${res.status} ${body.slice(0, 200)}`,
        )
      }
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = null
      }
      const url = parsed?.output?.audio?.url
      if (!url) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, 'dashscope returned no audio url')
      }
      const audioRes = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!audioRes.ok) {
        throw new AmadeusError(
          ErrorCode.UNAVAILABLE,
          `dashscope audio http ${audioRes.status}`,
        )
      }
      const audio = Buffer.from(await audioRes.arrayBuffer())
      if (audio.length < 1000) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, 'dashscope audio too small')
      }
      this.#writeCache(id, {
        audio,
        words: [],
        mime: 'audio/mpeg',
        provider: 'dashscope',
        style: null,
      })
      return { id, cached: false, audio, words: [], mime: 'audio/mpeg', provider: 'dashscope' }
    })()

    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  /** Qwen TTS WebUI runs only on loopback and uses a registered reference voice. */
  async #waitForLocalQwen() {
    const deadline = Date.now() + this.localQwenWaitMs
    do {
      try {
        if (await this.localQwenReady(this.paths)) return true
      } catch (error) {
        logger.warn('local Qwen startup attempt failed:', error?.message || String(error))
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve,
        Math.min(this.localQwenRetryMs, Math.max(1, deadline - Date.now()))))
    } while (true)
    return false
  }

  async #synthesizeLocalQwen(req) {
    const model = req.localModel || this.config.getPath('voice.localModel') || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
    const chunks = splitLocalSpeech(req.text)
    const segmented = chunks.length > 1
    // The format is part of the key so old lossy MP3 entries are not served
    // after switching the local clone to lossless WAV output.
    // Local Base cloning does not use emotion, speed or pitch. Canonicalize
    // those cache dimensions too: facial changes must not resample the same
    // line and make the selected clone sound different on each expression.
    const version = segmented ? `wav-chunks-${LOCAL_QWEN_CHUNK_MAX}-v1` : 'wav-v1'
    const id = cacheKey({ ...req, emotion: 'neutral', rate: '+0%', pitch: '+0Hz',
      voice: `${model}:${req.voice}:${version}` })
    const cached = this.#readCache(id)
    if (cached) return { id, cached: true, ...cached }
    if (this.inflight.has(id)) return this.inflight.get(id)

    const task = (async () => {
      if (segmented) {
        const parts = []
        // Chat normally queues these pieces individually for early playback.
        // Other callers still get safe synthesis, without reusing old long
        // single-pass clips or changing any existing short reaction cache.
        for (const text of chunks) {
          const part = await this.#synthesizeLocalQwen({ ...req, text, localModel: model })
          parts.push(part.audio)
        }
        const audio = joinLocalWavs(parts)
        const result = { audio, words: [], mime: 'audio/wav', provider: 'qwen-local' }
        this.#writeCache(id, result)
        return { id, cached: false, ...result }
      }
      if (!(await this.#waitForLocalQwen())) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE,
          '本地 Qwen TTS 未就绪：等待冷启动后仍无法连接 127.0.0.1:7860，请检查语音实例')
      }
      let res
      try {
        res = await fetch(LOCAL_QWEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            voice: req.voice,
            input: req.text,
            language: 'japanese',
            response_format: 'wav',
            stream_format: 'sse',
            max_new_tokens: Math.min(1200, Math.max(96, req.text.length * 8)),
          }),
          signal: AbortSignal.timeout(180000),
        })
      } catch (e) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, `本地 Qwen TTS 不可连接：${e.message}`)
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        throw new AmadeusError(ErrorCode.UNAVAILABLE, `本地 Qwen TTS HTTP ${res.status} ${detail}`)
      }
      const audio = await completedLocalWav(res)
      if (audio.length < 1000) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, '本地 Qwen TTS 返回的音频过短')
      }
      this.#writeCache(id, {
        audio,
        words: [],
        mime: 'audio/wav',
        provider: 'qwen-local',
        style: null,
      })
      return { id, cached: false, audio, words: [], mime: 'audio/wav', provider: 'qwen-local' }
    })()

    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  /** SAPI path: same cache and inflight rules as the online provider. */
  async #synthesizeWithSystem(req) {
    if (!this.systemTts?.synthesize) {
      throw new AmadeusError(ErrorCode.DEGRADED, 'no system speech command on this platform', {
        degrade: 'no-system-voice',
      })
    }
    const id = cacheKey({ ...req, provider: 'system' })
    const cached = this.#readCache(id)
    if (cached) return { id, cached: true, ...cached }
    if (this.inflight.has(id)) return this.inflight.get(id)

    const task = (async () => {
      const result = await this.systemTts.synthesize({
        text: req.text,
        voice: req.voice,
        ratePercent: Number(String(req.rate).replace('%', '')) || 0,
      })
      const payload = {
        audio: result.audio,
        words: result.words || [],
        mime: result.mime || 'audio/wav',
        provider: 'system',
        style: null,
      }
      this.#writeCache(id, payload)
      return { id, cached: false, audio: payload.audio, words: payload.words, mime: payload.mime, provider: 'system' }
    })()

    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  stats() {
    let files = 0
    try {
      files = fs.readdirSync(this.paths.voiceCacheDir).filter((f) => f.endsWith('.mp3')).length
    } catch {
      /* ignore */
    }
    return { cachedFiles: files, inflight: this.inflight.size, provider: this.providerId() }
  }
}
