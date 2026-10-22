#!/usr/bin/env node
/**
 * One pre-flight command for a fresh clone or a fork.
 *
 * Idea borrowed from HAST-SEC's `npm run check` (syntax + local dependency
 * paths + bundled resources in one command). No code is copied from it: that
 * project is under a non-commercial licence, so only the UX idea is reused.
 *
 * Deterministic on purpose - no network, no daemon, no browser:
 *   1. every .mjs/.js/.cjs file parses
 *   2. every path in config/dist-manifest.json exists
 *   3. the unit + contract suite passes
 *
 * Usage: node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SKIP = /node_modules|[\\/]vendor[\\/]|[\\/]dist[\\/]|[\\/]work[\\/]/

let failures = 0
const report = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (SKIP.test(full)) continue
    if (entry.isDirectory()) collect(full, out)
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

// 1. syntax ------------------------------------------------------------------
const files = collect(ROOT)
const broken = []
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) broken.push(`${path.relative(ROOT, file)}: ${(res.stderr || '').split('\n')[0]}`)
}
report(`syntax: ${files.length} files parse`, broken.length === 0, broken.join(' | ').slice(0, 200))

// 2. distribution manifest ---------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'dist-manifest.json'), 'utf8'))
const missing = [...manifest.include, ...manifest.requiredForInstall].filter(
  (rel) => !fs.existsSync(path.join(ROOT, rel)),
)
report('distribution manifest points at real files', missing.length === 0, missing.join(', '))

const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const pluginVersion = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).version
const versionFile = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()
report('package, plugin and VERSION agree',
  packageVersion === pluginVersion && packageVersion === versionFile,
  `${packageVersion} / ${pluginVersion} / ${versionFile}`)

// 3. tests -------------------------------------------------------------------
const test = spawnSync(process.execPath, ['--test', 'tests/**/*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
const summary = (test.stdout || '')
  .split('\n')
  .filter((line) => /^ℹ (tests|pass|fail)/.test(line))
  .join('  ')
report('unit + contract tests', test.status === 0, summary)
if (test.status !== 0) console.log((test.stdout || '').split('\n').slice(-25).join('\n'))

// 4. nothing to hand over ----------------------------------------------------
// Somebody else installing this brings their own Codex login (the default chat
// channel is `codex-exec`) and, if they want the cloud voice, their own key -
// never ours.
const { scanFiles, collect: collectForScan } = await import('./portable-scan.mjs')
const credentials = scanFiles(collectForScan(ROOT))
report(
  'distribution carries no credentials',
  credentials.length === 0,
  credentials.map((p) => `${p.rel} (${p.hits.join('; ')})`).join(', '),
)

console.log()
console.log(failures === 0 ? 'check passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
