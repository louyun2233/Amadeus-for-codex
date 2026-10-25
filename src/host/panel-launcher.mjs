import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureDaemon } from './daemon-client.mjs'

const LAUNCH_COOLDOWN_MS = 5000

function launchLockFile(paths) {
  return paths?.dataRoot ? path.join(paths.dataRoot, 'runtime', 'panel-launch.lock') : null
}

export function launchInFlight(paths, { now = Date.now() } = {}) {
  const file = launchLockFile(paths)
  if (!file) return false
  try {
    return now - fs.statSync(file).mtimeMs < LAUNCH_COOLDOWN_MS
  } catch {
    return false
  }
}

function noteLaunch(paths) {
  const file = launchLockFile(paths)
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // An unwritable lock file must not prevent the panel from opening.
  }
}

export async function panelIsOpen(info) {
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/status`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return false
    const body = await res.json()
    return (body?.events?.nativeClients || 0) > 0
  } catch {
    return false
  }
}

export async function panelAnswers(info) {
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

export function nativeWindowExecutable() {
  if (process.platform !== 'win32') return null
  const exe = fileURLToPath(new URL('../../Amadeus.exe', import.meta.url))
  const stamp = path.join(path.dirname(exe), 'Amadeus.native')
  try {
    return fs.existsSync(exe) && fs.readFileSync(stamp, 'utf8').trim() === 'qt-opengl' ? exe : null
  } catch {
    return null
  }
}

export function nativeWindowArgs() {
  return ['--panel-stdin']
}

export function openNativeWindow(exe, info, { welcome = false } = {}) {
  // The token crosses stdin only; it is absent from process command lines.
  const address = `http://127.0.0.1:${info.port}/amadeus/native?token=${info.token}${welcome ? '#welcome=1' : ''}`
  const child = spawn(exe, nativeWindowArgs(), {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: false,
  })
  child.stdin.on('error', () => {})
  child.stdin.end(`${address}\n`)
  child.unref()
}

export async function openPanel({ paths, force = false, browser = false, ensure = true, welcome = false } = {}) {
  if (browser) return { ok: false, status: 'browser-disabled' }
  let info = ensure ? await ensureDaemon(paths) : null
  if (!info) return { ok: false, status: 'daemon-unavailable' }
  if (!force && (await panelIsOpen(info))) return { ok: true, status: 'already-open', info }
  if (!force && launchInFlight(paths)) return { ok: true, status: 'launching', info }
  if (!(await panelAnswers(info))) {
    info = await ensureDaemon(paths)
    if (!(await panelAnswers(info))) return { ok: false, status: 'panel-unreachable', info }
  }
  const native = nativeWindowExecutable()
  if (!native) return { ok: false, status: 'native-unavailable', info }
  noteLaunch(paths)
  openNativeWindow(native, info, { welcome })
  return { ok: true, status: 'window', info }
}
