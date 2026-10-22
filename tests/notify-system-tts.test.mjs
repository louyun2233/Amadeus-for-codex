import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { EventHub } from '../src/host/events.mjs'
import { tempPaths, cleanup } from './helpers.mjs'
import { TASK_LINES } from '../src/core/task-lines.mjs'

/**
 * The broadcast decision, at the route level: which channel gets the line.
 *
 * The panel queue is always filled first, so a missing system voice cannot
 * turn "task finished" into silence. When the system voice really did speak,
 * the queued item is acknowledged away, otherwise opening the panel an hour
 * later would say the same sentence a second time.
 */

function build({ systemTtsEnabled = true, available = true, provider = 'edge' } = {}) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  config.update({
    voice: { enabled: true, provider },
    broadcast: { enabled: true, onTaskComplete: true, systemTts: systemTtsEnabled },
  })
  const hub = new EventHub()
  const spoken = []
  const systemTts = {
    available: () => available,
    speak(text) {
      spoken.push(text)
      return Promise.resolve(available ? { ok: true, backend: 'test' } : { ok: false, degrade: 'no-system-voice' })
    },
    describe: () => ({ available, backend: available ? 'test' : null, reason: available ? '' : 'none' }),
    shutdown: () => {},
  }
  const daemon = createDaemon({
    paths,
    config,
    secrets: new SecretStore(paths),
    sessions: new SessionStore(paths),
    memory: new MemoryStore(paths, config),
    audit: new AuditLog(paths),
    chat: { isRunning: () => false },
    tts: { stats: () => ({}), providerId: () => 'edge' },
    hub,
    diag: async () => ({ ok: true }),
    assets: null,
    proactive: null,
    systemTts,
    version: 'test',
  })
  return { paths, config, daemon, hub, spoken }
}

function notify(info, body) {
  return fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function withDaemon(options, fn) {
  const ctx = build(options)
  const info = await ctx.daemon.start()
  try {
    await fn({ ...ctx, info })
  } finally {
    await ctx.daemon.stop()
    cleanup(ctx.paths)
  }
}

test('a finished task is spoken out loud when nobody is watching the panel', async () => {
  await withDaemon({}, async ({ info, spoken, hub }) => {
    const res = await notify(info, { kind: 'task-complete' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.broadcasted, true)
    assert.equal(body.systemTts, 'speaking')

    await new Promise((r) => setImmediate(r))
    assert.equal(spoken.length, 1)
    assert.ok(TASK_LINES.complete.some((line) => line.cn === spoken[0]))
    assert.equal(
      hub.status().pendingUtterances,
      0,
      'a line that was already spoken must not wait in the panel queue',
    )
  })
})

test('an open panel keeps the system voice out of the way', async () => {
  await withDaemon({}, async ({ info, spoken, hub }) => {
    hub.addClient({ write: () => true, end: () => {} }, 'tab-test')
    const body = await (await notify(info, { kind: 'task-complete' })).json()
    assert.equal(body.systemTts, 'panel-open')
    assert.deepEqual(spoken, [])
    assert.equal(hub.status().pendingUtterances, 1, 'the panel channel still gets the line')
  })
})

test('a platform without a system voice still delivers through the panel', async () => {
  await withDaemon({ available: false }, async ({ info, spoken, hub }) => {
    const body = await (await notify(info, { kind: 'task-failed' })).json()
    assert.equal(body.systemTts, 'no-system-voice')
    assert.deepEqual(spoken, [])
    assert.equal(hub.status().pendingUtterances, 1)
  })
})

test('a cloned voice never falls back to the Windows system voice', async () => {
  await withDaemon({ provider: 'qwen-local' }, async ({ info, spoken, hub }) => {
    const body = await (await notify(info, { kind: 'task-complete' })).json()
    assert.equal(body.systemTts, 'clone-panel-only')
    assert.deepEqual(spoken, [])
    assert.equal(hub.status().pendingUtterances, 1)
  })
})

test('the system channel is untouched while it is switched off', async () => {
  await withDaemon({ systemTtsEnabled: false }, async ({ info, spoken, hub }) => {
    const body = await (await notify(info, { kind: 'task-complete' })).json()
    assert.equal(body.systemTts, null)
    assert.deepEqual(spoken, [])
    assert.equal(hub.status().pendingUtterances, 1)
  })
})

test('an event kind that is switched off broadcasts nothing at all', async () => {
  await withDaemon({}, async ({ info, spoken, hub }) => {
    const body = await (await notify(info, { kind: 'turn-end' })).json()
    assert.equal(body.broadcasted, false)
    assert.equal(body.systemTts, null)
    assert.deepEqual(spoken, [])
    assert.equal(hub.status().pendingUtterances, 0)
  })
})
