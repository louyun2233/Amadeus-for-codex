import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { EventHub } from '../src/host/events.mjs'
import { fetchLoopback } from '../src/shared/loopback-http.mjs'
import { CodexExecAdapter, OpenAiCompatAdapter, codexExecArgs } from '../src/core/llm.mjs'
import { log } from '../src/shared/log.mjs'
import { COMPANION_DISABLED_FEATURES, companionToolArgs, companionEnvironment } from '../src/core/codex-safety.mjs'
import { redactText } from '../src/core/redact.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

test('real daemon rejects browser, query/cookie, rebinding and removed routes without mutating data', async () => {
  const paths = tempPaths(), config = new ConfigStore(paths)
  const sessions = new SessionStore(paths), memory = new MemoryStore(paths, config)
  const credential = ['ghp', '_', 'A'.repeat(40)].join('')
  const privatePath = ['C:', '\\Users\\', 'PrivateTester\\file.txt'].join('')
  let synthesized = 0, ticked = 0
  const daemon = createDaemon({ paths, config, sessions, memory,
    secrets: new SecretStore(paths), audit: new AuditLog(paths), chat: { isRunning: () => false },
    hub: new EventHub(), diag: async () => ({ ok: true }),
    proactive: { tick() { ticked++ } }, assets: null,
    tts: { stats: () => ({}), providerId: () => 'qwen-local', synthesize: async (text) => {
      synthesized++
      if (text === 'fail') throw new Error(`${credential} ${privatePath}`)
      return { audio: Buffer.from('synthetic-audio'), mime: 'audio/wav' }
    } },
  })
  try {
    const info = await daemon.start(), base = `http://127.0.0.1:${info.port}`
    const auth = { Authorization: `Bearer ${info.token}` }
    const request = (route, options = {}) => fetchLoopback(base + route, { headers: auth, ...options })
    assert.equal((await request('/amadeus/status')).status, 200)
    assert.equal((await request('/amadeus/status', { headers: {} })).status, 401)
    assert.equal((await request('/amadeus/status', { headers: { Cookie: `amadeus_session=${info.token}` } })).status, 401)
    assert.equal((await request(`/amadeus/status?token=${info.token}`)).status, 401)
    for (const extra of [{ Origin: 'https://untrusted.example' }, { Origin: 'null' },
      { Host: `untrusted.example:${info.port}` }, { 'Sec-Fetch-Site': 'same-origin' }]) {
      assert.equal((await request('/amadeus/memory', { headers: { ...auth, ...extra } })).status, 403)
    }
    const before = JSON.stringify(config.get())
    for (const [method, route] of [['GET', '/amadeus/panel/'], ['GET', '/amadeus/assets/current/config.json'],
      ['GET', '/amadeus/assets/runtime/live2d.min.js'], ['GET', '/amadeus/sound/media?event=broadcast'],
      ['POST', '/amadeus/stt'], ['POST', '/amadeus/proactive/tick'], ['POST', '/amadeus/sessions'],
      ['POST', '/amadeus/voices/import'], ['POST', '/amadeus/voices/remove']]) {
      assert.equal((await request(route, { method })).status, 404, `${method} ${route}`)
    }
    assert.equal(ticked, 0)
    assert.equal(sessions.list().length, 0)
    assert.equal(JSON.stringify(config.get()), before)
    assert.equal((await request('/amadeus/config', { method: 'PATCH', body: '{' })).status, 400)
    const audio = await request('/amadeus/tts?text=hello')
    assert.equal(audio.headers.get('cache-control'), 'no-store')
    assert.equal(audio.headers.get('x-amadeus-words'), null)
    assert.equal(await audio.text(), 'synthetic-audio')
    const failed = await (await request('/amadeus/tts?text=fail')).text()
    assert.ok(!failed.includes(credential) && !failed.includes(privatePath))
    await request('/amadeus/report', { method: 'POST', body: JSON.stringify({ level: 'error', message: credential, detail: privatePath }) })
    const logs = await (await request('/amadeus/logs')).text()
    assert.ok(!logs.includes(credential) && !logs.includes(privatePath))
    assert.equal(synthesized, 2)
  } finally { await daemon.stop(); cleanup(paths) }
})

