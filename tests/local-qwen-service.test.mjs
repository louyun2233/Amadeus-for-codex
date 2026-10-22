import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureLocalQwen } from '../src/core/local-qwen-service.mjs'

test('Qwen startup waits briefly for an already-starting service after its own launcher exits', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qwen-start-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dataRoot, 'qwen-service.json'), JSON.stringify({
    python: process.execPath,
    script: path.resolve(import.meta.filename),
  }))
  let checks = 0
  let launches = 0
  const ok = await ensureLocalQwen({ dataRoot }, {
    readyCheck: async () => ++checks >= 3,
    spawnProcess: () => {
      launches += 1
      return { exitCode: 1, on() {}, unref() {} }
    },
    timeoutMs: 500,
    exitGraceMs: 100,
    pollMs: 1,
  })
  assert.equal(ok, true)
  assert.equal(launches, 1)
  assert.ok(checks >= 3)
})
