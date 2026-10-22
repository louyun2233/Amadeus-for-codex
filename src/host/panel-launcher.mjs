import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { ensureDaemon } from './daemon-client.mjs'

/**
 * Bring the companion panel up as its own application window.
 *
 * Callers: `amadeus open`, the double-clickable `Amadeus.exe`, and the watcher
 * that waits for Codex to appear. Chromium's `--app=` gives a window with no
 * tabs and no address bar, which is as close to a native companion window as
 * this project gets without shipping a browser engine.
 */

const BROWSERS = [
  process.env.AMADEUS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

export function findBrowser() {
  return (
    BROWSERS.find((candidate) => {
      try {
        return fs.existsSync(candidate)
      } catch {
        return false
      }
    }) || null
  )
}

/** A connected panel already owns a window; a second one would duplicate audio. */
export async function panelIsOpen(info) {
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/status`, {
      headers: { Authorization: `Bearer ${info.token}` },
    })
    if (!res.ok) return false
    const body = await res.json()
    return (body?.events?.clients || 0) > 0
  } catch {
    return false
  }
}

export function openTab(url) {
  const [bin, binArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(bin, binArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/**
 * A small chromeless popup sized for the phone, not a full-height window: the
 * panel is a companion that should sit next to your work, not cover it.
 * Override with AMADEUS_PANEL_SIZE=W,H.
 */
// A phone, not a billboard: ~300x520 logical px, and the page shrinks it
// further when the screen cannot spare the height.
export const PANEL_WINDOW_SIZE = process.env.AMADEUS_PANEL_SIZE || '300,520'

/**
 * How long a launch counts as "already on its way".
 *
 * A panel is only "open" once *its page* has connected to the daemon, which
 * takes a second or two. Two callers inside that window - Codex appearing while
 * the user double-clicks the launcher, or the watcher ticking while the startup
 * shortcut runs - both pass `panelIsOpen()` and both spawn a browser. Chromium
 * answers the second spawn by adding a window to the first process, and what
 * the user gets is the phone plus an empty window poking out behind it.
 */
const LAUNCH_COOLDOWN_MS = 5000

function launchLockFile(paths) {
  return paths?.dataRoot ? path.join(paths.dataRoot, 'runtime', 'panel-launch.lock') : null
}

/** True when another caller started a window moments ago. */
export function launchInFlight(paths, { now = Date.now() } = {}) {
  const file = launchLockFile(paths)
  if (!file) return false
  try {
    return now - fs.statSync(file).mtimeMs < LAUNCH_COOLDOWN_MS
  } catch {
    return false
  }
}

/** Remember this launch. Never throws: a failed note must not block the panel. */
function noteLaunch(paths) {
  const file = launchLockFile(paths)
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* the window is worth more than the bookkeeping */
  }
}

/**
 * How the browser process is started.
 *
 * `windowsHide` has to stay `false`. It reads like the careful choice - no
 * console window flashes - but on Windows it also sets STARTUPINFO's SW_HIDE,
 * and Chromium applies that to its first window. The panel was therefore
 * created *invisibly*: the daemon counted a connected client, the process list
 * showed a correctly sized window, and the user saw nothing at all.
 * msedge.exe / chrome.exe are GUI-subsystem programs, so leaving the flag off
 * still means no console window.
 */
export const BROWSER_SPAWN_OPTIONS = { detached: true, stdio: 'ignore', windowsHide: false }

/** The argument list for the chromeless panel window, minus the executable. */
export function appWindowArgs(url, { size = PANEL_WINDOW_SIZE, profileDir = null } = {}) {
  const windowArgs = [
    '--app=' + url,
    `--window-size=${size}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Without this the window refuses to play her voice until the user clicks
    // somewhere: "task finished" then looks like silence.
    '--autoplay-policy=no-user-gesture-required',
  ]
  if (profileDir) {
    // Its own profile, so the window is created by a fresh browser process:
    // a running Edge would silently ignore --window-size and hand us a huge
    // default window (which then stretched the phone).
    windowArgs.push(`--user-data-dir=${profileDir}`)
  }
  return windowArgs
}

export function openAppWindow(exe, url, options = {}) {
  spawn(exe, appWindowArgs(url, options), BROWSER_SPAWN_OPTIONS).unref()
}

/**
 * Which processes are *our* panel browsers?
 *
 * Chromium treats `--autoplay-policy` as a browser-process switch. If an older
 * panel process is still alive, the new window is created *by that process*
 * and inherits its policy - which is why a freshly launched window still
 * refused to speak. We only ever get here when no panel is connected, so any
 * process on our profile directory is a leftover.
 *
 * Identity is checked before anything is killed, learned from Code-Codex's
 * process guard: the old version killed every process whose command line
 * merely *contained* the profile path, which meant a support shell that
 * happened to mention that path died with it. Now it has to be a browser image
 * *and* carry the profile as the `--user-data-dir` argument.
 */
export const BROWSER_IMAGES = ['msedge.exe', 'chrome.exe', 'brave.exe']
export const PROFILE_FLAG = '--user-data-dir='

