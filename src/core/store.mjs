import fs from 'node:fs'
import path from 'node:path'
import { log } from '../shared/log.mjs'

/**
 * Dependency-free durable storage.
 *
 * Writes normally go through a temp file + rename, so a crash never leaves half
 * a JSON file behind. That assumption breaks on **EFS-encrypted** directories:
 * on Windows `%LOCALAPPDATA%` is encrypted for some users, and a rename inside
 * such a directory fails with `EXDEV: cross-device link not permitted` even
 * when source and destination are the same folder - every session, memory and
 * config write would then fail with a 500.
 *
 * So the first `EXDEV` per directory switches that directory to a copy-based
 * write (which works everywhere), and readers quarantine an unparseable file
 * instead of throwing, because a copy-based write cannot be atomic.
 */

const RENAME_BLOCKED = new Set()

const dirKey = (dir) => path.resolve(dir).toLowerCase()

/** Keep the broken file, but out of the way: renames may be refused here too. */
function quarantine(file) {
  const kept = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, kept)
    return kept
  } catch {
    /* encrypted directories refuse renames; copy instead */
  }
  try {
    fs.copyFileSync(file, kept)
    fs.unlinkSync(file)
    return kept
  } catch {
    return null
  }
}

export function readJson(file, fallback) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback
    throw e
  }
  if (raw.trim().length === 0) return fallback
  try {
    return JSON.parse(raw)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    const kept = quarantine(file)
    log.warn(
      `[store] ${path.basename(file)} was not valid JSON; ` +
        (kept ? `kept as ${path.basename(kept)}` : 'kept in place') +
        ' and treated as empty',
    )
    return fallback
  }
}

/** temp file + copy + unlink: works where rename does not. */
function writeViaCopy(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now()}.copying`
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    try {
      fs.copyFileSync(tmp, file)
    } catch {
      // Encrypted volumes can refuse copyFileSync (ENOENT onto a missing
      // target, UNKNOWN onto an existing one). A direct write is the last
      // resort; the reader quarantines a torn file, so this stays safe.
      fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* the temp file is harmless if it survives */
    }
  }
}

/**
 * `renameSync` is injectable so a test can reproduce the encrypted-directory
 * failure without needing an EFS volume.
 */
export function writeJsonAtomic(file, value, { renameSync = fs.renameSync } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const payload = JSON.stringify(value, null, 2)

  if (RENAME_BLOCKED.has(dirKey(dir))) {
    writeViaCopy(file, payload)
    return
  }

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (e) {
    if (!e || e.code !== 'EXDEV') {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* nothing else to do */
      }
      throw e
    }
    RENAME_BLOCKED.add(dirKey(dir))
    log.warn(
      `[store] renames are refused in ${dir} (${e.code}); ` +
        'using copy writes for this directory from now on',
    )
    try {
      fs.copyFileSync(tmp, file)
    } catch {
      fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* nothing else to do */
      }
    }
  }
}

export function appendJsonl(file, entry) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
}

export function readJsonl(file, limit = 0) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const slice = limit > 0 ? lines.slice(-limit) : lines
  const out = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip corrupt line rather than failing the whole read */
    }
  }
  return out
}

export function listFiles(dir, ext = '.json') {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f))
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch (e) {
    if (e && e.code === 'ENOENT') return false
    throw e
  }
}

/** Serialize async mutating work on the same key inside one process. */
const locks = new Map()
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    key,
    next.catch(() => {}).finally(() => {
      if (locks.get(key) === next || locks.get(key) === undefined) locks.delete(key)
    }),
  )
  return next
}
