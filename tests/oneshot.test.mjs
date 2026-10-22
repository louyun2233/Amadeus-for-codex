import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../src/core/chat.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * The default character is a stranger: no long-term memory, and one exchange
 * per connection. These tests pin that, because "she suddenly remembers" is
 * exactly the kind of default that is easy to flip back by accident.
 */

function harness() {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  const sessions = new SessionStore(paths)
  const memory = new MemoryStore(paths, config)
  const seen = []
  const llm = {
    pick: () => ({
      chat: async ({ system, history, user }) => {
        seen.push({ system, history: [...history], user })
        return { text: `【neutral】好的。\n【neutral】${user}` }
      },
    }),
  }
  const chat = new ChatEngine({ sessions, memory, llm, config, audit: null })
  return { paths, config, sessions, memory, chat, seen, llm }
}

const turnDone = (chat) => new Promise((resolve) => chat.once('turn:done', resolve))

async function runTurn(chat, sessionId, text) {
  const done = turnDone(chat)
  chat.startTurn({ sessionId, userText: text })
  return done
}

test('the shipped defaults are: no memory, one exchange per connection', () => {
  const { config, paths } = harness()
  try {
    assert.equal(config.getPath('memory.enabled'), false)
    assert.equal(config.getPath('memory.autoExtract'), false)
    assert.equal(config.getPath('chat.oneshot'), true)
    assert.equal(config.getPath('voice.enabled'), false)
    assert.equal(config.getPath('broadcast.enabled'), false)
    assert.equal(config.getPath('panel.onboardingSeen'), false)
    assert.equal(config.getPath('proactive.callEnabled'), false)
    assert.equal(config.getPath('proactive.idleEnabled'), false)
  } finally {
    cleanup(paths)
  }
})

test('a one-shot turn closes the session and carries no history into the next', async () => {
  const { chat, sessions, memory, seen, paths } = harness()
  try {
    const first = sessions.create({ name: 'one' })
    const done = await runTurn(chat, first.id, '第一句')
    assert.equal(done.closed, true, 'the daemon reports the disconnection')
    assert.ok(sessions.get(first.id).endedAt, 'the session is marked as ended')

    const next = sessions.ensureAny()
    assert.notEqual(next.id, first.id, 'the next message starts a fresh session')

    await runTurn(chat, next.id, '第二句')
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[1].history, [], 'the second turn gets no history at all')
    assert.equal(memory.list('panel', { limit: 10 }).length, 0, 'nothing is remembered by default')
  } finally {
    cleanup(paths)
  }
})

test('history is passed only when one-shot mode is switched off', async () => {
  const { chat, config, sessions, seen, paths } = harness()
  try {
    config.update({ chat: { oneshot: false } })
    const s = sessions.create({ name: 'continuous' })
    const first = await runTurn(chat, s.id, '第一句')
    assert.equal(first.closed, false)
    const second = await runTurn(chat, s.id, '第二句')
    assert.equal(second.closed, false)

    assert.equal(seen.length, 2)
    assert.equal(seen[0].history.length, 0)
    assert.ok(seen[1].history.length >= 2, `expected the previous exchange: ${seen[1].history.length}`)
  } finally {
    cleanup(paths)
  }
})

test('memory is recalled only after it is switched on', async () => {
  const { chat, config, memory, sessions, seen, paths } = harness()
  try {
    memory.add('panel', { content: '用户在学 Rust' })
    const off = sessions.create({ name: 'no-memory' })
    await runTurn(chat, off.id, '我在学什么？')
    assert.ok(!seen[0].system.includes('Rust'), 'a disabled memory must not reach the prompt')

    config.update({ memory: { enabled: true } })
    const on = sessions.create({ name: 'with-memory' })
    await runTurn(chat, on.id, '我在学什么？')
    assert.ok(seen[1].system.includes('Rust'), 'once enabled, recall works again')
  } finally {
    cleanup(paths)
  }
})

test('overlapping turns in one continuous session preserve conversation order', async () => {
  const { chat, config, sessions, llm, paths } = harness()
  try {
    config.update({ chat: { oneshot: false } })
    const session = sessions.create()
    let releaseFirst
    const firstWait = new Promise((resolve) => { releaseFirst = resolve })
    const calls = []
    llm.pick = () => ({
      chat: async ({ user, history }) => {
        calls.push({ user, history })
        if (user === '先问') await firstWait
        return { text: `回答${user}` }
      },
    })
    const done = []
    chat.on('turn:done', (event) => done.push(event))
    chat.startTurn({ sessionId: session.id, userText: '先问' })
    chat.startTurn({ sessionId: session.id, userText: '后问' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls.map((call) => call.user), ['先问'])
    releaseFirst()
    while (done.length < 2) await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(sessions.get(session.id).messages.map((message) => message.zh), [
      '先问', '回答先问', '后问', '回答后问',
    ])
    assert.equal(calls[1].history.length, 2)
  } finally {
    cleanup(paths)
  }
})

test('cancelling an active turn emits one cancellation and saves no reply', async () => {
  const { chat, sessions, llm, paths } = harness()
  try {
    llm.pick = () => ({
      chat: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const session = sessions.create()
    const errors = []
    chat.on('turn:error', (event) => errors.push(event))
    const turnId = chat.startTurn({ sessionId: session.id, userText: '取消它' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(chat.cancelTurn(turnId), true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'cancelled')
    assert.equal(chat.getTurn(turnId).status, 'error')
    assert.deepEqual(sessions.get(session.id).messages.map((entry) => entry.role), ['user'])
  } finally {
    cleanup(paths)
  }
})
