import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatImage } from '../src/core/chat-image.mjs'
import { codexExecArgs, codexFailureFromLine, selectCodexModel } from '../src/core/llm.mjs'
import { createChatRoutes } from '../src/host/chat-routes.mjs'

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
