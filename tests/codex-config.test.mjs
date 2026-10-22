import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureNotifyHook, removeNotifyHook, findNotifyArray, sanitizeChainedNotify } from '../src/core/codex-config.mjs'

/**
 * Codex rewrites its own `notify` key when it updates itself - after 26.1013 the
 * line was back to `codex-computer-use.exe turn-ended`, so the hook that
 * announces finished tasks had silently stopped running. Keeping it installed
 * is a running job now, and this is what that job must not get wrong.
 */

function workspace(configText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-codexcfg-'))
  const configPath = path.join(root, 'config.toml')
  const hookPath = path.join(root, 'bin', 'amadeus-notify.mjs')
  const chainFile = path.join(root, 'data', 'notify-chain.json')
  fs.mkdirSync(path.dirname(hookPath), { recursive: true })
  fs.writeFileSync(hookPath, '// hook\n')
  if (configText !== null) fs.writeFileSync(configPath, configText)
  return { root, configPath, hookPath, chainFile }
}

const CHAINED = ['C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\h\\codex-computer-use.exe', 'turn-ended']

test('a computer-use previous-notify reference back to Amadeus is removed, preserving the notifier', () => {
  const hook = 'C:\\Amadeus\\bin\\amadeus-notify.mjs'
  const wrapped = [...CHAINED, '--previous-notify', JSON.stringify(['node', hook, 'turn-ended'])]
  assert.deepEqual(sanitizeChainedNotify(wrapped, hook), CHAINED)
  assert.deepEqual(sanitizeChainedNotify(CHAINED, hook), CHAINED)
  assert.deepEqual(sanitizeChainedNotify(['node', hook, 'turn-ended'], hook), [])
})

test('an already-installed hook repairs a recursive saved chain', () => {
  const ws = workspace('model = "gpt-5"\n')
  try {
    ensureNotifyHook(ws)
    fs.mkdirSync(path.dirname(ws.chainFile), { recursive: true })
    fs.writeFileSync(ws.chainFile, JSON.stringify({
      command: [...CHAINED, '--previous-notify', JSON.stringify(['node', ws.hookPath, 'turn-ended'])],
    }))
    const repaired = ensureNotifyHook(ws)
    assert.equal(repaired.reason, 'chain-repaired')
    assert.deepEqual(JSON.parse(fs.readFileSync(ws.chainFile, 'utf8')).command, CHAINED)
    assert.equal(ensureNotifyHook(ws).reason, 'already-installed')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('a newly wrapped notifier is sanitized before it is saved', () => {
  const hook = 'C:\\Amadeus\\bin\\amadeus-notify.mjs'
  const wrapped = [...CHAINED, '--previous-notify', JSON.stringify(['node', hook, 'turn-ended'])]
  const text = 'notify = [' + wrapped.map((part) => JSON.stringify(part)).join(', ') + ']\n'
  const ws = workspace(text)
  try {
    const result = ensureNotifyHook(ws)
    assert.equal(result.reason, 'installed')
    assert.deepEqual(JSON.parse(fs.readFileSync(ws.chainFile, 'utf8')).command, CHAINED)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('a config without a notify line gets one, above the first table', () => {
  const ws = workspace('model = "gpt-5"\n\n[model_providers.custom]\nname = "x"\n')
  try {
    const result = ensureNotifyHook(ws)
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
    assert.equal(result.reason, 'installed')
    const lines = fs.readFileSync(ws.configPath, 'utf8').split('\n')
    const notifyAt = lines.findIndex((l) => l.startsWith('notify = '))
    const tableAt = lines.findIndex((l) => l.startsWith('['))
    assert.ok(notifyAt >= 0 && notifyAt < tableAt, 'top-level keys must stay above table headers')
    assert.match(lines[notifyAt], /amadeus-notify\.mjs/)
    assert.ok(lines.includes('model = "gpt-5"'), 'existing keys survive')
    assert.equal(fs.existsSync(ws.chainFile), false, 'nothing to chain when there was no notifier')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('the notifier Codex restored after an update is taken over and preserved', () => {
  const spaced = `notify = [ "${CHAINED[0]}", "turn-ended" ]\nmodel = "gpt-5"\n`
  const ws = workspace(spaced)
  try {
    assert.deepEqual(findNotifyArray(spaced).parts, CHAINED, 'the spaced style Codex writes is parsed')
    const result = ensureNotifyHook(ws)
    assert.equal(result.changed, true)
    assert.deepEqual(result.chained, CHAINED)
    assert.deepEqual(JSON.parse(fs.readFileSync(ws.chainFile, 'utf8')).command, CHAINED)
    assert.match(fs.readFileSync(ws.configPath, 'utf8'), /amadeus-notify\.mjs/)
    assert.ok(!fs.readFileSync(ws.configPath, 'utf8').includes('codex-computer-use.exe'))
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('running it again changes nothing and never chains our own command', () => {
  const ws = workspace('model = "gpt-5"\n')
  try {
    ensureNotifyHook(ws)
    const after = fs.readFileSync(ws.configPath, 'utf8')
    const second = ensureNotifyHook(ws)
    assert.equal(second.changed, false)
    assert.equal(second.reason, 'already-installed')
    assert.equal(fs.readFileSync(ws.configPath, 'utf8'), after)
    assert.equal(fs.existsSync(ws.chainFile), false)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('line endings and unrelated content survive the rewrite', () => {
  const ws = workspace('model = "gpt-5"\r\nnotify = [ "old.exe" ]\r\nexperimental = true\r\n')
  try {
    ensureNotifyHook(ws)
    const text = fs.readFileSync(ws.configPath, 'utf8')
    assert.ok(text.includes('\r\n'), 'CRLF stays CRLF')
    assert.ok(text.includes('experimental = true'))
    assert.deepEqual(JSON.parse(fs.readFileSync(ws.chainFile, 'utf8')).command, ['old.exe'])
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('removing the hook puts the user notifier back', () => {
  const ws = workspace(`notify = ["${CHAINED[0]}", "turn-ended"]\nmodel = "gpt-5"\n`)
  try {
    ensureNotifyHook(ws)
    const removed = removeNotifyHook(ws)
    assert.equal(removed.changed, true)
    assert.equal(removed.reason, 'restored')
    const text = fs.readFileSync(ws.configPath, 'utf8')
    assert.ok(text.includes('codex-computer-use.exe'))
    assert.ok(!text.includes('amadeus-notify.mjs'))
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('a missing config or missing hook is reported instead of created', () => {
  const noConfig = workspace(null)
  try {
    assert.deepEqual(ensureNotifyHook(noConfig), { ok: false, changed: false, reason: 'config-missing' })
    assert.equal(fs.existsSync(noConfig.configPath), false)
  } finally {
    fs.rmSync(noConfig.root, { recursive: true, force: true })
  }

  const noHook = workspace('model = "gpt-5"\n')
  try {
    fs.rmSync(noHook.hookPath)
    const result = ensureNotifyHook(noHook)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'hook-missing')
    assert.equal(fs.readFileSync(noHook.configPath, 'utf8'), 'model = "gpt-5"\n')
  } finally {
    fs.rmSync(noHook.root, { recursive: true, force: true })
  }
})
