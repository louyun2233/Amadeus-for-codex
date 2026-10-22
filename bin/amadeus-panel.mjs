#!/usr/bin/env node
/**
 * Show the companion panel as an application window instead of a browser tab.
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
  window: 'Opening Amadeus panel window',
  tab: 'Opening Amadeus panel in the default browser',
  'already-open': 'Amadeus panel is already open.',
  'daemon-unavailable': 'Amadeus daemon is not available.',
}

const paths = ensureDirs(resolvePaths())

openPanel({
  paths,
  force: args.includes('--force'),
  browser: args.includes('--browser') || args.includes('--tab'),
  welcome: args.includes('--welcome'),
})
  .then(({ status, info }) => {
    const where = info ? `: http://127.0.0.1:${info.port}/amadeus/panel/` : ''
    say(`${MESSAGES[status] || status}${status === 'window' || status === 'tab' ? where : ''}`)
    if (status === 'daemon-unavailable') process.exitCode = 1
  })
  .catch((e) => {
    // Never fail loudly: this runs from a watcher and from shortcuts.
    say(`panel launch failed: ${e && e.message ? e.message : e}`)
    if (!silent) process.exitCode = 1
  })
