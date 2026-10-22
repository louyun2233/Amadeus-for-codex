#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import { ensureDaemon, callDaemon, readDaemonInfo, ping } from '../src/host/daemon-client.mjs'
import { readJsonl } from '../src/core/store.mjs'
import { redactValue, redactLogLine } from '../src/core/redact.mjs'
import { readOwnership, PRODUCT } from '../src/shared/layout.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = path.join(HERE, 'amadeus-daemon.mjs')
const PANEL_ENTRY = path.join(HERE, 'amadeus-panel.mjs')
const paths = ensureDirs(resolvePaths())

const cmd = process.argv[2] || 'status'
const args = process.argv.slice(3)

function panelUrl(info) {
  return `http://127.0.0.1:${info.port}/amadeus/panel/index.html?token=${info.token}`
}

function printUsage() {
  console.log(
    [
      'Amadeus for Codex',
      '',
      'Usage: amadeus <command>',
      '',
      '  start [--open]   start the daemon (and optionally open the panel)',
      '  stop             stop the daemon',
      '  status           show daemon status (default)',
      '  open             open the panel window [--browser for a tab]',
      '  url              print the one-time panel URL',
      '  doctor [--deep]  run capability diagnostics',
        '  report           write a redacted support report and print its path',
      '  sessions         list companion sessions',
      '  assets [...]     status | install [packId] [--force] | verify',
      '  logs             print data locations',
      '  help             show this help',
    ].join('\n'),
  )
}

/**
 * The panel opens as its own application window by default; `--browser` keeps
 * the old behaviour for anyone who prefers a tab.
 */
