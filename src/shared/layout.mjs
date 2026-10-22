import fs from 'node:fs'
import path from 'node:path'

/**
 * One declaration of where everything lives, plus an ownership marker.
 *
 * Learned from Code-Codex's `Storage-Layout.ps1`: the directory list existed in
 * three places (installer, uninstaller, finalizer) and they drifted, so it
 * lives in one module here and the marker file records *whose* directory this
 * is. `ensureDirs()` writes the marker; anything that later wants to clean up
 * can require it instead of trusting the path.
 *
 * Deliberately no deletion logic: the marker is only a statement of ownership.
 */

export const PRODUCT = 'Amadeus for Codex'
export const LAYOUT_SCHEMA = 1
export const OWNERSHIP_FILE = 'storage-layout.json'

/** Every directory this project owns under the data root / cache root. */
export function layoutDirectories(paths) {
  return [
    paths.dataRoot,
    paths.sessionsDir,
    paths.memoryDir,
    paths.runtimeDir,
    paths.tmpDir,
    path.join(paths.dataRoot, 'sounds'),
    path.join(paths.dataRoot, 'diagnostics'),
    paths.cacheRoot,
    paths.modelsDir,
    paths.voiceCacheDir,
    paths.downloadsDir,
    paths.runtimeCacheDir,
  ]
}

export function ownershipPath(paths) {
  return path.join(paths.dataRoot, OWNERSHIP_FILE)
}

export function readOwnership(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownershipPath(paths), 'utf8'))
    if (!parsed || parsed.product !== PRODUCT || parsed.schema !== LAYOUT_SCHEMA) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Write the marker when it is missing or belongs to another product/schema.
 * Best effort: a read-only directory degrades to "not owned", never a crash.
 */
export function ensureOwnership(paths, { version = null } = {}) {
  const existing = readOwnership(paths)
  if (existing) return existing
  const marker = {
    product: PRODUCT,
    schema: LAYOUT_SCHEMA,
    version: version || null,
    createdAt: Date.now(),
    dataRoot: paths.dataRoot,
    cacheRoot: paths.cacheRoot,
  }
  try {
    fs.mkdirSync(paths.dataRoot, { recursive: true })
    fs.writeFileSync(ownershipPath(paths), JSON.stringify(marker, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    /* the marker is bookkeeping; a failure must not stop the daemon */
  }
  return marker
}
