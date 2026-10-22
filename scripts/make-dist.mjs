#!/usr/bin/env node
/**
 * Build the distributable zip.
 *
 * Node has no zip writer and adding a dependency for one archive format is not
 * worth it, so this writes a minimal ZIP (deflate) directly. The file list comes
 * from config/dist-manifest.json, which the installer also reads — one source of
 * truth, checked by tests/dist.test.mjs.
 *
 * Usage: node scripts/make-dist.mjs [--out <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outDir = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(ROOT, 'dist')

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'dist-manifest.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// ---------------------------------------------------------------- collection

const excluded = new Set(manifest.exclude.map((p) => p.replace(/\\/g, '/')))

function isExcluded(rel) {
  const norm = rel.replace(/\\/g, '/')
  for (const ex of excluded) {
    if (norm === ex || norm.startsWith(ex + '/')) return true
  }
  return false
}

function collect(rel) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    throw new Error(`dist manifest lists a path that does not exist: ${rel}`)
  }
  const stat = fs.statSync(abs)
  if (stat.isFile()) {
    if (isExcluded(rel)) return []
    return [{ rel: rel.replace(/\\/g, '/'), abs, size: stat.size }]
  }
  const out = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name)
    if (isExcluded(childRel)) continue
    if (entry.isDirectory()) out.push(...collect(childRel))
    else if (entry.isFile()) {
      const childAbs = path.join(ROOT, childRel)
      out.push({ rel: childRel.replace(/\\/g, '/'), abs: childAbs, size: fs.statSync(childAbs).size })
    }
  }
  return out
}

const files = []
for (const rel of manifest.include) files.push(...collect(rel))
files.push({
  rel: 'VERSION',
  abs: null,
  size: Buffer.byteLength(pkg.version),
  inline: Buffer.from(pkg.version, 'utf8'),
})

// Everything lives under one top-level folder so extracting the archive cannot
// scatter bin/, src/ and config/ into whatever directory the user is in.
const prefix = `${pkg.name}-${pkg.version}`
for (const file of files) file.rel = `${prefix}/${file.rel}`

// requiredForInstall must actually be in the archive
const present = new Set(files.map((f) => f.rel.slice(prefix.length + 1)))
const missing = manifest.requiredForInstall.filter((r) => !present.has(r))
if (missing.length > 0) {
  throw new Error(`required files are not included in the archive:\n  ${missing.join('\n  ')}`)
}

// ------------------------------------------------------ credential gate
// The package is handed to other people: it must not carry a key, and it must
// never carry runtime data (secrets.json and friends). Conversation does not
// need one - the default channel is `codex-exec`, i.e. the other person's own
// Codex login.
const { scanFiles } = await import('./portable-scan.mjs')
const credentials = scanFiles(files, { strict: true })
if (credentials.length > 0) {
  throw new Error(
    'refusing to package credential material:\n  ' +
      credentials.map((p) => `${p.rel} (${p.hits.join('; ')})`).join('\n  '),
  )
}

// ------------------------------------------------------------------ zip write

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function buildZip(entries) {
  const { time, date } = dosDateTime()
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const raw = entry.inline ?? fs.readFileSync(entry.abs)
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const nameBuf = Buffer.from(entry.rel, 'utf8')
    const crc = crc32(raw)
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, eocd])
}

// ---------------------------------------------------------------------- write

files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
const zip = buildZip(files)

fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `amadeus-codex-${pkg.version}.zip`)
fs.writeFileSync(outFile, zip)

/**
 * The same file set, but as an unpacked directory for the Codex marketplace.
 *
 * `codex plugin marketplace add <dir>` copies whatever is under the plugin
 * path, and our plugin path is the repository root - which also holds
 * node_modules/, work/ and the zips. Publishing this directory instead keeps
 * the installed copy to what actually ships (about a megabyte).
 */
const mktDir = path.join(outDir, 'marketplace')
if (path.dirname(path.resolve(mktDir)) !== path.resolve(outDir)) {
  throw new Error(`refusing to refresh a marketplace dir outside ${outDir}`)
}
fs.rmSync(mktDir, { recursive: true, force: true })
for (const file of files) {
  const rel = file.rel.slice(prefix.length + 1)
  const dest = path.join(mktDir, rel)
  if (path.resolve(dest).startsWith(path.resolve(mktDir) + path.sep) === false) {
    throw new Error(`refusing to write outside the marketplace dir: ${rel}`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, file.inline ?? fs.readFileSync(file.abs))
}

const bytes = files.reduce((sum, f) => sum + (f.size || 0), 0)
console.log(`packed ${files.length} files (${(bytes / 1024).toFixed(0)} KiB raw) -> ${outFile}`)
console.log(`archive size: ${(zip.length / 1024).toFixed(0)} KiB`)
console.log(`marketplace dir: ${mktDir}`)
