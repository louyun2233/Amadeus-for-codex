import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJson, writeJsonAtomic } from './store.mjs'
import { readTarGz, writeEntries } from './tar.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'

const logger = createChildLogger('[assets]')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_FILE = path.resolve(HERE, '..', '..', 'config', 'assets.registry.json')

const RETRY_PER_SOURCE = 3

export function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1024 * 256)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

/**
 * Only URLs declared in the registry may be fetched, and never over plain
 * HTTP unless the host is loopback. Callers can never pass a URL — the API
 * takes a pack id — so this closes the SSRF path entirely.
 */
export function assertAllowedUrl(rawUrl, allowedHosts) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `invalid source url: ${rawUrl}`)
  }
  const host = url.hostname.toLowerCase()
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopback) return url
  throw new AmadeusError(
    ErrorCode.INVALID_ARGUMENT,
    `refusing insecure or unexpected source: ${url.protocol}//${host}`,
  )
}

function extFor(format) {
  if (format === 'tar.gz' || format === 'tgz') return '.tar.gz'
  if (format === 'js') return '.js'
  return '.bin'
}

function safeModelEntry(entry) {
  return typeof entry === 'string' && entry.endsWith('.model.json') &&
    entry.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
}

function safePackSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

export class AssetManager {
  constructor({ paths, config, audit, hub, registryFile = REGISTRY_FILE }) {
    this.paths = paths
    this.config = config
    this.audit = audit
    this.hub = hub
    this.registryFile = registryFile
    this._registry = null
    this._installing = new Map()
  }

  registry() {
    if (this._registry) return this._registry
    const data = readJson(this.registryFile, null)
    if (!data || !Array.isArray(data.packs)) {
      throw new AmadeusError(ErrorCode.INTERNAL, `asset registry is missing or malformed: ${this.registryFile}`)
    }
    this._registry = data
    return data
  }

  pack(packId) {
    const found = this.registry().packs.find((p) => p.id === packId)
    if (!found) throw new AmadeusError(ErrorCode.NOT_FOUND, `unknown asset pack: ${packId}`)
    return found
  }

  // ---------------------------------------------------------------- locations

  characterDir(character) {
    return path.join(this.paths.modelsDir, character)
  }

  manifestFile(character) {
    return path.join(this.characterDir(character), 'manifest.json')
  }

  versionDir(character, version) {
    return path.join(this.characterDir(character), 'versions', version)
  }

  runtimeDir(engine) {
    return path.join(this.paths.runtimeCacheDir, engine)
  }

