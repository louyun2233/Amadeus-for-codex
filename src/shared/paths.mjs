import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { layoutDirectories, ensureOwnership } from './layout.mjs'

const APP_DIR_NAME = 'Amadeus'

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return ''
}

function defaultDataRoot() {
  const localAppData = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && localAppData) {
    return path.join(localAppData, APP_DIR_NAME)
  }
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, 'amadeus')
  return path.join(os.homedir(), '.local', 'share', 'amadeus')
}

function defaultCacheRoot() {
  const cacheHome = process.env.XDG_CACHE_HOME
  if (cacheHome) return path.join(cacheHome, 'amadeus')
  return path.join(defaultDataRoot(), 'cache')
}

/**
 * Where the cache used to live.
 *
 * `<home>/.cache/codex-runtimes/amadeus` sits inside a tree that belongs to
 * Codex, and Codex deletes that tree when it updates itself - the Live2D model
 * and the synthesized voice cache went with it, which is why the panel came
 * back as a placeholder after an update. Kept here only so an existing cache
 * can be moved once instead of re-downloaded.
 */
export function legacyCacheRoot(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME
  if (cacheHome) return path.join(cacheHome, 'codex-runtimes', 'amadeus')
  return path.join(os.homedir(), '.cache', 'codex-runtimes', 'amadeus')
}

export function resolvePaths(env = process.env) {
  const dataRoot = firstNonEmpty(env.AMADEUS_DATA_DIR, defaultDataRoot())
  const cacheRoot = firstNonEmpty(env.AMADEUS_CACHE_DIR, defaultCacheRoot())
  return {
    dataRoot,
    cacheRoot,
    configFile: path.join(dataRoot, 'config.json'),
    secretsFile: path.join(dataRoot, 'secrets.json'),
    sessionsDir: path.join(dataRoot, 'sessions'),
    memoryDir: path.join(dataRoot, 'memory'),
    auditFile: path.join(dataRoot, 'audit.jsonl'),
    logFile: path.join(dataRoot, 'amadeus.log'),
    runtimeDir: path.join(dataRoot, 'runtime'),
    daemonFile: path.join(dataRoot, 'runtime', 'daemon.json'),
    modelsDir: path.join(cacheRoot, 'models'),
    voiceCacheDir: path.join(cacheRoot, 'voices'),
    downloadsDir: path.join(cacheRoot, 'downloads'),
    runtimeCacheDir: path.join(cacheRoot, 'runtime'),
    tmpDir: path.join(dataRoot, 'tmp'),
  }
}

/** Copy anything we still want out of the old Codex-owned cache tree, once. */
export function migrateLegacyCache(paths, { env = process.env, copyFile = fs.copyFileSync } = {}) {
  const marker = path.join(paths.cacheRoot, 'migrated-from-codex-cache.json')
  try {
    if (fs.existsSync(marker)) return { moved: false, reason: 'already-migrated' }
    const legacy = legacyCacheRoot(env)
    if (path.resolve(legacy) === path.resolve(paths.cacheRoot)) return { moved: false, reason: 'same-root' }
    if (!fs.existsSync(legacy)) {
      fs.writeFileSync(marker, JSON.stringify({ from: legacy, at: Date.now(), copied: 0 }), { mode: 0o600 })
      return { moved: false, reason: 'absent' }
    }
    const budget = { files: 0, bytes: 0 }
    const copyMissing = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (budget.files >= 2000 || budget.bytes >= 512 * 1024 * 1024) return
        const source = path.join(from, entry.name)
        const target = path.join(to, entry.name)
        if (entry.isDirectory()) {
          fs.mkdirSync(target, { recursive: true })
          copyMissing(source, target)
          continue
        }
        if (fs.existsSync(target)) continue
        try {
          copyFile(source, target)
          budget.files += 1
          try {
            budget.bytes += fs.statSync(target).size
          } catch {
            /* size is only a budget hint */
          }
        } catch {
          /* a locked or unreadable file is not worth failing the startup for */
        }
      }
    }
    copyMissing(legacy, paths.cacheRoot)
    fs.writeFileSync(marker, JSON.stringify({ from: legacy, at: Date.now(), copied: budget.files }), {
      mode: 0o600,
    })
    return { moved: budget.files > 0, reason: 'copied', files: budget.files }
  } catch (e) {
    return { moved: false, reason: e && e.message ? e.message : String(e) }
  }
}

export function ensureDirs(paths) {
  // The directory list lives in one place (`layoutDirectories`) so an installer,
  // a checker or a future cleanup step cannot drift away from the runtime.
  for (const d of layoutDirectories(paths)) fs.mkdirSync(d, { recursive: true })
  migrateLegacyCache(paths)
  ensureOwnership(paths)
  return paths
}

export const PATHS = resolvePaths()
