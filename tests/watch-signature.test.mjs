import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexSignature, watchDecision } from '../src/host/codex-watch.mjs'

/**
 * "Once per Codex presence" broke down on update: Codex replaces itself under a
 * new version directory, and if the process never disappears for a full tick
 * the watcher kept its latch - so Amadeus never came back after an update.
 */

function install(root, names) {
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin')
  for (const name of names) fs.mkdirSync(path.join(bin, name), { recursive: true })
  return { LOCALAPPDATA: root, ProgramFiles: path.join(root, 'ProgramFiles') }
}

test('the signature follows the installed Codex build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-sig-'))
  try {
    const env = install(root, ['abc123'])
    const first = codexSignature({ env })
    assert.match(first, /^[0-9a-f]{12}$/)
    assert.equal(codexSignature({ env }), first, 'the same build gives the same signature')

    install(root, ['def456'])
    assert.notEqual(codexSignature({ env }), first, 'a new version directory is a new build')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable installation yields an empty signature instead of throwing', () => {
  const broken = {
    LOCALAPPDATA: 'C:\\nope-does-not-exist',
    ProgramFiles: 'C:\\also-missing',
  }
  assert.equal(codexSignature({ env: broken }), '')
  const throwing = codexSignature({
    env: { LOCALAPPDATA: 'C:\\x', ProgramFiles: 'C:\\y' },
    readdir: () => {
      throw new Error('access denied')
    },
  })
  assert.equal(throwing, '')
})

test('an updated Codex build brings the panel back even though Codex never closed', () => {
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: true, signatureChanged: true }),
    'relaunch',
  )
  assert.equal(
    watchDecision({ present: true, panelOpen: true, launched: true, signatureChanged: true }),
    'seen',
    'an open panel is already the answer; do not open a second window',
  )
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: true, signatureChanged: true, daemonUp: false }),
    'relaunch',
    'a build change outranks the daemon revive path',
  )
})

test('a launch that never connected is retried, but only when asked', () => {
  assert.equal(watchDecision({ present: true, panelOpen: false, launched: true, retryDue: true }), 'launch')
  assert.equal(
    watchDecision({ present: true, panelOpen: false, launched: true, retryDue: false }),
    'idle',
    'a panel the user closed stays closed',
  )
  assert.equal(
    watchDecision({ present: false, panelOpen: false, launched: true, retryDue: true }),
    'reset',
  )
})
