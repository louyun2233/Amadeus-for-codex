import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * "Open the panel when Codex opens", without Codex hooks.
 *
 * The plugin-hook route depends on a Codex build that lists and trusts plugin
 * hooks - on the machine this was built for, /hooks stays empty. So the
 * connector launch is a tiny watcher process instead: it runs from the Startup
 * folder, notices when a Codex process appears, and brings the panel up once.
 *
 * Rules it must keep:
 *   - launch at most once per Codex presence (closing the panel is a decision,
 *     not something to undo every 3 seconds)
 *   - launching also works when Codex was already running before the watcher
 *     started (login order is not guaranteed)
 *   - a missing tasklist/pgrep must not throw; the watcher just never fires
 */

export const CODEX_IMAGES = ['ChatGPT.exe', 'Codex.exe', 'codex.exe']

/**
 * A short fingerprint of the installed Codex build.
 *
 * "Launch once per Codex presence" is not enough any more: a Codex update
 * replaces the app and the CLI under a *new* version directory, and if the
 * process never disappears for a full tick the watcher keeps its `launched`
 * latch and Amadeus is never brought back. Comparing this fingerprint lets the
 * watcher treat a new build as a new presence.
 *
 * Cheap by construction - two shallow directory listings, no process query -
 * and every failure path returns '' rather than throwing.
 */
export function codexSignature({ env = process.env, readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const parts = []
  const localAppData = env.LOCALAPPDATA || ''
  const binRoot = localAppData ? path.join(localAppData, 'OpenAI', 'Codex', 'bin') : null
  if (binRoot) {
    try {
      for (const name of readdir(binRoot).sort()) {
        try {
          parts.push(`bin:${name}@${Math.floor(stat(path.join(binRoot, name)).mtimeMs)}`)
        } catch {
          parts.push(`bin:${name}`)
        }
      }
    } catch {
      /* the CLI is not installed for this user */
    }
  }
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  try {
    for (const name of readdir(path.join(programFiles, 'WindowsApps')).filter((n) => n.startsWith('OpenAI.Codex_')).sort()) {
      parts.push(`appx:${name}`)
    }
  } catch {
    /* WindowsApps is usually not listable for a standard user */
  }
  if (parts.length === 0) return ''
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

/** Cheap name-based probe: `tasklist` on Windows, `pgrep` elsewhere. */
export function imageRunning(image, { spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      const probe = spawnSyncImpl(
        'tasklist',
        ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8', windowsHide: true },
      )
      return String(probe?.stdout || '').toLowerCase().includes(image.toLowerCase())
    }
    const probe = spawnSyncImpl('pgrep', ['-f', image.replace(/\.exe$/i, '')], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return probe?.status === 0
  } catch {
    return false
  }
}

export function detectCodex(options = {}) {
  return CODEX_IMAGES.some((image) => imageRunning(image, options))
}

/**
 * Rising-edge state machine. `launched` means "we already brought the panel up
 * during this Codex session".
 *
 * 'reset'   - Codex is gone, forget that we launched
 * 'seen'    - a panel is already connected, remember it so we do not open a second
 * 'launch'  - Codex is here and nothing owns a panel yet
 * 'revive'  - the panel window is probably still open but the daemon died
 * 'relaunch' - a different Codex build is running (an update landed): the
 *              connector has to come up again even though Codex never vanished
 * 'idle'    - nothing to do
 */
export function watchDecision({
  present,
  panelOpen,
  launched,
  daemonUp = true,
  signatureChanged = false,
  retryDue = false,
}) {
  if (!present) return 'reset'
  if (panelOpen) return 'seen'
  // A Codex update replaces the build under a new directory. Without this the
  // latch below would keep the panel closed until Codex is fully closed once.
  if (signatureChanged) return 'relaunch'
  if (!daemonUp) return launched ? 'revive' : 'launch'
  // We opened a window but it never connected (crash, killed browser, no
  // display): retry a bounded number of times instead of staying silent.
  if (retryDue) return 'launch'
  return launched ? 'idle' : 'launch'
}
