import test from 'node:test'
import assert from 'node:assert/strict'
import { CODEX_IMAGES, detectCodex, imageRunning, watchDecision } from '../src/host/codex-watch.mjs'

/**
 * The connector launch has to work without Codex hooks (the /hooks page of the
 * Codex build in use lists nothing), so a watcher process decides when to bring
 * the panel up. The decision rules are what keep it from being annoying:
 * once per Codex presence, and it also covers "Codex was already running".
 */

test('the watcher looks for the Codex desktop builds and the CLI', () => {
  assert.ok(CODEX_IMAGES.includes('ChatGPT.exe'), 'the store build of Codex Desktop')
  assert.ok(CODEX_IMAGES.includes('Codex.exe'), 'the portable desktop build')
  assert.ok(CODEX_IMAGES.includes('codex.exe'), 'the CLI that ships with them')
})

test('process detection is a cheap name probe and never throws', () => {
  const seen = []
  const spawnSyncImpl = (bin, args) => {
    seen.push({ bin, args })
    return { status: 0, stdout: '"ChatGPT.exe","9180","Console","1","300,000 K"\r\n' }
  }
  assert.equal(imageRunning('ChatGPT.exe', { spawnSyncImpl, platform: 'win32' }), true)
  assert.equal(imageRunning('Codex.exe', { spawnSyncImpl, platform: 'win32' }), false)
  assert.equal(seen[0].bin, 'tasklist')
  assert.deepEqual(seen[0].args, ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH', '/FO', 'CSV'])

  const broken = () => {
    throw new Error('tasklist exploded')
  }
  assert.equal(imageRunning('Codex.exe', { spawnSyncImpl: broken }), false)
  assert.equal(detectCodex({ spawnSyncImpl: broken }), false)
})

test('detection stops at the first running Codex image', () => {
  const asked = []
  const spawnSyncImpl = (bin, args) => {
    asked.push(args[1])
    return { status: 0, stdout: args[1].includes('Codex.exe') ? '"Codex.exe","11628"\r\n' : 'INFO: No tasks\r\n' }
  }
  assert.equal(detectCodex({ spawnSyncImpl, platform: 'win32' }), true)
  assert.deepEqual(asked, ['IMAGENAME eq ChatGPT.exe', 'IMAGENAME eq Codex.exe'])
})

test('the panel is launched once per Codex presence', () => {
  assert.equal(watchDecision({ present: false, panelOpen: false, launched: true }), 'reset')
  assert.equal(watchDecision({ present: true, panelOpen: false, launched: false }), 'launch')
  assert.equal(watchDecision({ present: true, panelOpen: true, launched: false }), 'seen')
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: true }),
    'idle',
    'a closed panel must stay closed until Codex is restarted',
  )
})

test('a dead daemon is revived instead of opening a second window', () => {
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: true, daemonUp: false }),
    'revive',
    'the open window just needs the daemon back',
  )
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: false, daemonUp: false }),
    'launch',
    'nothing has been shown yet, so start everything',
  )
  assert.equal(
    watchDecision({ present: false, panelOpen: false, launched: true, daemonUp: false }),
    'reset',
    'no Codex, no work',
  )
})

test('the full sequence: launch, stay quiet, reset, launch again', () => {
  let launched = false
  const step = (present, panelOpen) => {
    const decision = watchDecision({ present, panelOpen, launched })
    if (decision === 'reset' || decision === 'seen' || decision === 'launch') launched = decision !== 'reset'
    return decision
  }
  assert.equal(step(true, false), 'launch')
  assert.equal(step(true, true), 'seen')
  assert.equal(step(true, false), 'idle')
  assert.equal(step(false, false), 'reset')
  assert.equal(step(true, false), 'launch')
})
