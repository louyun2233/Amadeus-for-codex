#!/usr/bin/env node
/**
 * Wait for Codex and bring the panel up with it - **without Codex hooks**.
 *
 * Installed as a shortcut in the Startup folder (`install.ps1`), so it is
 * running from login onwards; it costs one `tasklist` probe every few seconds
 * and does nothing else until Codex appears.
 *
 * Usage:
 *   node bin/amadeus-watch.mjs [--interval 3000] [--once] [--silent]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import { ping, readDaemonInfo } from '../src/host/daemon-client.mjs'
import { detectCodex, watchDecision, codexSignature } from '../src/host/codex-watch.mjs'
import { openPanel, panelIsOpen } from '../src/host/panel-launcher.mjs'
import { ensureNotifyHook } from '../src/core/codex-config.mjs'

const args = process.argv.slice(2)
const silent = args.includes('--silent')
const once = args.includes('--once')
const intervalFlag = args.indexOf('--interval')
const intervalMs =
  intervalFlag >= 0 ? Math.max(1000, Number(args[intervalFlag + 1]) || 3000) : 3000

const paths = ensureDirs(resolvePaths())
const logFile = path.join(paths.dataRoot, 'watch.log')

/** Small append-only log: the watcher has no console when started at login. */
function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`
  if (!silent) process.stdout.write(entry)
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 64 * 1024) {
      fs.writeFileSync(logFile, entry, { encoding: 'utf8', mode: 0o600 })
      return
    }
    fs.appendFileSync(logFile, entry, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* logging must never break the watch loop */
  }
}

let launched = false
let stopping = false
let launchAttempts = 0
let lastLaunchAt = 0
let panelServedSinceLaunch = false

/**
 * How long a freshly opened window has to produce a connected client before the
 * watcher treats the attempt as failed and tries again. Bounded, because the
 * connector must never turn a user's "I closed the panel" into a fight.
 */
const PANEL_CONNECT_GRACE_MS = 25000
const MAX_LAUNCH_ATTEMPTS = 3

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODEX_CONFIG = process.env.AMADEUS_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml')
const NOTIFY_HOOK = path.join(ROOT, 'bin', 'amadeus-notify.mjs')

let signature = null
let lastSignatureCheck = 0
let signatureChanged = false

/**
 * Codex rewrites its own `notify` key on update, which silently disables the
 * finished-task announcement and the keep-alive ping. Re-applying it is part of
 * the watcher's job, so an update can no longer leave the connector half dead.
 */
function ensureHook(reason) {
  try {
    const result = ensureNotifyHook({
      configPath: CODEX_CONFIG,
      hookPath: NOTIFY_HOOK,
      chainFile: path.join(paths.dataRoot, 'notify-chain.json'),
    })
    if (result.changed) log(`notify hook re-applied (${reason}): ${result.reason}`)
    else if (!result.ok) log(`notify hook not installed (${reason}): ${result.reason}`)
    return result
  } catch (e) {
    log(`notify hook check failed: ${e && e.message ? e.message : e}`)
    return { ok: false, changed: false, reason: 'threw' }
  }
}

async function tick() {
  const present = detectCodex()

  // The fingerprint only changes when Codex itself changes, so re-reading the
  // directory listing every 15s is enough - and cheap next to `tasklist`.
  const now = Date.now()
  if (signature === null || now - lastSignatureCheck > 15000) {
    const next = codexSignature()
    lastSignatureCheck = now
    if (signature !== null && next !== signature && next !== '') {
      log(`Codex build changed (${signature} -> ${next}); the connector will come up again`)
      signatureChanged = true
      ensureHook('codex-updated')
    }
    signature = next
  }

  const info = readDaemonInfo(paths)
  const alive = info ? await ping(info) : false
  const open = alive ? await panelIsOpen(info) : false
  const retryDue =
    present &&
    alive &&
    !open &&
    launched &&
    !panelServedSinceLaunch &&
    launchAttempts < MAX_LAUNCH_ATTEMPTS &&
    now - lastLaunchAt > PANEL_CONNECT_GRACE_MS
  const decision = watchDecision({
    present,
    panelOpen: open,
    launched,
    daemonUp: alive,
    signatureChanged,
    retryDue,
  })
  signatureChanged = false

  if (decision === 'reset') {
    if (launched) log('Codex closed; the next launch will show the panel again')
    launched = false
    launchAttempts = 0
    panelServedSinceLaunch = false
    return
  }
  if (decision === 'revive') {
    // The daemon restarted, which invalidates the page's session cookie and
    // usually leaves a grey "can't reach" window behind. Replace it with a
    // fresh one instead of leaving a half-broken page on screen.
    const result = await openPanel({ paths, force: true })
    log(`daemon was gone; reopened the panel (${result.status})`)
    return
  }
  if (decision === 'relaunch') {
    launched = true
    launchAttempts += 1
    lastLaunchAt = now
    panelServedSinceLaunch = false
    const result = await openPanel({ paths, force: true })
    log(`Codex was updated; reopened the panel (${result.status})`)
    return
  }
  if (decision === 'seen') {
    launched = true
    panelServedSinceLaunch = true
    return
  }
  if (decision !== 'launch') return

  launched = true
  launchAttempts = launchAttempts + 1
  lastLaunchAt = now
  panelServedSinceLaunch = false
  const result = await openPanel({ paths, welcome: true })
  log(`Codex detected -> panel ${result.status} (attempt ${launchAttempts})`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  log(`watching for Codex every ${intervalMs}ms (no hooks)`)
  ensureHook('startup')
  do {
    try {
      await tick()
    } catch (e) {
      log(`tick failed: ${e && e.message ? e.message : e}`)
    }
    if (once) break
    await sleep(intervalMs)
  } while (!stopping)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    log('watcher stopped')
    process.exit(0)
  })
}

main().catch((e) => {
  log(`watcher failed: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
