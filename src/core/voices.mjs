import path from 'node:path'
import { readJson, writeJsonAtomic } from './store.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'

/**
 * The voice list has two sections: 默认 and user-imported voices.
 *
 * A curated list of speakers invites judgments about who she "should" sound
 * like - and the previous list shipped male presets nobody asked for. So the
 * catalog is: the default, plus imported voices. Two kinds can be imported:
 *   - `edge`: any voice id the online read-aloud service offers
 *   - `system`: a voice installed in Windows (SAPI), which also works offline
 *   - `qwen-local`: a voice registered in the local Qwen TTS WebUI
 *   - `dashscope`: an already enrolled cloud voice ID; the sample audio itself
 *     is not a reusable synthesis voice
 */

export const DEFAULT_VOICE = {
  id: 'ja-JP-NanamiNeural',
  label: '默认',
  provider: 'edge',
  builtin: true,
}

export const VOICE_PROVIDERS = ['edge', 'system', 'dashscope', 'qwen-local']

const EDGE_ID = /^[a-z]{2,3}-[A-Za-z0-9]{2,12}-[A-Za-z0-9]{2,24}Neural$/

export class VoiceLibrary {
  constructor(paths) {
    this.file = path.join(paths.dataRoot, 'voices.json')
  }

  #read() {
    const data = readJson(this.file, { custom: [] })
    const custom = Array.isArray(data?.custom) ? data.custom : []
    return { custom: custom.filter((v) => v && typeof v.id === 'string') }
  }

  list() {
    return this.#read().custom
  }

  /** The entry for a voice id: the built-in default, an import, or null. */
  find(id) {
    const wanted = String(id ?? '')
    if (wanted === DEFAULT_VOICE.id) return DEFAULT_VOICE
    return this.list().find((v) => v.id === wanted) || null
  }

  add({ id, label, provider = 'edge' } = {}) {
    const voiceId = String(id ?? '').trim()
    const kind = String(provider ?? 'edge').trim()
    if (!VOICE_PROVIDERS.includes(kind)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `unknown voice provider: ${kind}`)
    }
    if (kind === 'edge' && !EDGE_ID.test(voiceId)) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        '语音 ID 形如 ja-JP-MayuNeural；本机语音请用「本机语音」导入',
      )
    }
    if (kind === 'system' && (voiceId.length < 2 || voiceId.length > 80)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'invalid system voice name')
    }
    if (kind === 'dashscope' && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(voiceId)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, '阿里云音色 ID 只能包含字母、数字、下划线和短横线')
    }
    if (kind === 'qwen-local' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/.test(voiceId)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, '本地 Qwen 音色 ID 只能包含字母、数字、点、下划线和短横线')
    }
    if (voiceId === DEFAULT_VOICE.id || (kind === 'dashscope' && voiceId === 'Cherry')) {
      throw new AmadeusError(ErrorCode.CONFLICT, '这是默认音色，不需要导入')
    }

    const data = this.#read()
    const existing = data.custom.find((v) => v.id === voiceId)
    if (existing) return existing
    const entry = {
      id: voiceId,
      label: String(label ?? '').trim().slice(0, 40) || voiceId,
      provider: kind,
      addedAt: Date.now(),
    }
    data.custom.push(entry)
    writeJsonAtomic(this.file, data)
    return entry
  }

  remove(id) {
    const wanted = String(id ?? '')
    const data = this.#read()
    const before = data.custom.length
    data.custom = data.custom.filter((v) => v.id !== wanted)
    if (data.custom.length === before) return { removed: 0 }
    writeJsonAtomic(this.file, data)
    return { removed: 1 }
  }
}
