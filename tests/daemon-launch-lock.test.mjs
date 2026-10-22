import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireDaemonLaunchLock } from '../src/host/daemon-client.mjs'

test('only one launcher can own the daemon startup lock', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-launch-lock-'))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const paths = { runtimeDir }
  const release = acquireDaemonLaunchLock(paths)
  assert.equal(typeof release, 'function')
  assert.equal(acquireDaemonLaunchLock(paths), null)
  release()
  const next = acquireDaemonLaunchLock(paths)
  assert.equal(typeof next, 'function')
  next()
})

test('an abandoned launcher lock is reclaimed without touching its directory', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-stale-lock-'))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(runtimeDir, 'daemon-launch.lock'), JSON.stringify({ pid: 99999999 }))
  assert.equal(acquireDaemonLaunchLock({ runtimeDir }), null)
  const release = acquireDaemonLaunchLock({ runtimeDir })
  assert.equal(typeof release, 'function')
  release()
  assert.ok(fs.existsSync(runtimeDir))
})
