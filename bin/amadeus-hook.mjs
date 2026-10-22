#!/usr/bin/env node
/**
 * Inspect or repair Codex's `notify` hook.
 *
 *   node bin/amadeus-hook.mjs status   # is our hook installed? what replaced it?
 *   node bin/amadeus-hook.mjs ensure   # install it (the previous command is chained)
 *   node bin/amadeus-hook.mjs remove   # restore whatever was there before
 *
 * The watcher runs `ensure` at startup and whenever it sees a new Codex build,
 * because a Codex update rewrites that key and silently disables the
 * finished-task announcement.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import {
  ensureNotifyHook,
  removeNotifyHook,
  findNotifyArray,
  isOurNotifyCommand,
} from '../src/core/codex-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const paths = ensureDirs(resolvePaths())
const configPath = process.env.AMADEUS_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml')
const hookPath = path.join(ROOT, 'bin', 'amadeus-notify.mjs')
const chainFile = path.join(paths.dataRoot, 'notify-chain.json')

const command = (process.argv[2] || 'status').toLowerCase()
const args = { configPath, hookPath, chainFile }

function readCurrent() {
  try {
    const text = fs.readFileSync(configPath, 'utf8')
    const found = findNotifyArray(text)
    if (!found) return { present: false, command: [], ours: false }
    return { present: true, command: found.parts, ours: isOurNotifyCommand(found.parts, hookPath) }
  } catch (e) {
    return { present: false, command: [], ours: false, error: e && e.code === 'ENOENT' ? 'config-missing' : String(e) }
  }
}

function chained() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'))
    return Array.isArray(parsed?.command) ? parsed.command : null
  } catch {
    return null
  }
}

let result
if (command === 'ensure') {
  result = { action: 'ensure', ...ensureNotifyHook(args) }
} else if (command === 'remove') {
  result = { action: 'remove', ...removeNotifyHook(args) }
} else {
  const current = readCurrent()
  result = {
    action: 'status',
    ok: current.ours,
    configPath,
    hookPath,
    installed: current.ours,
    command: current.command,
    chained: chained(),
    ...(current.error ? { error: current.error } : {}),
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (command === 'status' && !result.installed) process.exitCode = 1
