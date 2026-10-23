import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine, candidateSupportedByUser, mayContainLongTermFact } from '../src/core/chat.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * "Long-term memory does not remember the last conversation."
 *
 * It was a real bug, not a missing feature: extraction only ran when
 * `assistantCount % 6 === 0`, and one-shot mode closes the session after every
 * exchange - so the counter was always 1 and the memory directory stayed empty
 * forever. These tests pin the one-shot path.
 */

function harness() {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  const sessions = new SessionStore(paths)
  const memory = new MemoryStore(paths, config)
  const calls = []
  const llm = {
    pick: () => ({
      chat: async ({ system, user, timeoutMs }) => {
        calls.push({ system: String(system || ''), user: String(user || ''), timeoutMs })
        if (/提取值得长期记住/.test(String(system || ''))) return { text: '- [事实] 用户是医生。' }
        return { text: `【neutral】知道了。\n【neutral】${user}` }
      },
    }),
  }
  const chat = new ChatEngine({ sessions, memory, llm, config, audit: null })
  return { paths, config, sessions, memory, chat, calls }
}

const turnDone = (chat) => new Promise((resolve) => chat.once('turn:done', resolve))

async function runTurn(chat, sessions, text) {
  const session = sessions.ensureAny()
  const done = turnDone(chat)
  chat.startTurn({ sessionId: session.id, userText: text })
  await done
  // The reply is visible before maintenance; wait for it before removing the fixture.
  await chat.sessionQueues.get(session.id)
}

test('one-shot conversations do extract long-term facts when memory is on', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: true } })
    await runTurn(chat, sessions, '其实我是医生。')

    const entries = memory.list('panel', { limit: 20 })
    const facts = entries.filter((entry) => entry.source === 'auto-extract')
    assert.equal(facts.length, 1, JSON.stringify(entries))
    assert.match(facts[0].content, /医生/)
    assert.ok(
      calls.some((call) => /提取值得长期记住/.test(call.system)),
      'the extraction prompt has to actually run',
    )
  } finally {
    cleanup(paths)
  }
})

test('a casual question does not launch a second Codex call for memory extraction', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: true } })
    await runTurn(chat, sessions, '你最近在做什么实验')
    assert.equal(calls.length, 1)
    assert.equal(memory.list('panel', { limit: 20 }).filter((x) => x.source === 'auto-extract').length, 0)
  } finally {
    cleanup(paths)
  }
})

test('the last exchange is remembered as a recap, so she can pick it up next time', async () => {
  const { paths, config, sessions, memory, chat } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: false } })
    await runTurn(chat, sessions, '上周我去看了演唱会。')

    const recaps = memory.list('panel', { limit: 20 }).filter((entry) => entry.source === 'conversation')
    assert.equal(recaps.length, 1, JSON.stringify(memory.list('panel', { limit: 20 })))
    assert.match(recaps[0].content, /上周我去看了演唱会/)
    assert.match(recaps[0].content, /上次聊天/)
  } finally {
    cleanup(paths)
  }
})

test('recaps stay bounded: only the last few are kept', async () => {
  const { paths, config, sessions, memory, chat } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: false } })
    for (let i = 0; i < 6; i += 1) await runTurn(chat, sessions, `第${i}件事`)
    const recaps = memory.list('panel', { limit: 50 }).filter((entry) => entry.source === 'conversation')
    assert.equal(recaps.length, 3)
    assert.equal(recaps[0].type, 'recap')
    assert.match(recaps[0].content, /第5件事/)
    assert.match(recaps[2].content, /第3件事/)
  } finally {
    cleanup(paths)
  }
})

test('a question about Amadeus does not become a fact about the user', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: true } })
    await runTurn(chat, sessions, '你喜欢猫吗？')
    assert.equal(calls.length, 1)
    assert.equal(memory.list('panel', { types: ['fact'] }).length, 0)
    assert.equal(mayContainLongTermFact('你喜欢猫吗？'), false)
  } finally {
    cleanup(paths)
  }
})

test('unsupported model extraction is rejected before writing memory', async () => {
  const { paths, config, sessions, memory, chat } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: true } })
    await runTurn(chat, sessions, '其实我是工程师。')
    assert.equal(memory.list('panel', { types: ['fact'] }).length, 0,
      'the canned model says doctor, which the user never said')
    assert.equal(candidateSupportedByUser('用户是法国医生', '用户: 其实我是医生'), false)
    assert.equal(candidateSupportedByUser('用户是医生', '用户: 其实我是医生'), true)
  } finally {
    cleanup(paths)
  }
})

test('unrelated recent facts do not leak into each new prompt', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: false } })
    memory.add('panel', { content: '用户喜欢芒果' })
    await runTurn(chat, sessions, '今天的天气怎么样？')
    assert.doesNotMatch(calls[0].system, /用户喜欢芒果/)
  } finally {
    cleanup(paths)
  }
})

test('legacy recaps are labelled as conversation context, not durable facts', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: false } })
    memory.add('panel', { content: '上次聊天：用户说「实验很难」', source: 'conversation', type: 'fact' })
    await runTurn(chat, sessions, '还记得上次聊天吗？')
    assert.match(calls[0].system, /最近一次对话提要/)
    assert.doesNotMatch(calls[0].system, /【关于用户的长期记忆[^]*实验很难/)
  } finally {
    cleanup(paths)
  }
})

test('memory stays empty while the switch is off', async () => {
  const { paths, sessions, memory, chat } = harness()
  try {
    await runTurn(chat, sessions, '这句话不该被记住。')
    assert.equal(memory.list('panel', { limit: 10 }).length, 0)
  } finally {
    cleanup(paths)
  }
})

test('an enabled memory shows up in the next session prompt', async () => {
  const { paths, config, sessions, memory, chat, calls } = harness()
  try {
    config.update({ memory: { enabled: true, autoExtract: true } })
    await runTurn(chat, sessions, '我的猫叫小白。')

    // a new session (exactly what a restart produces)
    const next = sessions.ensureAny()
    const done = turnDone(chat)
    chat.startTurn({ sessionId: next.id, userText: '你还记得我的猫吗？' })
    await done
    await chat.sessionQueues.get(next.id)

    const entries = memory.list('panel', { limit: 20 })
    assert.ok(entries.length >= 1, 'facts and recap are on disk for the next session')
    const conversationCalls = calls.filter((call) => !/提取值得长期记住/.test(call.system))
    const prompt = conversationCalls[conversationCalls.length - 1].system
    assert.ok(prompt.includes('小白'), 'the remembered line has to reach the next prompt')
  } finally {
    cleanup(paths)
  }
})
