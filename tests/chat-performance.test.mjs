import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import { CodexExecAdapter, CHAT_TIMEOUT_MS, codexExecArgs } from '../src/core/llm.mjs'
import { parseWinInetProxy, codexChildEnv } from '../src/core/codex-proxy.mjs'
import { ChatEngine } from '../src/core/chat.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

test('Windows system proxy is passed only to the child and only when enabled', async () => {
  const enabled = 'ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    127.0.0.1:7897'
  assert.equal(parseWinInetProxy(enabled), 'http://127.0.0.1:7897')
  assert.equal(parseWinInetProxy(enabled.replace('0x1', '0x0')), null)
  assert.equal(parseWinInetProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:9;https=127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(parseWinInetProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ user:pass@host:8000'), null)
  const existing = { HTTPS_PROXY: 'http://already-set:8080' }
  assert.equal(await codexChildEnv({ env: existing, platform: 'win32' }), existing)
})

test('companion Codex calls override reasoning for one run without changing the model', () => {
  const args = codexExecArgs({ cwd: 'neutral', outFile: 'reply.txt' })
  assert.deepEqual(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2), [
    '--config', 'model_reasoning_effort="low"',
  ])
  assert.equal(args.includes('-m'), false)
  assert.deepEqual(codexExecArgs({ cwd: 'neutral', outFile: 'reply.txt', model: 'custom' }).slice(-3), [
    '-m', 'custom', '-',
  ])
  assert.equal(CHAT_TIMEOUT_MS, 60000)
  const panel = fs.readFileSync(new URL('../src/panel/main.js', import.meta.url), 'utf8')
  const panelTimeout = Number(panel.match(/const TURN_TIMEOUT_MS = (\d+)/)?.[1])
  assert.ok(panelTimeout > CHAT_TIMEOUT_MS, 'the panel must wait for the backend error event')
  assert.ok(panelTimeout <= CHAT_TIMEOUT_MS + 30000, 'the panel must still have a bounded wait')
})

test('Codex stages describe transport progress without exposing reasoning events', async () => {
  const paths = tempPaths()
  const stages = []
  const deltas = []
  let argv
  try {
    const adapter = new CodexExecAdapter({
      paths,
      getConfig: () => ({ chat: { model: '' } }),
      resolveExecutable: async () => 'codex-test',
      childEnv: async () => ({}),
      spawnProcess: (_cmd, args) => {
        argv = args
        const child = fakeChild()
        setImmediate(() => {
          child.stdout.write('{"type":"thread.started"}\n')
          child.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":"private"}}\n')
          child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"回答"}}\n')
          child.emit('close', 0)
        })
        return child
      },
    })
    const result = await adapter.chat({ system: 'role', user: 'hello', onStatus: (x) => stages.push(x), onDelta: (x) => deltas.push(x) })
    assert.equal(result.text, '回答')
    assert.deepEqual(stages, ['connecting', 'generating', 'reply'])
    assert.deepEqual(deltas, ['回答'])
    assert.ok(argv.includes('model_reasoning_effort="low"'))
  } finally {
    cleanup(paths)
  }
})

test('a silent Codex child fails within its own deadline', async () => {
  const paths = tempPaths()
  try {
    const adapter = new CodexExecAdapter({
      paths,
      getConfig: () => ({ chat: {} }),
      resolveExecutable: async () => 'codex-test',
      childEnv: async () => ({}),
      spawnProcess: () => fakeChild(),
    })
    await assert.rejects(
      adapter.chat({ system: 'role', user: 'hello', timeoutMs: 20 }),
      (error) => error.degrade === 'chat-timeout',
    )
  } finally {
    cleanup(paths)
  }
})

test('a timed-out sampling retry is reported as upstream connectivity, not thinking', async () => {
  const paths = tempPaths()
  const stages = []
  try {
    const adapter = new CodexExecAdapter({
      paths,
      getConfig: () => ({ chat: {} }),
      resolveExecutable: async () => 'codex-test',
      childEnv: async () => ({}),
      spawnProcess: () => {
        const child = fakeChild()
        setImmediate(() => child.stderr.write('WARN codex_core::responses_retry: sampling_error=request timed out'))
        return child
      },
    })
    await assert.rejects(
      adapter.chat({ system: 'role', user: 'hello', timeoutMs: 30, onStatus: (stage) => stages.push(stage) }),
      (error) => error.degrade === 'chat-upstream-timeout',
    )
    assert.deepEqual(stages, ['connecting', 'retrying'])
  } finally {
    cleanup(paths)
  }
})

test('failed turns record timing and reason, never prompt or model reasoning', async () => {
  const paths = tempPaths()
  const auditRows = []
  try {
    const config = new ConfigStore(paths)
    const sessions = new SessionStore(paths)
    const memory = new MemoryStore(paths, config)
    const chat = new ChatEngine({
      sessions, memory, config,
      audit: { record: (row) => auditRows.push(row) },
      llm: { pick: () => ({ chat: async ({ onStatus }) => {
        onStatus('connecting')
        throw Object.assign(new Error('private prompt failed'), { degrade: 'chat-timeout' })
      } }) },
    })
    const session = sessions.create()
    const failed = new Promise((resolve) => chat.once('turn:error', resolve))
    const id = chat.startTurn({ sessionId: session.id, userText: 'my private question' })
    await failed
    assert.equal(chat.getTurn(id).phase, 'error')
    assert.ok(chat.getTurn(id).durationMs >= 0)
    assert.deepEqual(auditRows.map((row) => row.tool), ['turn.start', 'turn.stage', 'turn.error'])
    assert.equal(auditRows.some((row) => /private question|private prompt/.test(row.summary)), false)
  } finally {
    cleanup(paths)
  }
})
