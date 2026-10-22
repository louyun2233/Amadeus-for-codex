import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDaemon } from '../src/host/daemon.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { EventHub } from '../src/host/events.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Two announcement paths exist now: the notify hook (CLI turns) and the rollout
 * watcher (Desktop turns). They share one turn-id ledger, so a `codex exec` run
 * that is visible to both is only spoken once.
 */

function build({ hasActiveTask = false } = {}) {
  const paths = tempPaths()
  const config = new ConfigStore(paths)
  config.update({ voice: { enabled: true }, broadcast: { enabled: true, onTaskStart: true, onTaskComplete: true, onTaskFailed: true } })
  const hub = new EventHub()
  const ledger = new Map()
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
    systemTts: null,
    onTaskAnnounced: ({ turnId, kind }) => {
      if (turnId) ledger.set(`${turnId}:${kind}`, Date.now())
    },
    isTurnAnnounced: ({ turnId, kind }) => ledger.has(`${turnId}:${kind}`),
    hasActiveTask: () => hasActiveTask,
    version: 'test',
  })
  return { paths, daemon, hub, ledger }
}

async function withDaemon(options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }
  const ctx = build(options)
  const info = await ctx.daemon.start()
  const auth = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }
  const notify = (body) =>
    fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  try {
    await fn({ ...ctx, info, notify })
  } finally {
    await ctx.daemon.stop()
    cleanup(ctx.paths)
  }
}

test('a turn is announced once, whichever path saw it first', async () => {
  await withDaemon(async ({ notify, hub, ledger, paths }) => {
    const first = await (await notify({ kind: 'task-complete', type: 'agent-turn-complete', turnId: 'turn-1' })).json()
    assert.equal(first.broadcasted, true)
    assert.equal(hub.status().pendingUtterances, 1)
    assert.equal(ledger.has('turn-1:complete'), true, 'the watcher must be able to see it was already said')
    const audit = fs.readFileSync(paths.auditFile, 'utf8')
    assert.ok(audit.includes('notify.complete'), 'the announcement is recorded in the audit trail')

    const second = await (await notify({ kind: 'task-complete', type: 'agent-turn-complete', turnId: 'turn-1' })).json()
    assert.equal(second.broadcasted, false)
    assert.equal(second.reason, 'already-announced')
    assert.equal(hub.status().pendingUtterances, 1, 'no second line was queued')
  })
})

test('a different turn is announced normally', async () => {
  await withDaemon(async ({ notify, hub }) => {
    await notify({ kind: 'task-complete', turnId: 'turn-a' })
    await notify({ kind: 'task-complete', turnId: 'turn-b' })
    assert.equal(hub.status().pendingUtterances, 2)
  })
})

test('an announcement for one boundary does not silence the other', async () => {
  await withDaemon(async ({ notify, hub, ledger }) => {
    // the watcher announces "start" first, then the hook reports the same turn
    // as complete - both lines are wanted, and each only once
    ledger.set('turn-x:start', Date.now())
    const complete = await (await notify({ kind: 'task-complete', turnId: 'turn-x' })).json()
    assert.equal(complete.broadcasted, true)
    assert.equal(hub.status().pendingUtterances, 1)
  })
})

test('the panel own turn is still never announced', async () => {
  await withDaemon(async ({ notify, hub }) => {
    const body = await (
      await notify({ kind: 'task-complete', origin: 'panel', turnId: 'turn-panel' })
    ).json()
    assert.equal(body.broadcasted, false)
    assert.equal(body.reason, 'panel-origin')
    assert.equal(hub.status().pendingUtterances, 0)
  })
})

/**
 * While the agent works it spawns `codex exec` helpers, and each of those ends
 * with its own turn-complete. Announcing it made "目标达成" appear in the middle
 * of the task the user was watching.
 */
test('a helper exec that finishes mid-task is not announced', async () => {
  await withDaemon({ hasActiveTask: true }, async ({ notify, hub }) => {
    const body = await (await notify({ kind: 'task-complete', turnId: 'helper-1' })).json()
    assert.equal(body.broadcasted, false)
    assert.equal(body.reason, 'nested-turn')
    assert.equal(hub.status().pendingUtterances, 0)
  })
})
