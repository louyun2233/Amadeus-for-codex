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
 *   2. native Python files parse when Python is available
 *   3. every path in config/dist-manifest.json exists
 *   4. the JS suite and installed Windows native suite pass
 *
 * Usage: node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SKIP = /node_modules|[\\/]vendor[\\/]|[\\/]dist[\\/]|[\\/]work[\\/]|[\\/]\.native-venv[\\/]|[\\/]__pycache__[\\/]/

let failures = 0
const report = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

function collect(dir, out = [], pattern = /\.(mjs|js|cjs)$/) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (SKIP.test(full)) continue
    if (entry.isDirectory()) collect(full, out, pattern)
    else if (pattern.test(entry.name)) out.push(full)
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

// Native code must be checked independently: the older web contract tests do
// not parse panel.py or exercise its Qt event handlers.
const nativePython = path.join(ROOT, '.native-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const nativeInstalled = fs.existsSync(path.join(ROOT, '.native-venv'))
const pythonOptions = {
  cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', QT_QPA_PLATFORM: 'offscreen' },
}
let python = null
const candidates = fs.existsSync(nativePython) ? [[nativePython]]
  : process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
for (const command of candidates) {
  const result = spawnSync(command[0], [...command.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], pythonOptions)
  if (result.status === 0) {
    python = command
    break
  }
}
if (python) {
  const pythonFiles = collect(path.join(ROOT, 'native'), [], /\.py$/)
    .concat(collect(path.join(ROOT, 'tests'), [], /\.py$/))
  const syntax = spawnSync(python[0], [...python.slice(1), '-c',
    'import ast, pathlib, sys\nfor name in sys.argv[1:]:\n    p = pathlib.Path(name)\n    ast.parse(p.read_text(encoding="utf-8-sig"), filename=str(p))',
    ...pythonFiles.map((file) => path.relative(ROOT, file)),
  ], pythonOptions)
  report(`native Python syntax: ${pythonFiles.length} files parse`, syntax.status === 0,
    syntax.status === 0 ? '' : (syntax.stderr || syntax.error?.message || 'Python failed').slice(-500))
} else if (process.platform === 'win32' && nativeInstalled) {
  report('native Python available', false, 'installed .native-venv cannot run Python 3.11+')
} else {
  console.log('SKIP  native Python syntax: Python 3.11+ is not available')
}

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

// The native tests use fake APIs and an offscreen Qt platform. They neither
// connect to an installed daemon nor open a visible window.
if (process.platform !== 'win32') {
  console.log('SKIP  native Qt tests: Windows native runtime required')
} else if (nativeInstalled && !fs.existsSync(nativePython)) {
  report('native Qt tests', false, '.native-venv is incomplete; reinstall the native dependencies')
} else if (python) {
  const deps = spawnSync(python[0], [...python.slice(1), '-c',
    'import live2d; from PySide6.QtOpenGLWidgets import QOpenGLWidget; from OpenGL.GL import glViewport',
  ], pythonOptions)
  if (deps.status === 0) {
    const native = spawnSync(python[0], [...python.slice(1), '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'native_*_test.py'],
      { ...pythonOptions, timeout: 120000 })
    const output = `${native.stdout || ''}\n${native.stderr || ''}`
    const summary = output.split(/\r?\n/).filter((line) => /^(Ran \d+ test|OK\b|FAILED\b)/.test(line)).join('  ')
    const ranTests = /\bRan [1-9]\d* tests?\b/.test(output)
    report('native Qt tests', native.status === 0 && ranTests, summary || native.error?.message || 'no native tests discovered')
    if (native.status !== 0) console.log(output.split(/\r?\n/).slice(-35).join('\n'))
  } else if (nativeInstalled) {
    report('native Qt dependencies', false, 'installed .native-venv cannot import Qt/OpenGL/Live2D')
  } else {
    console.log('SKIP  native Qt tests: Qt/OpenGL/Live2D dependencies are not installed')
  }
} else {
  console.log('SKIP  native Qt tests: Python 3.11+ is not available')
}

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
