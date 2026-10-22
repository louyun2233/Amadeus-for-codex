import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const READY_URL = 'http://127.0.0.1:7860/v1/models'
const START_TIMEOUT_MS = 60000
const EXIT_GRACE_MS = 8000
let startup = null

async function ready() {
  try {
    const response = await fetch(READY_URL, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return false
    const body = await response.json()
    return Array.isArray(body?.data)
  } catch {
    return false
  }
}

function launchSettings(paths, report = () => {}) {
  const file = path.join(paths.dataRoot, 'qwen-service.json')
  let settings
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    report('config-unreadable')
    return null
  }
  const python = settings?.python
  const script = settings?.script
  if (typeof python !== 'string' || typeof script !== 'string') { report('config-invalid'); return null }
  if (!path.isAbsolute(python) || !path.isAbsolute(script)) { report('config-path-relative'); return null }
  if (!fs.existsSync(python)) { report('python-missing'); return null }
  if (!fs.existsSync(script)) { report('script-missing'); return null }
  return { python, script }
}

/** Start only an explicitly configured, local Qwen installation. Never switch voices. */
export async function ensureLocalQwen(paths, {
  timeoutMs = START_TIMEOUT_MS,
  exitGraceMs = EXIT_GRACE_MS,
  pollMs = 1000,
  readyCheck = ready,
  spawnProcess = spawn,
  onStatus = () => {},
} = {}) {
  const report = (phase) => { try { onStatus(phase) } catch { /* diagnostics must not block voice */ } }
  if (await readyCheck()) { report('already-ready'); return true }
  if (startup) return startup
  startup = (async () => {
    const settings = launchSettings(paths, report)
    if (!settings) return false
    const child = spawnProcess(settings.python, [
      settings.script,
      '--api', '--nowebui', '--no-inbrowser',
      '--server-name', '127.0.0.1', '--server-port', '7860', '--skip-check',
    ], {
      cwd: path.dirname(settings.script),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    let launchError = null
    child.on('error', (error) => { launchError = error; report(`spawn-error:${error.code || 'unknown'}`) })
    child.unref()
    report('spawned')
    const deadline = Date.now() + timeoutMs
    let exitGraceDeadline = null
    while (Date.now() < deadline) {
      if (await readyCheck()) { report('ready'); return true }
      if (launchError || child.exitCode !== null) {
        // Another process may have grabbed port 7860 first and still be
        // starting. Its API can become ready after our duplicate exits.
        exitGraceDeadline ??= Date.now() + exitGraceMs
        if (Date.now() >= exitGraceDeadline) {
          report(launchError ? 'spawn-failed' : `child-exited:${child.exitCode}`)
          return false
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    report('timeout')
    return false
  })()
  try {
    return await startup
  } finally {
    startup = null
  }
}
