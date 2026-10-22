import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The hook has to stay alive long enough to say something.
 *
 * The previous notifier is chained through `notify-chain.json` and lives in
 * Codex's own runtime directory. Codex deleted that directory on this machine,
 * `spawn` raised an asynchronous 'error' nobody listened to, and the hook died
 * *after* writing its first log line - so a finished task produced a log entry
 * and silence. Both halves are pinned here: a missing chain must not kill the
 * hook, and a working chain must still be replayed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'bin', 'amadeus-notify.mjs')
const PAYLOAD = '{"type":"agent-turn-complete","client":"hook-test"}'

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-hook-'))
  const data = path.join(root, 'data')
  fs.mkdirSync(path.join(data, 'runtime'), { recursive: true })
  return { root, data }
}

function runHook(data) {
  return spawnSync(process.execPath, [HOOK, 'turn-ended', PAYLOAD], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, AMADEUS_DATA_DIR: data, AMADEUS_CACHE_DIR: path.join(data, 'cache') },
  })
}

function logLines(data) {
  return fs
    .readFileSync(path.join(data, 'notify.log'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

test('a chained notifier that is gone does not take the hook with it', () => {
  const { root, data } = workspace()
  try {
    const gone = path.join(root, 'deleted-runtime', 'codex-computer-use.exe')
    fs.writeFileSync(
      path.join(data, 'notify-chain.json'),
      JSON.stringify({ command: [gone, 'turn-ended'] }),
    )

    const result = runHook(data)
    assert.equal(result.status, 0, result.stderr)
    const lines = logLines(data)
    assert.ok(lines.some((l) => l.includes('chain-missing')), `expected a chain-missing line in ${lines}`)
    assert.ok(
      lines.some((l) => l.includes('kind=task-complete') && l.includes('daemon=down')),
      `expected the event to be classified and logged even without a daemon in ${lines}`,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a chained notifier that exists is still replayed', async () => {
  const { root, data } = workspace()
  try {
    const marker = path.join(root, 'chained.txt')
    const script = path.join(root, 'chain.mjs')
    fs.writeFileSync(
      script,
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'replayed')\n`,
    )
    fs.writeFileSync(
      path.join(data, 'notify-chain.json'),
      JSON.stringify({ command: [process.execPath, script] }),
    )

    const result = runHook(data)
    assert.equal(result.status, 0, result.stderr)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'replayed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the runtime never replays a chained previous-notify that points back to itself', async () => {
  const { root, data } = workspace()
  try {
    const marker = path.join(root, 'received.json')
    const script = path.join(root, 'chain.mjs')
    fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))\n`)
    fs.writeFileSync(path.join(data, 'notify-chain.json'), JSON.stringify({
      command: [process.execPath, script, 'turn-ended', '--previous-notify', JSON.stringify(['node', HOOK, 'turn-ended'])],
    }))
    const result = runHook(data)
    assert.equal(result.status, 0, result.stderr)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['turn-ended', PAYLOAD])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable chain file is ignored instead of fatal', () => {
  const { root, data } = workspace()
  try {
    fs.writeFileSync(path.join(data, 'notify-chain.json'), '{ not json')
    const result = runHook(data)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(logLines(data).some((l) => l.includes('kind=task-complete')), 'the event still gets classified')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
