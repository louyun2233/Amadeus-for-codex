import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatImage } from '../src/core/chat-image.mjs'
import { codexExecArgs } from '../src/core/llm.mjs'

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
