import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiagnostics } from '../src/core/diag.mjs'
import { CODES } from '../src/core/codes.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { EventHub } from '../src/host/events.mjs'
import { ensureDirs } from '../src/shared/paths.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Learned from Code-Codex's `CC-…` diagnostic codes: every failure in the
 * report has to be identifiable and actionable, not a sentence that has to be
 * interpreted. These tests pin the codes that the update/唤醒 and audio reports
 * depend on.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'bin', 'amadeus-notify.mjs')

function writeCodexConfig(text) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'amadeus-cfg-'))
  const file = path.join(dir, 'config.toml')
  fs.writeFileSync(file, text)
  return { dir, file }
}

async function run({ codexConfig, assets = null } = {}) {
  const paths = tempPaths()
  ensureDirs(paths)
  const previous = process.env.AMADEUS_CODEX_CONFIG
  if (codexConfig) process.env.AMADEUS_CODEX_CONFIG = codexConfig
  try {
    const result = await runDiagnostics({
      paths,
      config: new ConfigStore(paths),
      secrets: new SecretStore(paths),
      tts: { providerId: () => 'edge', stats: () => ({ cachedFiles: 0 }) },
      stt: null,
      systemTts: null,
      llm: null,
      hub: new EventHub(),
      assets,
      deep: false,
    })
    return { paths, result }
  } finally {
    if (previous === undefined) delete process.env.AMADEUS_CODEX_CONFIG
    else process.env.AMADEUS_CODEX_CONFIG = previous
  }
}

function codes(result) {
  return result.degrade.map((entry) => entry.code)
}

test('the report always carries a code, a reason and an action', async () => {
  const { paths, result } = await run()
  try {
    assert.ok(result.checks.storage.ok, 'the ownership marker is written by ensureDirs')
    for (const entry of result.degrade) {
      assert.match(entry.code, /^AM-\d{4}$/, JSON.stringify(entry))
      assert.ok(entry.reason, `missing reason: ${JSON.stringify(entry)}`)
      assert.ok(entry.action, `missing action: ${JSON.stringify(entry)}`)
    }
  } finally {
    cleanup(paths)
  }
})

test('a missing model and runtime are reported with their codes', async () => {
  const assets = {
    status: () => ({
      packs: [
        { id: 'kurisu-model', kind: 'model', installed: false },
        { id: 'cubism2-runtime', kind: 'runtime', installed: false, matches: false },
      ],
    }),
  }
  const { paths, result } = await run({ assets })
  try {
    const list = codes(result)
    assert.ok(list.includes(CODES.MODEL_MISSING), list.join(','))
    assert.ok(list.includes(CODES.RUNTIME_MISSING), list.join(','))
  } finally {
    cleanup(paths)
  }
})

test('the notify hook Codex wiped is visible in the report', async () => {
  const foreign = writeCodexConfig('notify = ["C:\\\\other.exe", "turn-ended"]\n')
  try {
    const { paths, result } = await run({ codexConfig: foreign.file })
    try {
      assert.equal(result.checks.notifyHook.ok, false)
      assert.ok(codes(result).includes(CODES.NOTIFY_HOOK_MISSING), codes(result).join(','))
    } finally {
      cleanup(paths)
    }
  } finally {
    fs.rmSync(foreign.dir, { recursive: true, force: true })
  }
})

test('an installed hook is reported as healthy', async () => {
  const ours = writeCodexConfig(`notify = ["node", "${HOOK.replace(/\\/g, '\\\\')}", "turn-ended"]\n`)
  try {
    const { paths, result } = await run({ codexConfig: ours.file })
    try {
      assert.equal(result.checks.notifyHook.ok, true)
      assert.ok(!codes(result).includes(CODES.NOTIFY_HOOK_MISSING))
    } finally {
      cleanup(paths)
    }
  } finally {
    fs.rmSync(ours.dir, { recursive: true, force: true })
  }
})
