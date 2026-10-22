import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { wireChatEvents } from '../src/host/chat-events.mjs'

test('completed one-shot turns forward the closed flag to their panel tab', () => {
  const chat = new EventEmitter()
  const sent = []
  const broadcasts = []
  const hub = {
    sendTo: (id, event, payload) => { sent.push({ id, event, payload }); return true },
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    enqueueUtterance: () => {},
  }
  wireChatEvents({
    chat, hub,
    config: { getPath: () => false },
    memory: { stats: () => ({}) },
  })
  chat.emit('turn:done', {
    turnId: 'turn-1', sessionId: 'session-1', origin: 'tab-1',
    zh: '你好', ja: 'こんにちは', emotion: 'neutral', closed: true,
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].event, 'turn:done')
  assert.equal(sent[0].id, 'tab-1')
  assert.equal(sent[0].payload.closed, true)
  assert.deepEqual(broadcasts, [])
})

test('safe progress stages reach only the originating panel tab', () => {
  const chat = new EventEmitter()
  const sent = []
  const hub = {
    sendTo: (id, event, payload) => { sent.push({ id, event, payload }); return true },
    broadcast: () => assert.fail('progress should not be broadcast'),
  }
  wireChatEvents({ chat, hub, config: { getPath: () => false }, memory: { stats: () => ({}) } })
  chat.emit('turn:status', { turnId: 'turn-1', origin: 'tab-1', phase: 'generating' })
  assert.deepEqual(sent, [{
    id: 'tab-1', event: 'turn:status', payload: { turnId: 'turn-1', phase: 'generating' },
  }])
})
