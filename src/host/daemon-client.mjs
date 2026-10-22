import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { log } from '../shared/log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DAEMON_ENTRY = path.join(ROOT, 'bin', 'amadeus-daemon.mjs')

/** Signal 0 is a pure existence probe; EPERM still means "it is there". */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

export function readDaemonInfo(paths, { checkPid = processAlive } = {}) {
  try {
    const info = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
    if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null
    // A pointer to a dead process is not a daemon. Trusting it used to leave
    // every client stuck on a port nobody listens on - the panel then never
    // came up and the connector looked broken after a reboot.
    if (info.pid && !checkPid(info.pid)) return null
    return info
  } catch {
    return null
  }
}

export async function ping(info, timeoutMs = 1500) {
  if (!info) return false
  try {
    const ac = AbortSignal.timeout(timeoutMs)
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: ac,
    })
    return res.ok
  } catch {
    return false
  }
}

export function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child
}

/** Atomic across the watcher, MCP connector and EXE launcher processes. */
export function acquireDaemonLaunchLock(paths) {
  fs.mkdirSync(paths.runtimeDir, { recursive: true })
  const file = path.join(paths.runtimeDir, 'daemon-launch.lock')
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // A crashed launcher can leave the lock behind. Reclaim only this exact
    // file, never the runtime directory, and never a live launcher's lock.
    try {
      const stat = fs.statSync(file)
      let owner = null
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* writer may still be filling it */ }
      const abandoned = owner?.pid ? !processAlive(owner.pid) : Date.now() - stat.mtimeMs > 5000
      if (abandoned) fs.unlinkSync(file)
    } catch { /* another launcher may have removed it already */ }
    return null
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
  return () => {
    try { fs.closeSync(fd) } catch { /* already closed */ }
    try { fs.unlinkSync(file) } catch { /* already removed */ }
  }
}

/** Ensure a live daemon exists; start one if necessary. */
/**
 * 30s, not 15s: the first launch after a fresh copy can take that long on
 * Windows while Defender scans the just-written files, and a false
 * "did not become ready in time" makes a working daemon look broken. The MCP
 * registration uses the same 30s budget.
 */
export async function ensureDaemon(paths, { autoStart = true, timeoutMs = 30000 } = {}) {
  const existing = readDaemonInfo(paths)
  if (existing && (await ping(existing))) return existing

  if (!autoStart) {
    throw new AmadeusError(ErrorCode.UNAVAILABLE, 'daemon is not running', {
      degrade: 'run `amadeus start`',
    })
  }

  const deadline = Date.now() + timeoutMs
  let release = null
  try {
    while (Date.now() < deadline) {
      const info = readDaemonInfo(paths)
      if (info && (await ping(info))) return info
      if (!release) {
        release = acquireDaemonLaunchLock(paths)
        if (release) {
          // A different launcher may have won just before we got the lock.
          const current = readDaemonInfo(paths)
          if (current && (await ping(current))) return current
          log.info('[daemon-client] starting daemon...')
          spawnDaemon()
        }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  } finally {
    release?.()
  }
  throw new AmadeusError(ErrorCode.UNAVAILABLE, 'daemon did not become ready in time')
}

export async function callDaemon(paths, method, apiPath, body) {
  const info = await ensureDaemon(paths)
  const url = `http://127.0.0.1:${info.port}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${info.token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { ok: res.ok, raw: text.slice(0, 300) }
  }
  if (!res.ok && parsed && parsed.ok !== false) parsed.ok = false
  return { status: res.status, body: parsed, info }
}
