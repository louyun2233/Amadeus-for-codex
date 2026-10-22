import fs from 'node:fs'
import path from 'node:path'

/**
 * The sound a proactive call rings with.
 *
 * The panel used to show the incoming-call overlay with no sound of its own -
 * the only audio was her spoken line, so a slow or muted synthesis left the
 * call completely silent. The ring is now a real, separate file:
 *
 *   1. `<data>/sounds/incoming.<ext>` - dropped in by the user, wins outright
 *   2. `<data>/sounds/system-incoming.wav` - imported once, kept for offline use
 *   3. whatever the OS ships: the Windows mail notification is the default
 *
 * Everything here is best effort: a missing system sound degrades to "no ring"
 * and the panel falls back to a synthesized tone. Nothing throws.
 */

export const RING_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a']
export const MIN_RING_BYTES = 4 * 1024
export const MAX_RING_BYTES = 8 * 1024 * 1024

/** Only the call ring is enabled; legacy media requests cannot play speech clips. */
export const MEDIA_EFFECT_FILES = {}

export function mediaEffectPath(paths, event) {
  const name = Object.hasOwn(MEDIA_EFFECT_FILES, event) ? MEDIA_EFFECT_FILES[event] : null
  if (!name) return null
  const file = path.join(paths.dataRoot, 'sounds', 'kurisu-media', name)
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size >= MIN_RING_BYTES && stat.size <= MAX_RING_BYTES ? file : null
  } catch {
    return null
  }
}

/** A ring the user dropped in by hand, if any. */
export function userRingPath(dir) {
  for (const ext of RING_EXTENSIONS) {
    const candidate = path.join(dir, `incoming${ext}`)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size >= MIN_RING_BYTES && stat.size <= MAX_RING_BYTES) return candidate
    } catch {
      /* try the next extension */
    }
  }
  return null
}

/** Windows ships the mail/calendar/system notifications as plain WAV files. */
export function ringCandidates(env = process.env) {
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows'
  return [
    path.join(windir, 'Media', 'Windows Notify Email.wav'),
    path.join(windir, 'Media', 'Windows Notify Calendar.wav'),
    path.join(windir, 'Media', 'Windows Notify Messaging.wav'),
    path.join(windir, 'Media', 'notify.wav'),
  ]
}

export function contentTypeFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase()
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.m4a') return 'audio/mp4'
  return 'audio/wav'
}

/**
 * @returns {{ok: boolean, path: string|null, source: 'user'|'system'|'none', bytes: number, reason?: string}}
 */
export function ensureIncomingRing(paths, { env = process.env, copyFile = fs.copyFileSync } = {}) {
  const dir = path.join(paths.dataRoot, 'sounds')
  const imported = path.join(dir, 'system-incoming.wav')
  try {
    fs.mkdirSync(dir, { recursive: true })

    const user = userRingPath(dir)
    if (user) {
      const bytes = fs.statSync(user).size
      return { ok: true, path: user, source: 'user', bytes }
    }

    try {
      const stat = fs.statSync(imported)
      if (stat.isFile() && stat.size >= MIN_RING_BYTES && stat.size <= MAX_RING_BYTES) {
        return { ok: true, path: imported, source: 'system', bytes: stat.size }
      }
    } catch {
      /* not imported yet */
    }

    for (const candidate of ringCandidates(env)) {
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile() || stat.size < MIN_RING_BYTES || stat.size > MAX_RING_BYTES) continue
        copyFile(candidate, imported)
        const written = fs.statSync(imported).size
        if (written !== stat.size) {
          try {
            fs.unlinkSync(imported)
          } catch {
            /* a half copy is refused by the size check on the next run */
          }
          continue
        }
        return { ok: true, path: imported, source: 'system', bytes: written }
      } catch {
        /* the next candidate, or the fallback tone in the panel */
      }
    }
    return { ok: false, path: null, source: 'none', bytes: 0, reason: 'no-ring-source' }
  } catch (e) {
    return {
      ok: false,
      path: null,
      source: 'none',
      bytes: 0,
      reason: e && e.message ? e.message : String(e),
    }
  }
}
