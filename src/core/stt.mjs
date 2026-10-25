import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'
import { envNameFor } from './secrets.mjs'

const logger = createChildLogger('[stt]')

/**
 * Speech-to-text.
 *
 * The upstream DSH plugin only ever had browser Web Speech: on a machine whose
 * browser has no recognition service (or whose language is unsupported) the mic
 * button was simply dead. This service adds a server-side channel without
 * removing the working one.
 *
 * Three providers, and only one of them can fail closed:
 *   - `browser` (default): recognition happens in the panel. The daemon refuses
 *     with `degrade: 'use-browser'` so the panel keeps its own path.
 *   - `api`: audio goes to an OpenAI-compatible `/audio/transcriptions`
 *     endpoint. Point `AMADEUS_OPENAI_BASE_URL` at a local whisper server
 *     (whisper.cpp, faster-whisper, vLLM) to keep audio on the machine; a
 *     custom base URL makes the API key optional, because local servers rarely
 *     have one.
 *   - `none`: the feature is switched off on purpose.
 *
 * Audio is never written to disk and never logged; only the byte count is.
 */

export const STT_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_STT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_STT_MODEL = 'whisper-1'
export const STT_TIMEOUT_MS = 45000

/** Formats every Chromium/Firefox/Safari MediaRecorder can produce. */
export const ALLOWED_AUDIO_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
])

const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
}

/** `audio/webm;codecs=opus` -> `audio/webm`. */
export function baseMime(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

/** `zh-CN` -> `zh`; anything that is not a language tag -> null. */
export function langForApi(lang) {
  const raw = String(lang ?? '').trim()
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw)) return null
  return raw.split('-')[0].toLowerCase()
}

export function fileForMime(mime) {
  return `audio.${MIME_EXT[baseMime(mime)] || 'webm'}`
}

/** Never leak credentials that a user may have hidden inside a base URL. */
function hostOf(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return 'invalid-url'
  }
}

export class SttService {
  constructor({ config, secretStore, fetchImpl, timeoutMs = STT_TIMEOUT_MS } = {}) {
    this.config = config
    this.secretStore = secretStore
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args))
    this.timeoutMs = timeoutMs
  }

  providerId() {
    const configured = this.config?.getPath?.('speechInput.provider') || 'windows-native'
    return ['windows-native', 'browser', 'api', 'none'].includes(configured) ? configured : 'windows-native'
  }

  #baseUrl() {
    const configured = this.secretStore?.get('openaiBaseUrl') || DEFAULT_STT_BASE_URL
    return String(configured).replace(/\/+$/, '')
  }

  #key() {
    return this.secretStore?.get('sttApiKey') || null
  }

  #model() {
    return this.config?.getPath?.('speechInput.apiModel') || DEFAULT_STT_MODEL
  }

  /**
   * What the daemon tells the panel and the self-check. No secrets: the key is
   * reported as a boolean and the base URL only as scheme+host.
   */
  describe() {
    const provider = this.providerId()
    const key = this.#key()
    const base = this.#baseUrl()
    const selfHosted = base !== DEFAULT_STT_BASE_URL
    const out = {
      provider,
      model: this.#model(),
      endpoint: hostOf(base),
      selfHosted,
      keyConfigured: Boolean(key),
      ready: true,
      degrade: null,
      reason: '',
    }
    if (provider === 'none') {
      out.reason = 'speech input is switched off'
    } else if (provider === 'windows-native') {
      out.endpoint = 'Windows Speech Recognition'
      out.selfHosted = true
      out.reason = 'recognition runs in the native Windows panel'
    } else if (provider === 'browser') {
      out.reason = 'recognition runs in the panel (no key needed)'
    } else if (key || selfHosted) {
      out.reason = selfHosted
        ? 'audio goes to the configured endpoint'
        : 'audio goes to the configured speech API'
    } else {
      out.ready = false
      out.degrade = 'missing-key'
      out.reason = `no speech API key; set ${envNameFor('sttApiKey')} or paste it in the panel`
    }
    return out
  }

  /** Cheap gate the panel can consult before it even opens the microphone. */
  isReady() {
    return this.describe().ready
  }

  async transcribe(audio, { mime, lang } = {}) {
    const provider = this.providerId()
    if (provider === 'windows-native') {
      throw new AmadeusError(ErrorCode.DEGRADED, 'speech input is handled in the native Windows panel', {
        degrade: 'use-native-panel',
      })
    }
    if (provider === 'browser') {
      throw new AmadeusError(ErrorCode.DEGRADED, 'speech input is handled in the browser', {
        degrade: 'use-browser',
      })
    }
    if (provider === 'none') {
      throw new AmadeusError(ErrorCode.DEGRADED, 'speech input is switched off', {
        degrade: 'mic-disabled',
      })
    }

    const type = baseMime(mime)
    if (!ALLOWED_AUDIO_MIME.has(type)) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        `unsupported audio type: ${type || '(none)'}`,
      )
    }
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || [])
    if (bytes.length === 0) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'empty audio')
    }
    if (bytes.length > STT_MAX_BYTES) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        `audio too large (${bytes.length} bytes, max ${STT_MAX_BYTES})`,
      )
    }

    const base = this.#baseUrl()
    const key = this.#key()
    if (!key && base === DEFAULT_STT_BASE_URL) {
      throw new AmadeusError(
        ErrorCode.DEGRADED,
        `no speech API key; set ${envNameFor('sttApiKey')} or paste it in the panel`,
        { degrade: 'missing-key' },
      )
    }

    const form = new FormData()
    form.set('model', this.#model())
    form.set('response_format', 'json')
    const language = langForApi(lang ?? this.config?.getPath?.('speechInput.lang'))
    if (language) form.set('language', language)
    form.set('file', new Blob([bytes], { type }), fileForMime(type))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const started = Date.now()
    let res
    try {
      res = await this.fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Amadeus-Codex/0.1',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: form,
        signal: controller.signal,
      })
    } catch (e) {
      const aborted = Boolean(e) && (e.name === 'AbortError' || /abort/i.test(e.message || ''))
      throw new AmadeusError(
        ErrorCode.UNAVAILABLE,
        aborted
          ? `speech api timed out after ${this.timeoutMs}ms`
          : `speech api unreachable: ${(e && e.message) || e}`,
        { degrade: aborted ? 'stt-timeout' : 'stt-unreachable' },
      )
    } finally {
      clearTimeout(timer)
    }

    const body = await res.text().catch(() => '')
    if (!res.ok) {
      const rejected = res.status === 401 || res.status === 403
      throw new AmadeusError(
        rejected ? ErrorCode.DEGRADED : ErrorCode.UNAVAILABLE,
        `speech api http ${res.status} ${body.slice(0, 200)}`,
        { degrade: rejected ? 'api-key-rejected' : 'stt-upstream' },
      )
    }

    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = { text: body }
    }
    const text = String(parsed?.text ?? parsed?.transcript ?? '').trim()
    // Length only: a transcript is private, and this file is the one place that
    // could leak it into a log.
    logger.info(`transcribed ${bytes.length} bytes in ${Date.now() - started}ms`)
    return { text, provider: 'api', bytes: bytes.length, ms: Date.now() - started }
  }
}
