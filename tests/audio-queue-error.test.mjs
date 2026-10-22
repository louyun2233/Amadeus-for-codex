import test from 'node:test'
import assert from 'node:assert/strict'
import { synthesisFailureMessage } from '../src/panel/audio-queue.js'

test('speech errors expose an actionable cloud-model failure instead of local HTTP 500', async () => {
  const response = Response.json({
    ok: false,
    error: 'dashscope http 404 {"code":"InvalidParameter","message":"Model not exist."}',
  }, { status: 500 })
  assert.match(await synthesisFailureMessage(response), /阿里云复刻模型不可用.*API Key.*模型权限/)
})

test('speech errors explain a missing key and preserve other provider details', async () => {
  const missing = Response.json({ error: 'no Aliyun (DashScope) key configured' }, { status: 500 })
  assert.match(await synthesisFailureMessage(missing), /未配置阿里云语音密钥/)

  const other = Response.json({ error: 'provider unavailable' }, { status: 502 })
  assert.equal(await synthesisFailureMessage(other), '合成失败（HTTP 502）：provider unavailable')

  const plain = new Response('bad gateway', { status: 502 })
  assert.equal(await synthesisFailureMessage(plain), '合成失败 HTTP 502')
})