  #progress(packId, payload) {
    this.hub?.broadcast('assets:progress', { packId, ...payload })
  }

  // ------------------------------------------------------------------ status

  modelStatus(pack) {
    const manifest = readJson(this.manifestFile(pack.character), null)
    const current = manifest?.current || null
    const dir = current ? this.versionDir(pack.character, current) : null
    const entry = dir ? path.join(dir, pack.entry) : null
    return {
      id: pack.id,
      kind: pack.kind,
      character: pack.character,
      installed: Boolean(current && manifest?.sha256 === pack.sha256 && entry && fs.existsSync(entry)),
      version: current,
      expectedSha256: pack.sha256,
      installedAt: manifest?.installedAt || null,
      source: manifest?.source || null,
      fileCount: manifest?.fileCount || 0,
      entry: entry,
      entryName: pack.entry,
      engine: pack.engine,
      // Presentation hints live in the registry so framing can be tuned
      // without touching code — and must actually reach the panel.
      layout: pack.layout || null,
      expressionMap: pack.expressionMap || null,
      motionMap: pack.motionMap || null,
      parameterMap: pack.parameterMap || null,
      motionSounds: pack.motionSounds || null,
    }
  }

  runtimeStatus(pack) {
    const file = path.join(this.runtimeDir(pack.engine), pack.target)
    const installed = fs.existsSync(file)
    let actual = null
    if (installed) {
      try {
        actual = sha256File(file)
      } catch {
        actual = null
      }
    }
    return {
      id: pack.id,
      kind: pack.kind,
      engine: pack.engine,
      installed,
      path: file,
      targetName: pack.target,
      expectedSha256: pack.sha256,
      actualSha256: actual,
      matches: installed && actual === pack.sha256,
    }
  }

  status() {
    const packs = this.registry().packs.map((p) =>
      p.kind === 'model' ? this.modelStatus(p) : this.runtimeStatus(p),
    )
    const character = this.config?.getPath('character') || null
    const model = packs.find((p) => p.kind === 'model' && (!character || p.character === character))
    const runtime = packs.find((p) => p.kind === 'runtime' && p.engine === model?.engine)
    return {
      ok: true,
      packs,
      activeModel: model || null,
      activeRuntime: runtime || null,
      ready: Boolean(model?.installed && (!runtime || (runtime.installed && runtime.matches))),
      degrade: model?.installed
        ? !runtime || runtime?.installed
          ? null
          : 'missing-cubism2-runtime'
        : 'missing-model',
    }
  }

  /** Resolve a request path like `current/avatar.model.json` for the active character. */
  resolveCurrent(rel, character = this.config?.getPath('character') || 'kurisu') {
    const manifest = readJson(this.manifestFile(character), null)
    if (!manifest?.current) return null
    const base = this.versionDir(character, manifest.current)
    const target = path.resolve(base, rel)
    if (target !== base && !target.startsWith(base + path.sep)) return null
    return fs.existsSync(target) ? target : null
  }

  resolveRuntime(rel) {
    const character = this.config?.getPath('character') || null
    const model = this.registry().packs.find((p) => p.kind === 'model' && (!character || p.character === character))
    const pack = this.registry().packs.find((p) => p.kind === 'runtime' && p.engine === model?.engine)
    if (!pack) return null
    if (path.basename(rel) !== pack.target) return null
    const file = path.join(this.runtimeDir(pack.engine), pack.target)
    return fs.existsSync(file) ? file : null
  }

  // ---------------------------------------------------------------- download

  #destFile(pack) {
    return path.join(this.paths.downloadsDir, `${pack.id}-${pack.version}${extFor(pack.format)}`)
  }

  /**
   * Fetch a pack into the download cache. Returns the local file path.
   * Success requires a byte-for-byte SHA-256 match against the registry.
   */
  async download(packId, { force = false } = {}) {
    const pack = this.pack(packId)
    const dest = this.#destFile(pack)
    if (!force && fs.existsSync(dest) && sha256File(dest) === pack.sha256) {
      this.#progress(pack.id, { phase: 'cached', file: dest })
      return dest
    }

    const attempts = []
    for (const source of pack.sources) {
      let url
      try {
        url = assertAllowedUrl(source, pack.sources)
      } catch (e) {
        attempts.push({ source, error: e.message })
        continue
      }
      for (let i = 1; i <= RETRY_PER_SOURCE; i++) {
        try {
          await this.#fetchToFile(url, dest, pack)
          const actual = sha256File(dest)
          if (actual !== pack.sha256) {
            throw new AmadeusError(
              ErrorCode.UNAVAILABLE,
              `checksum mismatch (expected ${pack.sha256}, got ${actual})`,
              { degrade: 'source-content-changed' },
            )
          }
          this.audit?.record({
            source: 'assets',
            tool: 'assets.download',
            summary: `${pack.id} from ${url.host}`,
          })
          return dest
        } catch (e) {
          attempts.push({ source, attempt: i, error: e.message })
          logger.warn(`download attempt ${i} failed for ${pack.id}: ${e.message}`)
          if (e.code === ErrorCode.UNAVAILABLE && /checksum mismatch/.test(e.message)) break
          await new Promise((r) => setTimeout(r, 400 * i))
        }
      }
    }
    throw new AmadeusError(ErrorCode.UNAVAILABLE, `all sources failed for ${pack.id}`, {
      degrade: 'download_failed',
      detail: attempts,
    })
  }

  async #fetchToFile(url, dest, pack) {
    const part = `${dest}.part`
    let start = 0
    if (fs.existsSync(part)) {
      try {
        start = fs.statSync(part).size
      } catch {
        start = 0
      }
    }
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {}
    const res = await fetch(url, { headers, redirect: 'follow' })
    if (!res.ok && res.status !== 206) {
      throw new Error(`http ${res.status}`)
    }
    let mode = 'w'
    let offset = 0
    if (res.status === 206) {
      mode = 'a'
      offset = start
    } else if (start > 0) {
      // server ignored the range: restart from scratch
      mode = 'w'
      offset = 0
    }

    const expectedTotal =
      pack.sizeBytes && pack.sizeBytes > 0 ? pack.sizeBytes : Number(res.headers.get('content-length') || 0) + offset

    const fd = fs.openSync(part, mode)
    let received = offset
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        fs.writeSync(fd, value)
        received += value.length
        this.#progress(pack.id, {
          phase: 'download',
          source: url.host,
          received,
          total: expectedTotal || null,
        })
      }
    } finally {
      fs.closeSync(fd)
    }

    if (pack.sizeBytes && received !== pack.sizeBytes) {
      throw new Error(`size mismatch (expected ${pack.sizeBytes}, got ${received})`)
    }
    fs.renameSync(part, dest)
  }

  // ----------------------------------------------------------------- install

  async install(packId, options = {}) {
    const pack = this.pack(packId)
    if (this._installing.has(pack.id)) return this._installing.get(pack.id)
    const task = (pack.kind === 'model' ? this.#installModel(pack, options) : this.#installRuntime(pack, options))
      .finally(() => this._installing.delete(pack.id))
    this._installing.set(pack.id, task)
    return task
  }

  async installAll(options = {}) {
    const results = []
    for (const pack of this.registry().packs) {
      try {
        results.push({ id: pack.id, ...(await this.install(pack.id, options)) })
      } catch (e) {
        results.push({ id: pack.id, ok: false, error: e.message, degrade: e.degrade || null })
      }
    }
    return { ok: results.every((r) => r.ok !== false), results, status: this.status() }
  }

  async #installModel(pack, { force = false } = {}) {
    if (!safePackSegment(pack.id) || !safePackSegment(pack.character) ||
        !safePackSegment(pack.version) || !safePackSegment(pack.stripRoot) || !safeModelEntry(pack.entry)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `invalid model pack paths for ${pack.id}`)
    }
    this.#progress(pack.id, { phase: 'start' })
    const archivePath = await this.download(pack.id, { force })
    this.#progress(pack.id, { phase: 'extract' })

    const archive = readTarGz(fs.readFileSync(archivePath))
    const entryPath = `${pack.stripRoot}/${pack.entry}`
    if (!archive.files.some((f) => f.path === entryPath)) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        `archive does not contain ${entryPath}`,
        { degrade: 'unexpected-archive-layout' },
      )
    }

    const target = this.versionDir(pack.character, pack.version)
    const staging = `${target}.staging-${process.pid}`
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    try {
      const written = writeEntries(archive, staging, { strip: pack.stripRoot })
      const entryOnDisk = path.join(staging, pack.entry)
      if (!fs.existsSync(entryOnDisk)) {
        throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `entry missing after extraction: ${pack.entry}`)
      }
      const modelJson = JSON.parse(fs.readFileSync(entryOnDisk, 'utf8'))
      if (!modelJson.model || !Array.isArray(modelJson.textures)) {
        throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'model.json is not a Live2D model setting')
      }
      // swap in the new version
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(staging, target)
      writeJsonAtomic(this.manifestFile(pack.character), {
        current: pack.version,
        version: pack.version,
        sha256: pack.sha256,
        installedAt: Date.now(),
        source: archivePath,
        fileCount: written.length,
        entry: pack.entry,
        entryPoint: pack.engine,
      })
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw e
    }

    this.audit?.record({ source: 'assets', tool: 'assets.install', summary: pack.id })
    this.#progress(pack.id, { phase: 'done' })
    return { ok: true, ...this.modelStatus(pack) }
  }

  async #installRuntime(pack, { force = false } = {}) {
    this.#progress(pack.id, { phase: 'start' })
    const file = await this.download(pack.id, { force })
    const actual = sha256File(file)
    if (actual !== pack.sha256) {
      throw new AmadeusError(ErrorCode.UNAVAILABLE, `checksum mismatch for ${pack.id}`)
    }
    const dir = this.runtimeDir(pack.engine)
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, pack.target)
    const staging = `${target}.staging-${process.pid}`
    fs.copyFileSync(file, staging)
    fs.renameSync(staging, target)
    writeJsonAtomic(path.join(dir, 'manifest.json'), {
      version: pack.version,
      sha256: pack.sha256,
      installedAt: Date.now(),
      licenseNote: pack.licenseNote,
    })
    this.audit?.record({ source: 'assets', tool: 'assets.install', summary: pack.id })
    this.#progress(pack.id, { phase: 'done' })
    return { ok: true, ...this.runtimeStatus(pack) }
  }

  /** Install from a file the user already has (offline / self-supplied). */
  async installFromFile(packId, localFile) {
    const pack = this.pack(packId)
    if (!fs.existsSync(localFile)) {
      throw new AmadeusError(ErrorCode.NOT_FOUND, `file not found: ${localFile}`)
    }
    const actual = sha256File(localFile)
    if (actual !== pack.sha256) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        `local file checksum mismatch (expected ${pack.sha256}, got ${actual})`,
      )
    }
    fs.mkdirSync(this.paths.downloadsDir, { recursive: true })
    fs.copyFileSync(localFile, this.#destFile(pack))
    return this.install(packId)
  }

  verify() {
    const status = this.status()
    const problems = []
    for (const pack of status.packs) {
      if (pack.kind === 'runtime') {
        if (!pack.installed) problems.push({ id: pack.id, reason: 'not installed' })
        else if (!pack.matches) {
          problems.push({ id: pack.id, reason: `sha256 mismatch (${pack.actualSha256})` })
        }
      } else if (!pack.installed) {
        problems.push({ id: pack.id, reason: 'not installed' })
      } else {
        try {
          const model = JSON.parse(fs.readFileSync(path.join(this.versionDir(pack.character, pack.version), pack.entryName), 'utf8'))
          if (!model.model || !Array.isArray(model.textures)) {
            problems.push({ id: pack.id, reason: 'model.json malformed' })
          }
        } catch (e) {
          problems.push({ id: pack.id, reason: `model.json unreadable: ${e.message}` })
        }
      }
    }
    return { ok: problems.length === 0, problems, status }
  }
}
