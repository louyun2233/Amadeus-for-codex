/** Session creation and turn lifecycle endpoints for the panel. */
import { parseChatImage } from '../core/chat-image.mjs'
import { redactText } from '../core/redact.mjs'

export function createChatRoutes({ guard, readBody, sendJson, sessions, chat, config, proactive, clientIdOf, hub }) {
  return {
    'GET /amadeus/sessions': guard(async (req, res) => {
      sendJson(res, 200, { ok: true, sessions: sessions.list() })
    }),

    'GET /amadeus/chat': guard(async (req, res, url) => {
      const turnId = url.searchParams.get('turnId')
      const turn = chat.getTurn(turnId)
      if (!turn) return sendJson(res, 404, { ok: false, error: 'unknown turn' })
      if (turn.origin && turn.origin !== clientIdOf(req, url)) {
        return sendJson(res, 403, { ok: false, error: 'turn belongs to another panel' })
      }
      sendJson(res, 200, { ok: true, turn: {
        id: turn.id, status: turn.status, phase: turn.phase, error: turn.error ? redactText(turn.error) : turn.error,
        sessionId: turn.sessionId, closed: turn.closed === true,
        result: turn.status === 'done' && turn.parsed ? {
          zh: turn.parsed.zh, ja: turn.parsed.ja, emotion: turn.parsed.emotion,
          ...(turn.mode === 'voice' ? { mode: 'voice', speechIds: turn.speechIds || [] } : {}),
        } : null,
        elapsedMs: turn.durationMs ?? Date.now() - turn.startedAt,
        firstReplyMs: turn.firstDeltaAt === null ? null : turn.firstDeltaAt - turn.startedAt,
      } })
    }),

    'POST /amadeus/chat': guard(async (req, res, url) => {
      const body = await readBody(req, 6 * 1024 * 1024)
      const text = String(body?.text ?? '').trim()
      const image = parseChatImage(body?.image)
      const voice = body?.mode === 'voice'
      const owner = clientIdOf(req, url)
      if (voice && !owner) return sendJson(res, 400, { ok: false, error: 'voice conversation requires a native client id' })
      if (voice && body.voiceRequestId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(body.voiceRequestId)) {
        return sendJson(res, 400, { ok: false, error: 'invalid voice request id' })
      }
      if (text.length === 0 && !image) return sendJson(res, 400, { ok: false, error: 'missing text or image' })
      // Closed and missing sessions are history; a one-shot turn never resumes them.
      let requested = null
      if (body?.sessionId) {
        try {
          requested = sessions.get(body.sessionId)
        } catch {
          requested = null
        }
      }
      if (requested?.mode === 'voice' && (!voice || requested.owner !== owner)) {
        return sendJson(res, 403, { ok: false, error: 'voice conversation belongs to another client' })
      }
      if (voice && body?.sessionId && (!requested || requested.mode !== 'voice' || requested.endedAt)) {
        return sendJson(res, 409, { ok: false, error: 'voice conversation ended; start a new conversation' })
      }
      const oneshot = config.getPath('chat.oneshot') === true && !voice
      let session = requested && !requested.endedAt ? requested
        : voice ? sessions.create({ mode: 'voice', owner })
          : oneshot ? sessions.create() : sessions.ensureAny()
      if (voice && chat.isSessionBusy(session.id)) return sendJson(res, 409, { ok: false, error: 'voice turn is still running' })
      // Concurrent one-shot tabs must not share a session that is about to close.
      if (oneshot && chat.isSessionBusy(session.id)) {
        session = sessions.create()
      }
      proactive?.noteInteraction({ text })
      const turnId = chat.startTurn({
        sessionId: session.id,
        userText: text || '[图片]',
        image,
        workspace: body?.workspace,
        origin: clientIdOf(req, url),
        requestId: voice ? body.voiceRequestId : null,
      })
      sendJson(res, 200, { ok: true, turnId, sessionId: session.id,
        ...(voice ? { mode: 'voice', voiceRequestId: body.voiceRequestId } : {}) })
    }),

    'POST /amadeus/chat/cancel': guard(async (req, res, url) => {
      const body = await readBody(req)
      if (body?.voiceSessionId) {
        let session
        try { session = sessions.get(body.voiceSessionId) } catch {
          return sendJson(res, 404, { ok: false, error: 'unknown voice conversation' })
        }
        if (session.mode !== 'voice' || session.owner !== clientIdOf(req, url)) {
          return sendJson(res, 403, { ok: false, error: 'voice conversation belongs to another client' })
        }
        const result = chat.endVoiceSession(session.id)
        hub?.discardVoiceSession(session.id)
        return sendJson(res, 200, { ok: true, ...result })
      }
      const turnId = String(body?.turnId || '')
      const turn = chat.getTurn(turnId)
      if (turn?.origin && turn.origin !== clientIdOf(req, url)) {
        return sendJson(res, 403, { ok: false, error: 'turn belongs to another panel' })
      }
      const cancelled = chat.cancelTurn(turnId)
      sendJson(res, 200, { ok: true, cancelled })
    }),
  }
}