async function localServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('loopback transport bypasses environment proxies and never forwards bearer on redirect', async () => {
  let proxyHits = 0, sinkHits = 0, observedAuth
  const proxy = await localServer((req, res) => { proxyHits++; res.end() })
  const sink = await localServer((req, res) => { sinkHits++; res.end() })
  const source = await localServer((req, res) => {
    observedAuth = req.headers.authorization
    if (req.url === '/redirect') res.writeHead(302, { Location: sink.url })
    res.end('local')
  })
  const old = Object.fromEntries(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy'].map(k => [k, process.env[k]]))
  try {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY']) process.env[key] = proxy.url
    process.env.NO_PROXY = process.env.no_proxy = ''
    const response = await fetchLoopback(source.url + '/redirect', { headers: { Authorization: 'Bearer synthetic-test' } })
    assert.equal(response.status, 302)
    await response.text()
    assert.equal(observedAuth, 'Bearer synthetic-test')
    assert.equal(proxyHits, 0)
    assert.equal(sinkHits, 0)
    for (const url of ['https://example.com', 'http://example.com', ['http://name:secret', '127.0.0.1'].join('@')]) {
      assert.throws(() => fetchLoopback(url), /local daemon/)
    }
    assert.throws(() => fetchLoopback(source.url, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value
    await Promise.all([source.close(), sink.close(), proxy.close()])
  }
})

test('companion policy disables tools, hooks, notifications and each configured MCP server per call', () => {
  const args = codexExecArgs({ cwd: 'neutral', outFile: 'reply', imageFile: 'chosen-image.png', mcpServers: ['safe_server', 'other-server'] })
  for (const feature of COMPANION_DISABLED_FEATURES) assert.ok(args.some((s, i) => s === '--disable' && args[i + 1] === feature))
  assert.ok(args.includes('web_search="disabled"'))
  assert.ok(args.includes('notify=[]'))
  assert.ok(args.includes('mcp_servers.safe_server.enabled=false'))
  assert.ok(args.includes('mcp_servers.other-server.enabled=false'))
  assert.ok(args.includes('chosen-image.png'))
  assert.throws(() => companionToolArgs(['invalid.name']), /隔离失败/)
  const env = companionEnvironment({ CODEX_HOME: 'auth-home', CODEX_API_KEY: 'provider-key', PATH: 'commands',
    CODEX_THREAD_ID: 'parent-thread', AMADEUS_DAEMON_TOKEN: 'private-token', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'desktop' })
  assert.deepEqual(env, { CODEX_HOME: 'auth-home', CODEX_API_KEY: 'provider-key', PATH: 'commands' })
})

test('a failed capability check never launches a chat process', async () => {
  const paths = tempPaths()
  let spawned = false
  try {
    const adapter = new CodexExecAdapter({ paths, resolveExecutable: async () => 'codex-test', childEnv: async () => ({}),
      discoverMcp: async () => { throw new Error('isolation-unavailable') },
      spawnProcess: () => { spawned = true; return new EventEmitter() },
    })
    await assert.rejects(adapter.chat({ system: '', user: 'hello' }), /isolation-unavailable/)
    assert.equal(spawned, false)
  } finally { cleanup(paths) }
})

test('support logs remove complete provider credentials rather than key prefixes and suffixes', () => {
  for (const value of [['ghp', '_', 'A'.repeat(40)], ['github', '_pat_', 'B'.repeat(45)], ['LTAI', 'C'.repeat(20)],
    ['AKIA', 'D'.repeat(16)], ['AIza', 'E'.repeat(35)], ['xoxb', '-', 'F'.repeat(30)]].map(parts => parts.join(''))) {
    assert.equal(redactText(value), '[credential]')
  }
})

test('a custom API key cannot be sent over external HTTP or forwarded to a redirect target', async () => {
  for (const base of ['http://example.com/v1', ['https://name:secret', 'api.example.com/v1'].join('@'), 'https://api.example.com/v1?key=value']) {
    const adapter = new OpenAiCompatAdapter({ secretStore: { get: name => name === 'chatApiKey' ? 'synthetic-key' : base } })
    await assert.rejects(adapter.chat({ system: '', user: 'hello' }), /HTTPS/)
  }
  let sinkHits = 0
  const sink = await localServer((_req, res) => { sinkHits++; res.end() })
  const source = await localServer((_req, res) => { res.writeHead(302, { Location: sink.url }); res.end() })
  try {
    const adapter = new OpenAiCompatAdapter({ secretStore: { get: name => name === 'chatApiKey' ? 'synthetic-key' : source.url } })
    await assert.rejects(adapter.chat({ system: '', user: 'hello' }))
    assert.equal(sinkHits, 0)
  } finally { await Promise.all([sink.close(), source.close()]) }
})

test('unserializable log input never falls back to its unredacted string representation', () => {
  const value = new Proxy({}, { ownKeys() { throw new Error('cannot inspect') }, get() { return () => 'do-not-print' } })
  const write = process.stderr.write
  let captured = ''
  try {
    process.stderr.write = (chunk) => { captured += String(chunk); return true }
    log.warn(value)
  } finally { process.stderr.write = write }
  assert.ok(captured.includes('[unserializable]'))
  assert.ok(!captured.includes('do-not-print'))
})
