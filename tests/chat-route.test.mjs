import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { ChatEngine } from '../src/core/chat.mjs'
import { EventHub } from '../src/host/events.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

test('concurrent one-shot HTTP requests use distinct sessions and can be cancelled', async () => {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  const sessions = new SessionStore(paths)
  const memory = new MemoryStore(paths, config)
  const llm = {
    pick: () => ({
      chat: ({ signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }),
  }
  const chat = new ChatEngine({ sessions, memory, llm, config, audit: null })
  const daemon = createDaemon({
    paths,
    config,
    secrets: new SecretStore(paths),
    sessions,
    memory,
    audit: new AuditLog(paths),
    chat,
    tts: { stats: () => ({}), providerId: () => 'edge' },
    hub: new EventHub(),
    diag: async () => ({ ok: true }),
    assets: null,
    proactive: null,
    systemTts: null,
    version: 'test',
  })

  try {
    const info = await daemon.start()
    const stale = sessions.create()
    sessions.append(stale.id, { role: 'user', zh: 'previous failed turn' })
    const url = `http://127.0.0.1:${info.port}/amadeus/chat`
    const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }
    const post = async (route, body) => {
      const response = await fetch(url + route, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json()
    }

    const first = await post('', { text: 'first' })
    assert.notEqual(first.sessionId, stale.id, 'one-shot startup must not reuse an old open session')
    const second = await post('', { text: 'second', sessionId: first.sessionId })
    assert.notEqual(second.sessionId, first.sessionId)
    const progressResponse = await fetch(`${url}?turnId=${first.turnId}`, { headers })
    const progress = await progressResponse.json()
    assert.equal(progressResponse.status, 200)
    assert.equal(typeof progress.turn.phase, 'string')
    assert.equal(typeof progress.turn.elapsedMs, 'number')
    assert.equal(progress.turn.firstReplyMs, null)
    assert.equal(chat.isSessionBusy(first.sessionId), true)
    assert.equal(chat.isSessionBusy(second.sessionId), true)

    assert.equal((await post('/cancel', { turnId: first.turnId })).cancelled, true)
    assert.equal((await post('/cancel', { turnId: second.turnId })).cancelled, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(chat.getTurn(first.turnId).status, 'error')
    assert.equal(chat.getTurn(second.turnId).status, 'error')
    assert.ok(sessions.get(first.sessionId).endedAt, 'failed one-shot sessions must close')
    assert.ok(sessions.get(second.sessionId).endedAt, 'cancelled one-shot sessions must close')
    const settled = await (await fetch(`${url}?turnId=${first.turnId}`, { headers })).json()
    assert.equal(settled.turn.closed, true)
    assert.equal(settled.turn.sessionId, first.sessionId)
    assert.equal(settled.turn.result, null)
    assert.equal((await post('/cancel', { turnId: first.turnId })).cancelled, false)
  } finally {
    await daemon.stop()
    cleanup(paths)
  }
})

test('a panel can recover its completed reply after reconnecting but cannot inspect or cancel another panel turn', async () => {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  let cancelled = false
  const turn = {
    id: 'recoverable-turn', origin: 'native-owner', sessionId: 'session-test',
    status: 'done', phase: 'done', closed: true, error: null,
    text: 'raw output that is not part of the API',
    parsed: { zh: '收到。', ja: 'わかった。', emotion: 'neutral', segments: ['private implementation detail'] },
    startedAt: Date.now() - 1000, durationMs: 800, firstDeltaAt: null,
  }
  const daemon = createDaemon({
    paths, config, secrets: new SecretStore(paths), sessions: new SessionStore(paths),
    memory: new MemoryStore(paths, config), audit: new AuditLog(paths),
    chat: { isRunning: () => false, getTurn: (id) => id === turn.id ? turn : null,
      cancelTurn: () => { cancelled = true; return true } },
    tts: { stats: () => ({}), providerId: () => 'edge' }, hub: new EventHub(),
    diag: async () => ({ ok: true }), version: 'test',
  })
  try {
    const info = await daemon.start()
    const url = `http://127.0.0.1:${info.port}/amadeus/chat`
    const headers = { Authorization: `Bearer ${info.token}`, 'x-amadeus-client': 'native-owner' }
    const response = await fetch(`${url}?turnId=${turn.id}`, { headers })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body.turn.result, { zh: '收到。', ja: 'わかった。', emotion: 'neutral' })
    assert.equal(body.turn.sessionId, turn.sessionId)
    assert.equal(body.turn.closed, true)
    assert.equal(body.turn.text, undefined)
    assert.equal(body.turn.result.segments, undefined)
    const other = { ...headers, 'x-amadeus-client': 'native-other' }
    assert.equal((await fetch(`${url}?turnId=${turn.id}`, { headers: other })).status, 403)
    assert.equal((await fetch(`${url}/cancel`, { method: 'POST', headers: {
      ...other, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ turnId: turn.id }) })).status, 403)
    assert.equal(cancelled, false)
  } finally {
    await daemon.stop()
    cleanup(paths)
  }
})
