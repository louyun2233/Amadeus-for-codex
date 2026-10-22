import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { VoiceLibrary, DEFAULT_VOICE } from '../src/core/voices.mjs'
import { EventHub } from '../src/host/events.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

async function withServer(fn) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  const memory = new MemoryStore(paths, config)
  const daemon = createDaemon({
    paths,
    config,
    secrets: new SecretStore(paths),
    sessions: new SessionStore(paths),
    memory,
    audit: new AuditLog(paths),
    chat: { isRunning: () => false },
    tts: { stats: () => ({}), providerId: () => 'edge' },
    voices: new VoiceLibrary(paths),
    hub: new EventHub(),
    diag: async () => ({ ok: true }),
    assets: null,
    proactive: null,
    systemTts: null,
    version: 'test',
  })
  try {
    const info = await daemon.start()
    const base = `http://127.0.0.1:${info.port}`
    const request = async (method, route, body) => {
      const response = await fetch(base + route, {
        method,
        headers: {
          Authorization: `Bearer ${info.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    }
    await fn({ request, config, memory })
  } finally {
    await daemon.stop()
    cleanup(paths)
  }
}

test('memory routes preserve add, provenance, export, forget, clear and delete', async () => {
  await withServer(async ({ request }) => {
    const missing = await request('POST', '/amadeus/memory/forget', {})
    assert.equal(missing.status, 400)

    const first = await request('POST', '/amadeus/memory', { namespace: 'panel', content: '用户喜欢猫' })
    assert.equal(first.status, 200)
    assert.equal(first.body.entry.content, '用户喜欢猫')
    const listed = await request('GET', '/amadeus/memory?namespace=panel')
    assert.equal(listed.body.entries.length, 1)
    assert.ok(listed.body.entries[0].provenance)
    const exported = await request('GET', '/amadeus/memory/export')
    assert.equal(exported.status, 200)
    assert.ok(exported.body.data.namespaces.panel.some((entry) => entry.id === first.body.entry.id))

    const removed = await request('DELETE', `/amadeus/memory?id=${first.body.entry.id}`)
    assert.equal(removed.body.removed, 1)
    await request('POST', '/amadeus/memory', { namespace: 'panel', content: '用户喜欢狗' })
    const forgot = await request('POST', '/amadeus/memory/forget', { query: '喜欢狗' })
    assert.equal(forgot.status, 200)
    await request('POST', '/amadeus/memory', { namespace: 'panel', content: '用户喜欢鸟' })
    const cleared = await request('POST', '/amadeus/memory/clear', { namespace: 'panel' })
    assert.equal(cleared.status, 200)
    assert.equal((await request('GET', '/amadeus/memory?namespace=panel')).body.entries.length, 0)
  })
})

test('voice routes preserve import, selection reset and validation', async () => {
  await withServer(async ({ request, config }) => {
    const initial = await request('GET', '/amadeus/voices')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.default.id, DEFAULT_VOICE.id)
    assert.deepEqual(initial.body.custom, [])

    const invalid = await request('POST', '/amadeus/voices/import', { id: 'bad' })
    assert.equal(invalid.status, 400)
    const voiceId = 'ja-JP-MayuNeural'
    const imported = await request('POST', '/amadeus/voices/import', { id: voiceId, label: '麻友' })
    assert.equal(imported.status, 200)
    assert.equal(imported.body.voice.id, voiceId)
    config.update({ voice: { provider: 'edge', name: voiceId } })
    const removed = await request('POST', '/amadeus/voices/remove', { id: voiceId })
    assert.equal(removed.body.removed, 1)
    assert.equal(config.getPath('voice.name'), DEFAULT_VOICE.id)
    assert.deepEqual((await request('GET', '/amadeus/voices')).body.custom, [])
  })
})

test('an existing cloud clone ID can be imported without uploading its sample', async () => {
  await withServer(async ({ request, config }) => {
    config.update({ voice: { provider: 'dashscope', name: 'qwen_clone_123' } })
    const imported = await request('POST', '/amadeus/voices/import', {
      id: 'qwen_clone_123', label: '红莉栖', provider: 'dashscope',
    })
    assert.equal(imported.status, 200)
    assert.equal(imported.body.voice.provider, 'dashscope')
    const catalog = await request('GET', '/amadeus/voices')
    assert.equal(catalog.body.default.id, DEFAULT_VOICE.id)
    assert.equal(catalog.body.custom[0].id, 'qwen_clone_123')
    assert.equal(catalog.body.aliyunReady, false)
    const removed = await request('POST', '/amadeus/voices/remove', { id: 'qwen_clone_123' })
    assert.equal(removed.body.removed, 1)
    assert.equal(config.getPath('voice.name'), 'Cherry')
    assert.equal(config.getPath('voice.dashscopeModel'), 'qwen3-tts-flash')
  })
})
