import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../src/core/chat.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { EventHub, VOICE_RECONNECT_MAX_AGE_MS } from '../src/host/events.mjs'
import { createDaemon } from '../src/host/daemon.mjs'
import { wireChatEvents } from '../src/host/chat-events.mjs'
import { fetchLoopback } from '../src/shared/loopback-http.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

async function fixture(fn) {
  const paths = tempPaths(), config = new ConfigStore(paths), sessions = new SessionStore(paths)
  config.update({ voice: { enabled: true, provider: 'qwen-local', name: 'unchanged-test-clone' } })
  const memory = new MemoryStore(paths, config), calls = [], hub = new EventHub()
  const llm = { pick: () => ({ chat: async args => {
    calls.push({ user: args.user, history: args.history, system: args.system })
    if (args.user === '等待取消测试') return new Promise((resolve, reject) => {
      if (args.signal.aborted) return reject(args.signal.reason)
      args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true })
    })
    return { text: '【soft】わかった。\n【soft】知道了。' }
  } }) }
  const chat = new ChatEngine({ sessions, memory, config, llm, audit: null })
  wireChatEvents({ chat, hub, config, memory })
  const daemon = createDaemon({ paths, config, sessions, memory, chat, hub,
    secrets: new SecretStore(paths), audit: new AuditLog(paths), diag: async () => ({ ok: true }),
    tts: { stats: () => ({}), providerId: () => 'qwen-local' }, assets: null })
  try {
    const info = await daemon.start()
    const post = async (body, { client = 'native-alpha', suffix = '' } = {}) => {
      const res = await fetchLoopback(`http://127.0.0.1:${info.port}/amadeus/chat${suffix}`, {
        method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'X-Amadeus-Client': client },
        body: JSON.stringify(body),
      })
      return { status: res.status, ...await res.json() }
    }
    const finish = async reply => {
      const queued = chat.sessionQueues.get(reply.sessionId)
      if (queued) await queued
      assert.equal(chat.getTurn(reply.turnId).status, 'done')
      return chat.getTurn(reply.turnId)
    }
    await fn({ paths, config, sessions, chat, hub, post, finish, calls, info })
  } finally { await daemon.stop(); cleanup(paths) }
}

test('voice carries prior turns while ordinary one-shot chat stays isolated', async () => fixture(async f => {
  const before = JSON.stringify(f.config.get())
  const first = await f.post({ mode: 'voice', text: '我们讨论电池。', voiceRequestId: 'request-one' })
  assert.equal(first.status, 200)
  assert.equal(first.mode, 'voice')
  assert.equal(first.voiceRequestId, 'request-one')
  const firstTurn = await f.finish(first)
  assert.equal(firstTurn.closed, false)
  assert.ok(firstTurn.speechIds.length)
  const second = await f.post({ mode: 'voice', sessionId: first.sessionId, text: '刚才的话题是什么？', voiceRequestId: 'request-two' })
  await f.finish(second)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(f.calls[0].history.length, 0)
  assert.equal(f.calls[1].history.length, 2)
  assert.equal(f.calls[1].history[0].zh, '我们讨论电池。')
  assert.match(f.calls[1].system, /连续语音对话/)
  const normal = await f.post({ text: '普通文字消息。' })
  const normalTurn = await f.finish(normal)
  assert.notEqual(normal.sessionId, first.sessionId)
  assert.equal(normalTurn.closed, true)
  assert.equal(f.calls[2].history.length, 0)
  assert.equal(JSON.stringify(f.config.get()), before, 'voice mode cannot toggle one-shot, memory or speaker settings')
}))

test('voice session ownership is checked for continuation, termination and text requests', async () => fixture(async f => {
  const first = await f.post({ mode: 'voice', text: '第一句。' })
  await f.finish(first)
  assert.equal((await f.post({ mode: 'voice', sessionId: first.sessionId, text: '串入。' }, { client: 'native-beta' })).status, 403)
  assert.equal((await f.post({ sessionId: first.sessionId, text: '转成文字模式串入。' })).status, 403)
  assert.equal((await f.post({ voiceSessionId: first.sessionId }, { client: 'native-beta', suffix: '/cancel' })).status, 403)
  const normal = f.sessions.create()
  assert.equal((await f.post({ mode: 'voice', sessionId: normal.id, text: '误用旧会话。' })).status, 409)
  assert.equal((await f.post({ mode: 'voice', text: '缺少客户端。' }, { client: '' })).status, 400)
}))

