import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { EventHub } from '../src/host/events.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Two things the panel relies on the daemon for:
 *
 *  - the call ring is served from our own data directory, never from a caller
 *    supplied path, so the incoming call has a sound of its own
 *  - a turn the panel itself started is never announced as "task complete",
 *    which used to make her speak the reply and the announcement at once
 */

function build({ proactive = null } = {}) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  config.update({ voice: { enabled: true }, broadcast: { enabled: true, onTaskComplete: true, onTaskFailed: true } })
  const hub = new EventHub()
  const audit = new AuditLog(paths)
  const daemon = createDaemon({
    paths,
    config,
    secrets: new SecretStore(paths),
    sessions: new SessionStore(paths),
    memory: new MemoryStore(paths, config),
    audit,
    chat: { isRunning: () => false },
    tts: { stats: () => ({}), providerId: () => 'edge' },
    hub,
    diag: async () => ({ ok: true }),
    assets: null,
    proactive,
    systemTts: null,
    version: 'test',
  })
  return { paths, daemon, hub, audit, config }
}

async function withDaemon(fn, options) {
  const ctx = build(options)
  const info = await ctx.daemon.start()
  const auth = { Authorization: `Bearer ${info.token}` }
  try {
    await fn({ ...ctx, info, auth })
  } finally {
    await ctx.daemon.stop()
    cleanup(ctx.paths)
  }
}

test('the panel ring is served from our data directory and needs auth', async () => {
  await withDaemon(async ({ paths, info, auth }) => {
    const dir = path.join(paths.dataRoot, 'sounds')
    fs.mkdirSync(dir, { recursive: true })
    const bytes = Buffer.alloc(6000, 9)
    fs.writeFileSync(path.join(dir, 'incoming.wav'), bytes)

    const ok = await fetch(`http://127.0.0.1:${info.port}/amadeus/sound/incoming`, { headers: auth })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'audio/wav')
    assert.equal(ok.headers.get('x-amadeus-ring'), 'user')
    const body = Buffer.from(await ok.arrayBuffer())
    assert.equal(body.length, bytes.length)
    assert.ok(body.equals(bytes))

    const anonymous = await fetch(`http://127.0.0.1:${info.port}/amadeus/sound/incoming`)
    assert.equal(anonymous.status, 401)
  })
})

test('the panel refuses legacy media effects and arbitrary files', async () => {
  await withDaemon(async ({ paths, info, auth }) => {
    const dir = path.join(paths.dataRoot, 'sounds', 'kurisu-media')
    fs.mkdirSync(dir, { recursive: true })
    const bytes = Buffer.alloc(6000, 3)
    fs.writeFileSync(path.join(dir, '默认响声.WAV'), bytes)
    const base = `http://127.0.0.1:${info.port}/amadeus/sound/media`
    const oldEffect = await fetch(`${base}?event=tap_body_0`, { headers: auth })
    assert.equal(oldEffect.status, 404)
    assert.equal((await fetch(`${base}?event=broadcast`, { headers: auth })).status, 404)
    assert.equal((await fetch(`${base}?event=..%2Fconfig.json`, { headers: auth })).status, 404)
    assert.equal((await fetch(`${base}?event=tap_body_0`)).status, 401)
  })
})

test('a platform without a ring sound answers 404 instead of an empty file', async () => {
  if (process.platform === 'win32') {
    // Windows does ship the mail sound, so the route imports it on first use.
    assert.ok(fs.existsSync('C:\\Windows\\Media\\Windows Notify Email.wav'))
    return
  }
  await withDaemon(async ({ info, auth }) => {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/sound/incoming`, { headers: auth })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.ok, false)
  })
})

test('a panel-originated turn is acknowledged but never announced', async () => {
  await withDaemon(async ({ info, auth, hub, paths }) => {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'task-complete', type: 'agent-turn-complete', origin: 'panel' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.broadcasted, false)
    assert.equal(body.reason, 'panel-origin')
    assert.equal(hub.status().pendingUtterances, 0, 'nothing may be queued for a panel turn')

    const audit = fs.readFileSync(paths.auditFile, 'utf8')
    assert.ok(audit.includes('notify.panel-origin'), 'the skip is recorded, not silent')
  })
})

test('a real Codex task is still announced', async () => {
  await withDaemon(async ({ info, auth, hub }) => {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'task-complete', type: 'agent-turn-complete', origin: 'codex' }),
    })
    const body = await res.json()
    assert.equal(body.broadcasted, true)
    assert.equal(hub.status().pendingUtterances, 1)
  })
})

test('task notifications stay silent when voice is disabled', async () => {
  await withDaemon(async ({ info, auth, hub, config }) => {
    config.update({ voice: { enabled: false } })
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'task-complete', origin: 'codex' }),
    })
    assert.equal((await res.json()).broadcasted, false)
    assert.equal(hub.status().pendingUtterances, 0)
  })
})

test('cached native interaction resets idle only after authentication and never queues speech', async () => {
  let interactions = 0
  await withDaemon(async ({ info, auth, hub }) => {
    const client = 'native-cached-reaction'
    const removeClient = hub.addClient({ write() {}, end() {} }, client)
    const url = `http://127.0.0.1:${info.port}/amadeus/client/active`
    try {
      for (const headers of [
        { 'X-Amadeus-Client': client },
        { 'X-Amadeus-Client': client, Authorization: 'Bearer invalid-test-token' },
      ]) {
        const response = await fetch(url, { method: 'POST', headers })
        assert.equal(response.status, 401)
        await response.arrayBuffer()
        assert.equal(interactions, 0, 'unauthenticated requests cannot postpone idle reminders')
        assert.equal(hub.status().pendingUtterances, 0)
      }

      const response = await fetch(url, {
        method: 'POST', headers: { ...auth, 'X-Amadeus-Client': client },
      })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.ok, true)
      assert.equal(result.owner, client)
      assert.equal(interactions, 1, 'native cached playback still counts as user interaction')
      assert.equal(hub.status().pendingUtterances, 0, 'an activity touch must not replay or synthesize a reaction')
    } finally {
      removeClient()
    }
  }, { proactive: { noteInteraction() { interactions += 1 } } })
})
