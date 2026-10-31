#!/usr/bin/env node
/**
 * Read-only readiness check for the Windows Qt/OpenGL panel.
 * Uses the installed native runtime and loopback daemon; it never launches a
 * window, installs dependencies, synthesizes speech, or reads chat messages.
 *
 * Usage: node scripts/verify-panel.mjs [--data <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from '../src/shared/paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dataFlag = args.indexOf('--data')
if (dataFlag >= 0 && !args[dataFlag + 1]) {
  console.error('Usage: node scripts/verify-panel.mjs [--data <dir>]')
  process.exit(1)
}
const paths = resolvePaths(
  dataFlag >= 0 ? { ...process.env, AMADEUS_DATA_DIR: args[dataFlag + 1] } : process.env,
)
const rows = []
const record = (label, ok, detail = '') => rows.push({ label, ok: Boolean(ok), detail })
const exists = (file) => {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0 } catch { return false }
}

// Check the same native resources that the installer requires. A missing
// launcher or virtual environment is an installation problem, not a web 404.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'dist-manifest.json'), 'utf8'))
for (const rel of manifest.requiredForInstall.filter((name) => name.startsWith('native/') || name === 'scripts/Amadeus.ico')) {
  record(rel, exists(path.join(ROOT, rel)))
}
record('Amadeus.exe', exists(path.join(ROOT, 'Amadeus.exe')))
let stamp = ''
try { stamp = fs.readFileSync(path.join(ROOT, 'Amadeus.native'), 'utf8').trim() } catch { /* not installed */ }
record('native launcher marker', stamp === 'qt-opengl')

const python = path.join(ROOT, '.native-venv', 'Scripts', 'python.exe')
record('Windows native Python', process.platform === 'win32' && exists(python),
  process.platform !== 'win32' ? 'Windows is required' : '')
if (process.platform === 'win32' && exists(python)) {
  const result = spawnSync(python, ['-c', [
    'import sys',
    'assert sys.version_info >= (3, 11) and sys.maxsize > 2**32',
    'import live2d',
    'from PySide6.QtOpenGLWidgets import QOpenGLWidget',
    'from OpenGL.GL import glViewport',
    'import clr',
    'print("native-dependencies-ready")',
  ].join('\n')], { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true })
  record('Qt / OpenGL / Live2D / Windows speech dependencies',
    result.status === 0 && result.stdout.includes('native-dependencies-ready'),
    result.status === 0 ? '' : 'Run the desktop installer to repair the native environment')
}

let info = null
try {
  const parsed = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
  if (Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535 && typeof parsed.token === 'string' && parsed.token) info = parsed
} catch { /* the diagnostic reports this without starting a daemon */ }
record('daemon connection metadata', info !== null, info ? '' : 'Start Amadeus before running this check')

async function get(apiPath) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${apiPath}`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false, detail: 'Loopback daemon unavailable or response invalid' }
  }
}

if (info) {
  const results = await Promise.allSettled([
    get('/amadeus/health'), get('/amadeus/status'), get('/amadeus/assets/status'),
  ])
  const [health, status, assets] = results.map((result) => result.status === 'fulfilled'
    ? result.value : { ok: false, detail: 'Request failed' })
  record('daemon health', health.ok && health.body?.ok === true, health.detail)
  record('native panel status', status.ok, status.ok
    ? `${status.body?.events?.nativeClients || 0} connected native window(s); a closed window is allowed`
    : status.detail)
  record('assets status', assets.ok, assets.detail)
  if (assets.ok) {
    const model = assets.body?.activeModel
    const entry = typeof model?.entry === 'string' ? model.entry : ''
    record('active native model installed', model?.installed && exists(entry))
    if (entry && exists(entry)) {
      let settings = null
      try { settings = JSON.parse(fs.readFileSync(entry, 'utf8')) } catch { /* reported below */ }
      record('model JSON readable', settings !== null)
      if (settings) {
        const refs = new Set()
        if (settings.model) refs.add(settings.model)
        for (const texture of settings.textures || []) refs.add(texture)
        if (settings.physics) refs.add(settings.physics)
        if (settings.pose) refs.add(settings.pose)
        for (const expression of settings.expressions || []) if (expression.file) refs.add(expression.file)
        for (const group of Object.values(settings.motions || {})) {
          for (const motion of group || []) if (motion.file) refs.add(motion.file)
        }
        // Original motion audio is deliberately not played by the native
        // panel: all spoken reactions use the user's selected voice.
        const missing = [...refs].filter((rel) => typeof rel !== 'string' || !exists(path.resolve(path.dirname(entry), rel)))
        record('native model files', refs.size > 0 && missing.length === 0,
          `${refs.size} references, ${missing.length} missing`)
      }
    }
  }
}

for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.label}${row.detail ? '  ' + row.detail : ''}`)
const failures = rows.filter((row) => !row.ok).length
console.log(`\n${rows.length - failures}/${rows.length} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
