#!/usr/bin/env node
/**
 * Codex `notify` hook entry point.
 *
 * Codex invokes this with the event payload appended as the last argument.
 * We forward it to the daemon so the companion can react to *task* completion
 * instead of treating every turn end as success (the DSH bug).
 *
 * Codex's `notify` config holds exactly one command, and this machine already
 * had one (`codex-computer-use.exe turn-ended`). The installer therefore kept
 * the previous command in `<data>/notify-chain.json` and points `notify` here;
 * we replay the old command (best effort) and then notify the daemon, so
 * nothing that used to happen stops happening.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { resolvePaths } from '../src/shared/paths.mjs'
import { readDaemonInfo, ping } from '../src/host/daemon-client.mjs'
import { classifyNotifyEvent, notifyTurnId } from '../src/core/notify-event.mjs'
import { sanitizeChainedNotify } from '../src/core/codex-config.mjs'
import { redactText, redactValue } from '../src/core/redact.mjs'
import { log } from '../src/shared/log.mjs'

const paths = resolvePaths()
const hookPath = fileURLToPath(import.meta.url)
const raw = process.argv[process.argv.length - 1] || '{}'

/**
 * Every invocation is logged: when Codex's own `notify` fires, this file is
 * the only place that can tell you what it actually passed (the argv is
 * undocumented and differs between builds). Kept tiny and never throws.
 *
 * The payload is redacted first: it carries the user's whole prompt, the
 * working directory and the reply, and this file is exactly the thing people
 * paste into a bug report. Codes, kinds, ports and booleans survive; content,
 * paths and credentials do not.
 */
function logInvocation(kind, extra = '') {
  try {
    const args = process.argv.slice(2)
    const last = args[args.length - 1] || ''
    let payload
    try {
      payload = redactValue(JSON.parse(last))
    } catch {
      payload = redactText(last)
    }
    const shown = JSON.stringify([...args.slice(0, -1).map((a) => redactText(a)), payload])
    const line =
      `[${new Date().toISOString()}] argv=${shown} ` +
      `kind=${kind}${extra ? ' ' + extra : ''}\n`
    fs.appendFileSync(path.join(paths.dataRoot, 'notify.log'), line, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* logging must never break the hook */
  }
}

/** Run the notifier that was configured before this plugin was installed. */
function chainToPrevious(event) {
  const file = path.join(paths.dataRoot, 'notify-chain.json')
  let chain = null
  try {
    chain = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }
  const command = sanitizeChainedNotify(chain?.command, hookPath)
  if (command.length === 0) return
  // The chained notifier belongs to Codex (`...\runtimes\...\codex-computer-use.exe`)
  // and Codex is free to delete that runtime directory - it did, on this
  // machine. `spawn` reports a missing executable as an *asynchronous* 'error'
  // event, so an unhandled one tears this process down in the middle of the
  // announcement; that is exactly how a finished task ended up silent. Skip a
  // missing file, and keep a handler for everything else.
  try {
    if (/[\\/]/.test(command[0]) && !fs.existsSync(command[0])) {
      logInvocation('chain-missing', `command=${command[0].slice(-70)}`)
      return
    }
    const child = spawn(command[0], [...command.slice(1), event], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (e) => log.debug('[notify] chained notifier failed:', e && e.message ? e.message : e))
    child.unref()
  } catch (e) {
    log.debug('[notify] chained notifier failed:', e && e.message ? e.message : e)
  }
}

async function main() {
  chainToPrevious(raw)
  const { kind, type, origin } = classifyNotifyEvent(raw, { dataRoot: paths.dataRoot })
  const turnId = notifyTurnId(raw)
  const info = readDaemonInfo(paths)
  // Logged before the daemon check on purpose: "the task finished and nothing
  // was said" has to be diagnosable from this file alone, including the case
  // where nothing was listening at all.
  logInvocation(kind, `type=${type || ''} origin=${origin}${info ? '' : ' daemon=down'}`)
  if (origin === 'panel') {
    // The panel's own chat turn: it is answered out loud by the chat pipeline,
    // and announcing "task complete" too would speak over it.
    logInvocation(`${kind}:panel-origin`, 'broadcast=skipped')
    return
  }
  if (!info) {
    log.debug('[notify] daemon not running; ignoring event')
    return
  }
  // Deliberately *not* `callDaemon`: that helper calls `ensureDaemon`, which
  // starts a second daemon and waits up to 30s when a ping does not answer.
  // Codex gives this hook a short window, so a slow path here means the
  // announcement is never sent - which is exactly how "the task finished and
  // she said nothing" happened. Everything below is bounded and never spawns.
  const alive = await ping(info, 1500)
  if (!alive) {
    logInvocation(`${kind}:unsent`, 'reason=daemon-unreachable')
    return
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/amadeus/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      // No payload contents are sent: the daemon only needs the classification
      // and the turn id (to keep it from being announced twice).
      body: JSON.stringify({ kind, type, origin, turnId, at: Date.now() }),
      signal: AbortSignal.timeout(3000),
    })
    const body = await res.json().catch(() => null)
    logInvocation(`${kind}:sent`, `status=${res.status} broadcasted=${body?.broadcasted === true}`)
  } catch (e) {
    logInvocation(`${kind}:unsent`, `reason=${String(e && e.message ? e.message : e).slice(0, 120)}`)
  }
}

main().catch(() => {})
