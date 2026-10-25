#!/usr/bin/env node
/**
 * Show the companion panel as a native Windows application window.
 *
 * Used by `amadeus open`, by `Amadeus.exe` (double-click) and by the watcher
 * (`amadeus-watch.mjs`) that brings the panel up when Codex appears. No Codex
 * hooks are involved: this build of Codex lists nothing on its /hooks page, so
 * the connector launch is done by a watcher process instead.
 */
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import { openPanel } from '../src/host/panel-launcher.mjs'

const args = process.argv.slice(2)
const silent = args.includes('--silent')

const say = (line) => {
  if (!silent) console.log(line)
}

const MESSAGES = {
  window: 'Opening native Amadeus panel',
  'already-open': 'Amadeus panel is already open.',
  'daemon-unavailable': 'Amadeus daemon is not available.',
  'native-unavailable': 'Native Amadeus.exe is missing. Run 安装 Amadeus.cmd.',
  'browser-disabled': 'Browser panel is disabled. Open the native Amadeus.exe window.',
}

const paths = ensureDirs(resolvePaths())

openPanel({
  paths,
  force: args.includes('--force'),
  browser: args.includes('--browser') || args.includes('--tab'),
  welcome: args.includes('--welcome'),
})
  .then(({ status, ok }) => {
    say(MESSAGES[status] || status)
    if (!ok) process.exitCode = 1
  })
  .catch((e) => {
    // Never fail loudly: this runs from a watcher and from shortcuts.
    say(`panel launch failed: ${e && e.message ? e.message : e}`)
    if (!silent) process.exitCode = 1
  })