export function isOurPanelBrowser(entry, profileDir) {
  const name = String(entry?.name ?? entry?.Name ?? '').toLowerCase()
  if (!BROWSER_IMAGES.includes(name)) return false
  const line = String(entry?.commandLine ?? entry?.CommandLine ?? '')
  const dir = String(profileDir || '')
  if (!dir || !line) return false
  // The path has to be the whole argument: a sibling directory that merely
  // starts with the same characters (`panel-profile-old`) is not ours.
  for (const form of [`${PROFILE_FLAG}${dir}`, `${PROFILE_FLAG}"${dir}"`]) {
    const at = line.indexOf(form)
    if (at < 0) continue
    const after = line[at + form.length]
    if (after === undefined || after === ' ' || after === '\t' || after === '"') return true
  }
  return false
}

/** Every browser process on this machine, with its command line. */
function queryBrowserProcesses() {
  const filter = BROWSER_IMAGES.map((n) => `Name='${n}'`).join(' or ')
  const script =
    `$rows = Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Select-Object Name,ProcessId,CommandLine; ` +
    `[Console]::Out.Write(($rows | ConvertTo-Json -Compress -Depth 3))`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function killProcesses(pids) {
  const list = pids.join(',')
  const script =
    `$count = 0; foreach ($targetId in @(${list})) { ` +
    `try { Stop-Process -Id $targetId -Force -ErrorAction Stop; $count++ } catch {} }; ` +
    `[Console]::Out.Write($count)`
  return Number(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim(),
  )
}

export function killStalePanelBrowsers(
  profileDir,
  { platform = process.platform, query = queryBrowserProcesses, kill = killProcesses } = {},
) {
  if (platform !== 'win32' || !profileDir) return 0
  let candidates
  try {
    candidates = query()
  } catch {
    return 0
  }
  const pids = [
    ...new Set(
      candidates
        .filter((entry) => isOurPanelBrowser(entry, profileDir))
        .map((entry) => Number(entry.processId ?? entry.ProcessId))
        .filter((id) => Number.isInteger(id) && id > 0 && id !== process.pid),
    ),
  ]
  if (pids.length === 0) return 0
  try {
    return kill(pids)
  } catch {
    return 0
  }
}

export function panelUrl(info, { app = false, welcome = false } = {}) {
  // `#app` switches the page into "the phone is the window" layout. It is a
  // fragment on purpose: the token exchange 302s to a clean URL, and a fragment
  // is the one part of the URL that survives that redirect.
  //
  // The requested size travels in the fragment too (`#app-336x656`): Chromium
  // ignores --window-size often enough (an existing browser process, a restored
  // profile) that the page also resizes itself once it is running.
  const size = PANEL_WINDOW_SIZE.replace(',', 'x')
  return (
    `http://127.0.0.1:${info.port}/amadeus/panel/index.html?token=${info.token}` +
    (app ? `#app-${size}${welcome ? '&welcome=1' : ''}` : welcome ? '#welcome=1' : '')
  )
}

/**
 * Does the panel entry actually answer on this daemon?
 *
 * The token is exchanged for a cookie via a 302, and `fetch` here keeps no
 * cookie jar - following that redirect would land on an authenticated page
 * without a session and report a false "unreachable". So the redirect itself
 * is the success signal.
 */
export async function panelAnswers(info) {
  if (!info) return false
  try {
    const res = await fetch(panelUrl(info), {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

/**
 * Ensure the daemon, then show the panel unless one is already connected.
 * Returns a short status string for the caller to print.
 */
export async function openPanel({ paths, force = false, browser = false, ensure = true, welcome = false } = {}) {
  let info = ensure ? await ensureDaemon(paths) : null
  if (!info) return { ok: false, status: 'daemon-unavailable' }
  if (!force && (await panelIsOpen(info))) return { ok: true, status: 'already-open', info }
  // A window that was spawned a moment ago has not connected yet, so it is
  // invisible to `panelIsOpen`. Without this guard both callers open a window.
  if (!force && launchInFlight(paths)) return { ok: true, status: 'launching', info }

  // Never open a window onto a dead port: that is a grey browser error page
  // with no way back. Ask for the panel HTML first (the token exchange answers
  // with a 302, which fetch follows successfully).
  if (!(await panelAnswers(info))) {
    info = await ensureDaemon(paths)
    if (!(await panelAnswers(info))) return { ok: false, status: 'panel-unreachable', info }
  }

  const exe = browser ? null : findBrowser()
  if (exe) {
    const profileDir = paths?.dataRoot ? path.join(paths.dataRoot, 'panel-profile') : null
    noteLaunch(paths)
    if (profileDir) {
      const killed = killStalePanelBrowsers(profileDir)
      // Spawning into a process that is still dying makes Chromium hand back a
      // small, never-navigated window next to the panel. Give the leftovers a
      // moment to release the profile before the new one starts.
      if (killed > 0) await new Promise((r) => setTimeout(r, 600))
    }
    openAppWindow(exe, panelUrl(info, { app: true, welcome }), { profileDir })
    return { ok: true, status: 'window', info }
  }
  openTab(panelUrl(info, { welcome }))
  return { ok: true, status: 'tab', info }
}
