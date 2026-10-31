import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { wireChatEvents } from '../src/host/chat-events.mjs'
import { EventHub } from '../src/host/events.mjs'
import { parseReply, LOCAL_QWEN_CHUNK_MAX } from '../src/core/parse.mjs'

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

test('a disconnected origin does not leak its reply to other panels', () => {
  const chat = new EventEmitter()
  const hub = {
    sendTo: () => false,
    broadcast: () => assert.fail('private turn must wait for owner recovery instead of broadcasting'),
  }
  wireChatEvents({ chat, hub, config: { getPath: () => false }, memory: { stats: () => ({}) } })
  chat.emit('turn:done', { origin: 'native-offline', turnId: 'turn-private', zh: '只属于这一会话的回复' })
})

test('visual reply emotion reaches the panel when speech is disabled', () => {
  const chat = new EventEmitter()
  const sent = []
  const hub = {
    sendTo: (id, event, payload) => { sent.push(payload); return true },
    broadcast: () => assert.fail('reply should remain private'),
    enqueueUtterance: () => assert.fail('speech is disabled'),
  }
  wireChatEvents({ chat, hub, config: { getPath: () => false }, memory: { stats: () => ({}) } })
  chat.emit('turn:done', { origin: 'native-test', turnId: 't1', zh: '成功了！', emotion: 'happy',
    segments: [{ text: 'やった！', emotion: 'happy' }] })
  assert.equal(sent[0].emotion, 'happy')
})

test('spoken segments retain distinct emotions and matching expression hints', () => {
  const chat = new EventEmitter()
  const spoken = []
  const hub = { sendTo: () => true, broadcast: () => {}, enqueueUtterance: (line) => spoken.push(line) }
  wireChatEvents({ chat, hub, config: { getPath: () => true }, memory: { stats: () => ({}) } })
  chat.emit('turn:done', { origin: 'native-test', turnId: 't1', emotion: 'blush',
    segments: [{ text: '別に。', emotion: 'blush' }, { text: 'もう。', emotion: 'annoyed' }] })
  assert.deepEqual(spoken.map(({ emotion, expr }) => ({ emotion, expr })), [
    { emotion: 'blush', expr: 'f04' }, { emotion: 'annoyed', expr: 'f03' },
  ])
})

test('local long replies queue all short parts in one batch with their original emotion', () => {
  const chat = new EventEmitter(), hub = new EventHub()
  wireChatEvents({ chat, hub, config: { getPath: key => key === 'voice.provider' ? 'qwen-local' : true },
    memory: { stats: () => ({}) } })
  const first = 'まず確認することがあります。'.repeat(40)
  const second = '次に詳しく説明しましょう。'.repeat(40)
  const parsed = parseReply(`JP: 【soft】${first}【thinking】${second}\nCN: 长回复。`)
  chat.emit('turn:done', { turnId: 'long-turn', ...parsed })
  const speech = hub.utterances.map(item => item.payload)
  assert.ok(speech.length > 60)
  assert.equal(speech.map(line => line.text).join(''), first + second)
  assert.ok(speech.every(line => Array.from(line.text).length <= LOCAL_QWEN_CHUNK_MAX))
  assert.ok(speech.slice(0, 40).every(line => line.emotion === 'soft'))
  assert.ok(speech.slice(40).every(line => line.emotion === 'thinking'))
  assert.equal(hub.status().dropped.length, 0)
})

test('local subdivision preserves an overlong semantic segment and its emotion', () => {
  const chat = new EventEmitter(), batches = []
  const hub = { sendTo: () => true, broadcast: () => {}, enqueueUtterances: lines => batches.push(lines) }
  wireChatEvents({ chat, hub, config: { getPath: key => key === 'voice.provider' ? 'qwen-local' : true },
    memory: { stats: () => ({}) } })
  const text = 'あ'.repeat(70) + '、' + 'い'.repeat(90) + '。'
  chat.emit('turn:done', { segments: [{ text, emotion: 'blush' }] })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].map(line => line.text).join(''), text)
  assert.ok(batches[0].every(line => line.emotion === 'blush' && Array.from(line.text).length <= 80))
})
