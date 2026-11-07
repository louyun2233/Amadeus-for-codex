import { EMOTION_EXPR } from '../core/emotion.mjs'
import { splitLocalSpeech } from '../core/parse.mjs'
import { redactText } from '../core/redact.mjs'

/** Connect a conversation engine to the panel event stream. */
export function wireChatEvents({ chat, hub, config, memory, log }) {
  const sendToOrigin = (origin, event, payload) => {
    if (origin) {
      hub.sendTo(origin, event, payload)
      return
    }
    hub.broadcast(event, payload)
  }

  chat.on('turn:status', (evt) => {
    sendToOrigin(evt.origin, 'turn:status', { turnId: evt.turnId, phase: evt.phase })
  })
  chat.on('turn:error', (evt) => {
    sendToOrigin(evt.origin, 'turn:error', { ...evt, error: redactText(evt.error) })
    log?.warn?.('[chat] turn failed:', evt.error)
  })
  chat.on('turn:done', (evt) => {
    const voice = evt.mode === 'voice'
    const lines = []
    const local = config.getPath('voice.provider') === 'qwen-local'
    if (config.getPath('voice.enabled') === true) {
      for (const segment of evt.segments || []) {
        for (const text of local ? splitLocalSpeech(segment.text) : [segment.text]) {
          lines.push({ text, emotion: segment.emotion,
            expr: EMOTION_EXPR[segment.emotion] || '', kind: 'say',
            ...(voice ? { targetClient: evt.origin, replyTo: evt.turnId, sessionId: evt.sessionId,
              voiceRequestId: evt.voiceRequestId } : {}) })
        }
      }
    }
    // Voice replies expose their actual queued IDs, including poll recovery.
    // The native mic waits for these clips, not a timer guessed from text length.
    const speech = voice ? hub.enqueueUtterances(lines) : []
    const speechIds = speech.map(item => item.id)
    if (voice) {
      const turn = chat.getTurn?.(evt.turnId)
      if (turn) turn.speechIds = speechIds
    }
    sendToOrigin(evt.origin, 'turn:done', {
      turnId: evt.turnId,
      sessionId: evt.sessionId,
      zh: evt.zh,
      ja: evt.ja,
      emotion: evt.emotion,
      closed: evt.closed,
      ...(voice ? { mode: 'voice', speechIds } : {}),
    })
    if (voice || !lines.length) return
    if (hub.enqueueUtterances) hub.enqueueUtterances(lines)
    else for (const line of lines) hub.enqueueUtterance(line)
  })
  chat.on('message:appended', (evt) => hub.broadcast('session:append', evt))
  chat.on('memory:changed', (evt) => hub.broadcast('memory', { ...evt, ...memory.stats() }))
}
