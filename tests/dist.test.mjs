import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the single source of truth for packaging.
 *
 * make-dist.mjs ships exactly `include` (minus `exclude`) and refuses to build
 * if anything in `requiredForInstall` is absent; install.ps1 preflights the same
 * list. These tests keep those two from drifting apart, and keep the list from
 * pointing at files that no longer exist.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'dist-manifest.json'), 'utf8'))

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function coveredByInclude(rel) {
  const norm = rel.replace(/\\/g, '/')
  return manifest.include.some((inc) => {
    const i = inc.replace(/\\/g, '/')
    return norm === i || norm.startsWith(i + '/')
  })
}

test('every include path exists', () => {
  const missing = manifest.include.filter((rel) => !exists(rel))
  assert.deepEqual(missing, [], `include lists missing paths: ${missing.join(', ')}`)
})

test('every requiredForInstall file exists', () => {
  const missing = manifest.requiredForInstall.filter((rel) => !exists(rel))
  assert.deepEqual(missing, [], `required files missing from the tree: ${missing.join(', ')}`)
})

test('every required file is covered by an include entry', () => {
  const uncovered = manifest.requiredForInstall.filter((rel) => !coveredByInclude(rel))
  assert.deepEqual(uncovered, [], `these would not be packaged: ${uncovered.join(', ')}`)
})

test('required files are files, not directories', () => {
  for (const rel of manifest.requiredForInstall) {
    assert.ok(fs.statSync(path.join(ROOT, rel)).isFile(), `${rel} must be a file`)
  }
})

test('the runtime is shippable without node_modules', () => {
  // Anything the runtime needs at import time must be inside the archive.
  const runtimeEntry = 'bin/amadeus-daemon.mjs'
  assert.ok(exists(runtimeEntry))
  const imports = [...fs.readFileSync(path.join(ROOT, runtimeEntry), 'utf8').matchAll(/from '([^']+)'/g)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith('.'))
  for (const spec of imports) {
    const resolved = path.resolve(ROOT, path.dirname(runtimeEntry), spec)
    assert.ok(fs.existsSync(resolved), `daemon imports ${spec}, which is not in the archive`)
  }
})

test('the panel renders without node_modules', () => {
  // vendored, MIT-licensed runtime pieces must be present and non-trivial
  for (const rel of [
    'src/panel/vendor/pixi-7.4.2.min.js',
    'src/panel/vendor/pixi-live2d-display-0.4.0-cubism2.min.js',
  ]) {
    const size = fs.statSync(path.join(ROOT, rel)).size
    assert.ok(size > 10000, `${rel} looks too small to be the real bundle (${size} bytes)`)
  }
})

test('shell installer scripts are ASCII-only', () => {
  // Windows PowerShell 5.1 decodes .ps1 as system ANSI unless the file has a
  // UTF-8 BOM. A non-ASCII string becomes mojibake and can swallow a quote,
  // which only shows up when the packaged copy is actually executed.
  const dir = path.join(ROOT, 'scripts')
  const scripts = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ps1|bat|cmd)$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
  assert.ok(scripts.length > 0, 'expected at least one installer script')
  for (const file of scripts) {
    const buf = fs.readFileSync(file)
    const offset = buf.findIndex((b) => b > 0x7f)
    assert.equal(
      offset,
      -1,
      `${path.relative(ROOT, file)} has a non-ASCII byte at offset ${offset}; keep these scripts ASCII-only`,
    )
    assert.notEqual(buf[0], 0xef, `${path.relative(ROOT, file)} starts with a UTF-8 BOM`)
  }
})
