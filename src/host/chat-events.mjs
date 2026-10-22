import { EMOTION_EXPR } from '../core/emotion.mjs'

/** Connect a conversation engine to the panel event stream. */
export function wireChatEvents({ chat, hub, config, memory, log }) {
  const sendToOrigin = (origin, event, payload) => {
    if (origin && hub.sendTo(origin, event, payload)) return
    hub.broadcast(event, payload)
  }

  chat.on('turn:delta', (evt) => {
    sendToOrigin(evt.origin, 'chunk', { turnId: evt.turnId, delta: evt.delta })
  })
  chat.on('turn:status', (evt) => {
    sendToOrigin(evt.origin, 'turn:status', { turnId: evt.turnId, phase: evt.phase })
  })
  chat.on('turn:error', (evt) => {
    sendToOrigin(evt.origin, 'turn:error', evt)
    log?.warn?.('[chat] turn failed:', evt.error)
  })
  chat.on('turn:done', (evt) => {
    sendToOrigin(evt.origin, 'turn:done', {
      turnId: evt.turnId,
      sessionId: evt.sessionId,
      zh: evt.zh,
      ja: evt.ja,
      emotion: evt.emotion,
      closed: evt.closed,
    })
    if (config.getPath('voice.enabled') !== true) return
    for (const segment of evt.segments || []) {
      hub.enqueueUtterance({
        text: segment.text,
        emotion: segment.emotion,
        expr: EMOTION_EXPR[segment.emotion] || '',
        kind: 'say',
      })
    }
  })
  chat.on('message:appended', (evt) => hub.broadcast('session:append', evt))
  chat.on('memory:changed', (evt) => hub.broadcast('memory', { ...evt, ...memory.stats() }))
}