test('ending voice keeps history, clears only its pending audio and prevents reuse', async () => fixture(async f => {
  const reply = await f.post({ mode: 'voice', text: '保留聊天。' })
  await f.finish(reply)
  f.hub.enqueueUtterance({ text: 'unrelated task announcement', kind: 'broadcast' })
  const ended = await f.post({ voiceSessionId: reply.sessionId }, { suffix: '/cancel' })
  assert.equal(ended.status, 200)
  assert.equal(ended.closed, true)
  const session = f.sessions.get(reply.sessionId)
  assert.ok(session.endedAt)
  assert.equal(session.messages.length, 2)
  assert.ok(f.hub.utterances.every(item => item.payload.sessionId !== session.id))
  assert.ok(f.hub.utterances.some(item => item.payload.kind === 'broadcast'))
  assert.equal((await f.post({ mode: 'voice', sessionId: session.id, text: '不应续接。' })).status, 409)
  const next = await f.post({ mode: 'voice', text: '重新开聊。' })
  await f.finish(next)
  assert.notEqual(next.sessionId, session.id)
  assert.equal(f.calls.at(-1).history.length, 0)
}))

function client() {
  const chunks = []
  return { chunks, res: { write: data => { chunks.push(data); return true }, end() {} } }
}

test('addressed voice cannot be replayed to a different audio owner or reconnecting client', () => {
  const hub = new EventHub(), alpha = client(), beta = client(), gamma = client()
  hub.addClient(alpha.res, 'native-alpha')
  hub.addClient(beta.res, 'native-beta')
  hub.claimAudio('native-beta')
  const items = hub.enqueueUtterances([{ text: 'private voice reply', targetClient: 'native-alpha',
    sessionId: 'voice-session', replyTo: 'turn-one', voiceRequestId: 'request-one' }])
  assert.equal(items.length, 1)
  assert.ok(alpha.chunks.join('').includes('private voice reply'))
  assert.ok(!beta.chunks.join('').includes('private voice reply'))
  hub.addClient(gamma.res, 'native-gamma')
  hub.claimAudio('native-gamma')
  assert.ok(!gamma.chunks.join('').includes('private voice reply'))
  const reconnect = client()
  hub.addClient(reconnect.res, 'native-alpha')
  assert.ok(reconnect.chunks.join('').includes('private voice reply'))
  assert.equal(items[0].voiceRequestId, 'request-one')
})

test('ordinary session discovery never resumes an abandoned voice call', () => {
  const paths = tempPaths()
  try {
    const sessions = new SessionStore(paths)
    const voice = sessions.create({ mode: 'voice', owner: 'native-alpha' })
    assert.notEqual(sessions.ensureAny().id, voice.id)
    assert.equal(sessions.list().find(item => item.id === voice.id).mode, 'voice')
  } finally { cleanup(paths) }
})

test('ending a voice call aborts an in-flight model turn without queuing its audio', async () => fixture(async f => {
  const reply = await f.post({ mode: 'voice', text: '等待取消测试' })
  const pending = f.chat.sessionQueues.get(reply.sessionId)
  const ended = await f.post({ voiceSessionId: reply.sessionId }, { suffix: '/cancel' })
  assert.equal(ended.closed, true)
  await pending
  assert.equal(f.chat.getTurn(reply.turnId).status, 'error')
  assert.ok(f.sessions.get(reply.sessionId).endedAt)
  assert.equal(f.chat.isSessionBusy(reply.sessionId), false)
  assert.equal(f.hub.utterances.length, 0)
}))

test('orphaned voice audio expires without replaying or disrupting another client', () => {
  const hub = new EventHub(), other = client()
  hub.addClient(other.res, 'native-other')
  const item = hub.enqueueUtterances([{ text: 'orphaned voice', targetClient: 'native-gone', sessionId: 'abandoned' }])[0]
  hub.sweep(item.ts + VOICE_RECONNECT_MAX_AGE_MS + 1)
  assert.equal(hub.utterances.length, 0)
  assert.ok(!other.chunks.join('').includes('voice client disconnected'))
})
