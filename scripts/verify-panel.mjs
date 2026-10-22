#!/usr/bin/env node
/**
 * Panel readiness check.
 *
 * A Live2D panel can look "broken" for very boring reasons: one texture 404s,
 * the physics file is missing, the runtime script never loaded. This walks
 * every URL the renderer depends on and fails loudly on the first gap.
 *
 * Usage: node scripts/verify-panel.mjs [--data <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolvePaths } from '../src/shared/paths.mjs'

const args = process.argv.slice(2)
const dataFlag = args.indexOf('--data')
const paths = resolvePaths(
  dataFlag >= 0 ? { ...process.env, AMADEUS_DATA_DIR: args[dataFlag + 1] } : process.env,
)

const info = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
const base = `http://127.0.0.1:${info.port}`
const auth = { Authorization: `Bearer ${info.token}` }

let failures = 0
const rows = []

function record(label, ok, detail) {
  rows.push({ label, ok, detail })
  if (!ok) failures += 1
}

async function head(url, { json = false } = {}) {
  const res = await fetch(base + url, { headers: auth })
  const buf = Buffer.from(await res.arrayBuffer())
  let parsed = null
  if (json && res.ok) {
    try {
      parsed = JSON.parse(buf.toString('utf8'))
    } catch (e) {
      return { ok: false, status: res.status, bytes: buf.length, error: 'invalid json' }
    }
  }
  return {
    ok: res.ok && buf.length > 0,
    status: res.status,
    bytes: buf.length,
    type: res.headers.get('content-type') || '',
    parsed,
  }
}

// 1. panel shell + modules
for (const file of [
  'index.html',
  'panel.css',
  'main.js',
  'welcome.js',
  'asset-urls.js',
  'transport.js',
  'audio-queue.js',
  'live2d.js',
  'placeholder.js',
  'views.js',
]) {
  const r = await head(`/amadeus/panel/${file}`)
  record(`panel/${file}`, r.ok, `${r.status} ${r.bytes}B`)
}

// 2. vendored, MIT-licensed runtime pieces
for (const file of [
  'pixi-7.4.2.min.js',
  'pixi-live2d-display-0.4.0-cubism2.min.js',
]) {
  const r = await head(`/amadeus/panel/vendor/${file}`)
  record(`vendor/${file}`, r.ok, `${r.status} ${r.bytes}B`)
}

// 3. asset status must report ready
const status = await head('/amadeus/assets/status', { json: true })
record('assets/status reachable', status.ok, `${status.status}`)
if (status.parsed) {
  record('assets ready', status.parsed.ready === true, `degrade=${status.parsed.degrade ?? 'none'}`)
  for (const pack of status.parsed.packs || []) {
    const ok = pack.kind === 'runtime' ? pack.installed && pack.matches : pack.installed
    record(`pack ${pack.id}`, ok, pack.kind === 'runtime' ? `hash ${pack.actualSha256?.slice(0, 12)}…` : `v${pack.version}`)
  }
}

// 4. the Cubism 2 core, served from the user-controlled cache
const runtimeName = status.parsed?.activeRuntime?.targetName || 'live2d.min.js'
const runtime = await head('/amadeus/assets/runtime/' + encodeURIComponent(runtimeName))
record(`runtime ${runtimeName}`, runtime.ok, `${runtime.status} ${runtime.bytes}B`)

// 5. everything the model setting file references
const modelName = status.parsed?.activeModel?.entryName
const modelRes = modelName
  ? await head('/amadeus/assets/current/' + modelName.split('/').map(encodeURIComponent).join('/'), { json: true })
  : { ok: false, status: 0, bytes: 0, parsed: null }
record(`model ${modelName || '(not configured)'}`, modelRes.ok, `${modelRes.status} ${modelRes.bytes}B`)

if (modelRes.parsed) {
  const model = modelRes.parsed
  const referenced = new Set()
  if (model.model) referenced.add(model.model)
  for (const t of model.textures || []) referenced.add(t)
  if (model.physics) referenced.add(model.physics)
  if (model.pose) referenced.add(model.pose)
  for (const e of model.expressions || []) if (e.file) referenced.add(e.file)
  for (const group of Object.values(model.motions || {})) {
    for (const m of group || []) if (m.file) referenced.add(m.file)
  }

  for (const rel of [...referenced].sort()) {
    const r = await head(`/amadeus/assets/current/${rel}`)
    record(`model file ${rel}`, r.ok, `${r.status} ${r.bytes}B`)
  }

  // motion sound files are extracted but intentionally not played in M4
  const soundRefs = new Set()
  for (const group of Object.values(model.motions || {})) {
    for (const m of group || []) if (m.sound) soundRefs.add(m.sound)
  }
  if (soundRefs.size > 0) {
    const r = await head(`/amadeus/assets/current/${[...soundRefs][0]}`)
    record(`motion sound (reserved, not played)`, r.ok, `${r.status} ${r.bytes}B`)
  }
}

// 6. cross-check that the runtime actually registers the Live2D model class
const pld = await fetch(base + '/amadeus/panel/vendor/pixi-live2d-display-0.4.0-cubism2.min.js', { headers: auth })
const pldText = await pld.text()
record('pld registers PIXI.live2d.Live2DModel', /live2d/.test(pldText) && /Live2DModel/.test(pldText), `${pldText.length}B`)

const core = await fetch(base + '/amadeus/assets/runtime/live2d.min.js', { headers: auth })
const coreText = await core.text()
record('cubism2 core looks like Live2D', (coreText.match(/Live2D/g) || []).length >= 3, `${coreText.length}B`)

// report
const width = Math.max(...rows.map((r) => r.label.length))
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(width)}  ${r.detail}`)
}
console.log(`\n${rows.length - failures}/${rows.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
