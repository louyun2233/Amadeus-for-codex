/** Session creation and turn lifecycle endpoints for the panel. */
import { parseChatImage } from '../core/chat-image.mjs'

export function createChatRoutes({ guard, readBody, sendJson, sessions, chat, config, proactive, clientIdOf }) {
  return {
    'GET /amadeus/sessions': guard(async (req, res) => {
      sendJson(res, 200, { ok: true, sessions: sessions.list() })
    }),

    'POST /amadeus/sessions': guard(async (req, res) => {
      const body = await readBody(req)
      const session = sessions.create({ name: body?.name, workspace: body?.workspace })
      sendJson(res, 200, { ok: true, session })
    }),

    'GET /amadeus/chat': guard(async (req, res, url) => {
      const turnId = url.searchParams.get('turnId')
      const turn = chat.getTurn(turnId)
      if (!turn) return sendJson(res, 404, { ok: false, error: 'unknown turn' })
      if (turn.origin && turn.origin !== clientIdOf(req, url)) {
        return sendJson(res, 403, { ok: false, error: 'turn belongs to another panel' })
      }
      sendJson(res, 200, { ok: true, turn: {
        id: turn.id, status: turn.status, phase: turn.phase, error: turn.error,
        sessionId: turn.sessionId, closed: turn.closed === true,
        result: turn.status === 'done' && turn.parsed ? {
          zh: turn.parsed.zh, ja: turn.parsed.ja, emotion: turn.parsed.emotion,
        } : null,
        elapsedMs: turn.durationMs ?? Date.now() - turn.startedAt,
        firstReplyMs: turn.firstDeltaAt === null ? null : turn.firstDeltaAt - turn.startedAt,
      } })
    }),

    'POST /amadeus/chat': guard(async (req, res, url) => {
      const body = await readBody(req, 6 * 1024 * 1024)
      const text = String(body?.text ?? '').trim()
      const image = parseChatImage(body?.image)
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
      const oneshot = config.getPath('chat.oneshot') === true
      let session = requested && !requested.endedAt ? requested
        : oneshot ? sessions.create() : sessions.ensureAny()
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
      })
      sendJson(res, 200, { ok: true, turnId, sessionId: session.id })
    }),

    'POST /amadeus/chat/cancel': guard(async (req, res, url) => {
      const body = await readBody(req)
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
