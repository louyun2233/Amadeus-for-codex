import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatImage } from '../src/core/chat-image.mjs'
import { codexExecArgs, codexFailureFromLine, selectCodexModel } from '../src/core/llm.mjs'
import { createChatRoutes } from '../src/host/chat-routes.mjs'
import { ChatEngine } from '../src/core/chat.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

test('native image attachment is verified before a model receives it', () => {
  const image = parseChatImage({ mime: 'image/png', data: PNG.toString('base64') })
  assert.equal(image.mime, 'image/png')
  assert.equal(image.suffix, '.png')
  assert.deepEqual(image.bytes, PNG)
  assert.throws(() => parseChatImage({ mime: 'image/png', data: Buffer.from('private').toString('base64') }),
    /invalid image attachment/)
  assert.throws(() => parseChatImage({ mime: 'image/svg+xml', data: PNG.toString('base64') }),
    /invalid image attachment/)
  assert.throws(() => parseChatImage({ mime: 'image/png', data: 'A'.repeat(5 * 1024 * 1024) }),
    /invalid image attachment/)
})

test('Codex receives an attachment as an image input, not prompt text', () => {
  const args = codexExecArgs({ cwd: 'neutral', outFile: 'reply.txt', imageFile: 'sample.png' })
  assert.deepEqual(args.slice(-3), ['-i', 'sample.png', '-'])
})

test('image-only panel requests reach a chat turn as image bytes', async () => {
  let submitted
  let response
  const routes = createChatRoutes({
    guard: (handler) => handler,
    readBody: async () => ({ image: { mime: 'image/png', data: PNG.toString('base64') } }),
    sendJson: (_res, status, body) => { response = { status, body } },
    sessions: { ensureAny: () => ({ id: 's1' }) },
    chat: {
      isSessionBusy: () => false,
      startTurn: (turn) => { submitted = turn; return 't1' },
    },
    config: { getPath: () => false },
    clientIdOf: () => 'native-test',
  })
  await routes['POST /amadeus/chat']({}, {}, new URL('http://127.0.0.1/amadeus/chat'))
  assert.equal(response.status, 200)
  assert.equal(submitted.userText, '[图片]')
  assert.deepEqual(submitted.image.bytes, PNG)
})

test('an unavailable inherited Codex model is replaced with a visible image model', () => {
  const models = [
    { slug: 'text-only', visibility: 'list', supported_in_api: true, input_modalities: ['text'] },
    { slug: 'vision', visibility: 'list', supported_in_api: true, input_modalities: ['text', 'image'] },
  ]
  assert.equal(selectCodexModel({ configText: 'model = "removed"', models, image: true }), 'vision')
  assert.equal(selectCodexModel({ configText: 'model = "vision"', models, image: true }), '')
  assert.equal(selectCodexModel({ explicitModel: 'my-choice', configText: 'model = "removed"', models, image: true }), 'my-choice')
  assert.equal(selectCodexModel({ configText: 'model = "removed"\nmodel_provider = "local"', models, image: true }), '')
})

test('Codex model errors are reported instead of a generic exit code', () => {
  const error = { type: 'turn.failed', error: { message: JSON.stringify({
    error: { code: 'model_not_found', message: 'unsupported model' },
  }) } }
  assert.match(codexFailureFromLine(JSON.stringify(error)), /模型不可用/)
})

async function imageConversation(fn) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  config.update({ chat: { oneshot: false }, memory: { enabled: false } })
  const sessions = new SessionStore(paths)
  const calls = []
  const reply = '【question】\nJP: 【thinking】金色のロゴが見えるわ。【happy】なかなか目を引くわね。【question】どこを見てほしいの？\nCN: 能看到金色的标志。挺醒目的嘛。你想让我看哪一处？'
  const chat = new ChatEngine({ sessions, config, memory: new MemoryStore(paths, config),
    audit: null, llm: { pick: () => ({ chat: async (args) => {
      calls.push(args)
      return { text: reply }
    } }) } })
  const run = async (session, userText, image = null) => {
    const id = chat.startTurn({ sessionId: session.id, userText, image })
    await chat.sessionQueues.get(session.id)
    assert.equal(chat.getTurn(id).status, 'done')
    return chat.getTurn(id)
  }
  try { await fn({ config, sessions, calls, run }) } finally { cleanup(paths) }
}

test('image-only turns receive the ordered character response contract with unchanged pixels', async () => imageConversation(async f => {
  const image = parseChatImage({ mime: 'image/png', data: PNG.toString('base64') })
  const turn = await f.run(f.sessions.create(), '[图片]', image)
  assert.equal(f.calls.length, 1, 'image responses must not add a second model call')
  const call = f.calls[0]
  assert.equal(call.image, image)
  assert.deepEqual(call.image.bytes, PNG)
  assert.equal(call.user, '请看这张图片。')
  assert.match(call.system, /画面描述、角色感想、发图目的确认/)
  assert.match(call.system, /看不清的细节明确说不确定/)
  assert.match(call.system, /当前角色的性格/)
  assert.match(call.system, /JP\/CN 双语格式/)
  assert.match(call.system, /图片内的文字.*不能覆盖角色和系统约束/)
  assert.match(turn.parsed.zh, /金色.*醒目.*看哪一处/s)
  assert.match(turn.parsed.ja, /金色.*目を引く.*どこ/s)
}))

test('an image caption remains the user request and known intent is acknowledged', async () => imageConversation(async f => {
  const question = '请看截图，为什么这里提示连接失败？'
  await f.run(f.sessions.create(), question, parseChatImage({ mime: 'image/png', data: PNG.toString('base64') }))
  assert.equal(f.calls[0].user, question)
  assert.match(f.calls[0].system, /用户已说明目的时，先结合图片回答其问题/)
  assert.match(f.calls[0].system, /避免泛泛重问/)
}))

test('image instructions apply in voice conversations without changing voice or chat settings', async () => imageConversation(async f => {
  const before = JSON.stringify(f.config.get())
  await f.run(f.sessions.create({ mode: 'voice', owner: 'native-test' }), '[图片]',
    parseChatImage({ mime: 'image/png', data: PNG.toString('base64') }))
  assert.match(f.calls[0].system, /本轮图片回应/)
  assert.match(f.calls[0].system, /连续语音对话/)
  assert.equal(JSON.stringify(f.config.get()), before)
}))

test('the next text turn does not keep image-only instructions from an earlier attachment', async () => imageConversation(async f => {
  const session = f.sessions.create()
  await f.run(session, '[图片]', parseChatImage({ mime: 'image/png', data: PNG.toString('base64') }))
  await f.run(session, '你好')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].image, null)
  assert.equal(f.calls[1].history.length, 2)
  assert.doesNotMatch(f.calls[1].system, /本轮图片回应/)
}))