function openPanel(extra = []) {
  const child = spawn(process.execPath, [PANEL_ENTRY, ...extra], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

async function ensureInfo() {
  const existing = readDaemonInfo(paths)
  if (existing && (await ping(existing))) return existing
  return ensureDaemon(paths)
}

/**
 * The artefact you attach to a bug report.
 *
 * Learned from Code-Codex's "copy or open a local redacted report": everything
 * useful (codes, ports, timings, config *shape*, log tails) and nothing that
 * identifies the user (prompt text, paths, keys). Written next to the data,
 * never uploaded anywhere.
 */
async function writeReport() {
  const info = await ensureInfo()
  const auth = { Authorization: `Bearer ${info.token}` }
  const get = async (apiPath) => {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${apiPath}`, { headers: auth })
      return await res.json()
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }
  }
  const tail = (file, lines = 20) => {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(-lines)
        .map((line) => redactLogLine(line))
    } catch {
      return []
    }
  }

  const report = {
    product: PRODUCT,
    generatedAt: new Date().toISOString(),
    daemon: { port: info.port, pid: info.pid, version: info.version || null },
    layout: readOwnership(paths),
    diag: redactValue(await get('/amadeus/diag?deep=1')),
    status: redactValue(await get('/amadeus/status')),
    clientReports: redactValue((await get('/amadeus/logs?limit=50')).client || []),
    // The audit *on disk* keeps a short summary of what happened; the report is
    // the artefact that gets pasted somewhere, so it keeps only the shape of
    // the trail (when, which tool, how it went) and drops the summaries -
    // otherwise remembered facts and chat lines would travel with it.
    audit: (readJsonl(paths.auditFile, 50) || []).map((row) => ({
      ts: row?.ts ?? null,
      source: row?.source ?? '',
      tool: row?.tool ?? '',
      undo: row?.undo ?? null,
    })),
    notifyLog: tail(path.join(paths.dataRoot, 'notify.log')),
    watchLog: tail(path.join(paths.dataRoot, 'watch.log')),
  }

  const dir = path.join(paths.dataRoot, 'diagnostics')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `amadeus-report-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

async function main() {
  switch (cmd) {
    case 'start': {
      const info = await ensureInfo()
      const opened = args.includes('--open')
      console.log(`Amadeus daemon ready on http://127.0.0.1:${info.port} (pid ${info.pid})`)
      if (opened) openPanel(args.includes('--browser') ? ['--browser'] : [])
      break
    }
    case 'stop': {
      const info = readDaemonInfo(paths)
      if (!info || !(await ping(info))) {
        console.log('Amadeus daemon is not running.')
        break
      }
      await callDaemon(paths, 'POST', '/amadeus/action', { cmd: 'shutdown' })
      console.log('Amadeus daemon stopping.')
      break
    }
    case 'status': {
      const info = readDaemonInfo(paths)
      if (!info || !(await ping(info))) {
        console.log('Amadeus daemon is not running.  →  amadeus start')
        break
      }
      const { body } = await callDaemon(paths, 'GET', '/amadeus/status')
      console.log(JSON.stringify(body, null, 2))
      break
    }
    case 'open': {
      const info = await ensureInfo()
      openPanel(args.includes('--browser') ? ['--browser'] : [])
      console.log(`Opening panel: http://127.0.0.1:${info.port}/amadeus/panel/`)
      break
    }
    case 'url': {
      const info = await ensureInfo()
      console.log(panelUrl(info))
      break
    }
    case 'doctor': {
      const deep = args.includes('--deep')
      const info = await ensureInfo()
      const { body } = await callDaemon(paths, 'GET', `/amadeus/diag${deep ? '?deep=1' : ''}`)
      console.log(JSON.stringify(body, null, 2))
      break
    }
    case 'sessions': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/sessions')
      for (const s of body.sessions || []) {
        console.log(`${s.id}  ${new Date(s.updatedAt).toISOString()}  ${s.messageCount} msgs  ${s.name}`)
      }
      break
    }
    case 'report': {
      const file = await writeReport()
      console.log(`Redacted report written to: ${file}`)
      break
    }
    case 'assets': {
      const sub = args[0] || 'status'
      if (sub === 'status') {
        const { body } = await callDaemon(paths, 'GET', '/amadeus/assets/status')
        for (const p of body.packs || []) {
          const flag = p.installed ? (p.kind === 'runtime' && !p.matches ? 'HASH-MISMATCH' : 'installed') : 'missing'
          console.log(`${p.id.padEnd(18)} ${flag}`)
        }
        console.log(`ready: ${body.ready}${body.degrade ? '  degrade: ' + body.degrade : ''}`)
        break
      }
      if (sub === 'install') {
        const force = args.includes('--force')
        const packId = args.find((a) => !a.startsWith('-') && a !== 'install')
        const payload = packId ? { packId, force } : { force }
        const { body } = await callDaemon(paths, 'POST', '/amadeus/assets/install', payload)
        console.log(JSON.stringify(body, null, 2))
        break
      }
      if (sub === 'verify') {
        const { body } = await callDaemon(paths, 'POST', '/amadeus/assets/verify', {})
        console.log(JSON.stringify(body, null, 2))
        break
      }
      if (sub === 'install-file') {
        // bring your own model, verified against the registry hash
        const packId = args[1]
        const file = args[2]
        if (!packId || !file) {
          console.log('usage: amadeus assets install-file <packId> <path>')
          process.exitCode = 1
          break
        }
        const { body } = await callDaemon(paths, 'POST', '/amadeus/assets/install-file', {
          packId,
          path: path.resolve(file),
        })
        console.log(JSON.stringify(body, null, 2))
        break
      }
      console.log('usage: amadeus assets [status|install [packId] [--force]|verify|install-file <packId> <path>]')
      break
    }
    case 'logs': {
      console.log(`Data dir: ${paths.dataRoot}`)
      console.log(`Daemon file: ${paths.daemonFile}`)
      break
    }
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break
    default:
      console.log(`unknown command: ${cmd}\n`)
      printUsage()
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('[amadeus]', e && e.message ? e.message : e)
  process.exit(1)
})
