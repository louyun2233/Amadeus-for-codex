import { DEFAULT_VOICE } from '../core/voices.mjs'
import { ErrorCode } from '../shared/errors.mjs'

/** Voice library and selection endpoints. */
export function createVoiceRoutes({ guard, readBody, sendJson, voices, systemTts, config, secrets, audit }) {
  return {
    'GET /amadeus/voices': guard(async (req, res, url) => {
      if (!voices) return sendJson(res, 503, { ok: false, error: 'voice library unavailable' })
      const withSystem = url.searchParams.get('system') === '1'
      const system = withSystem && systemTts ? await systemTts.listVoices() : []
      // The built-in default follows the configured provider.
      const provider = config.getPath('voice.provider') || 'edge'
      const aliyunReady = provider === 'dashscope' && Boolean(secrets.get('ttsApiKey'))
      const fallbackDefault = aliyunReady
        ? {
            id: 'Cherry',
            label: '默认（阿里云）',
            provider: 'dashscope',
            builtin: true,
          }
        : DEFAULT_VOICE
      sendJson(res, 200, {
        ok: true,
        default: fallbackDefault,
        provider,
        aliyunReady,
        custom: voices.list(),
        selected: config.getPath('voice.name') || DEFAULT_VOICE.id,
        system,
      })
    }),

    'POST /amadeus/voices/import': guard(async (req, res) => {
      if (!voices) return sendJson(res, 503, { ok: false, error: 'voice library unavailable' })
      const body = await readBody(req)
      try {
        const entry = voices.add({
          id: body?.id,
          label: body?.label,
          provider: body?.provider || 'edge',
        })
        audit.record({ source: 'panel', tool: 'voice.import', summary: entry.id })
        sendJson(res, 200, { ok: true, voice: entry, custom: voices.list() })
      } catch (e) {
        const status = e.code === ErrorCode.INVALID_ARGUMENT ? 400 : 409
        sendJson(res, status, { ok: false, error: e.message, degrade: e.degrade || null })
      }
    }),

    'POST /amadeus/voices/remove': guard(async (req, res) => {
      if (!voices) return sendJson(res, 503, { ok: false, error: 'voice library unavailable' })
      const body = await readBody(req)
      const id = String(body?.id ?? '').trim()
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
      const removed = voices.remove(id)
      // Never leave the selection pointing at a voice that no longer exists.
      if ((config.getPath('voice.name') || '') === id) {
        const cloud = config.getPath('voice.provider') === 'dashscope'
        config.update({ voice: cloud
          ? { name: 'Cherry', dashscopeModel: 'qwen3-tts-flash' }
          : { name: DEFAULT_VOICE.id, provider: 'edge' } })
      }
      audit.record({ source: 'panel', tool: 'voice.remove', summary: id })
      sendJson(res, 200, { ok: true, ...removed, custom: voices.list() })
    }),
  }
}
