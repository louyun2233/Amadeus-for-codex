import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {
  BROWSER_SPAWN_OPTIONS,
  appWindowArgs,
  panelAnswers,
  panelUrl,
  launchInFlight,
} from '../src/host/panel-launcher.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * `panelAnswers` exists because of a grey browser error page: the launcher used
 * to open a window onto a port that was already gone, and the user had no way
 * back from the resulting "can't reach this site" screen.
 *
 * The token exchange answers with a 302, and the probe must treat that as
 * success *without* following it - a followed redirect lands on the panel page
 * with no session cookie and reports a healthy daemon as unreachable.
 */

function server(handler) {
  const srv = http.createServer(handler)
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

test('the panel url carries the one-time token and no app flag', () => {
  const url = panelUrl({ port: 1234, token: 'tok' })
  assert.match(url, /^http:\/\/127\.0\.0\.1:1234\/amadeus\/panel\/index\.html\?token=tok$/)
  // app mode travels in the fragment (a query would be dropped by the 302),
  // together with the window size the page should resize itself to.
  assert.match(panelUrl({ port: 1234, token: 'tok' }, { app: true }), /#app-\d+x\d+$/)
  assert.match(panelUrl({ port: 1234, token: 'tok' }, { app: true, welcome: true }), /#app-\d+x\d+&welcome=1$/)
  assert.doesNotMatch(panelUrl({ port: 1234, token: 'tok' }, { app: true }), /welcome/)
})

test('the double-click launcher requests a one-shot welcome through the panel entry', () => {
  const exeSource = fs.readFileSync(new URL('../scripts/launcher.cs', import.meta.url), 'utf8')
  const builder = fs.readFileSync(new URL('../scripts/build-launcher.ps1', import.meta.url), 'utf8')
  const panelEntry = fs.readFileSync(new URL('../bin/amadeus-panel.mjs', import.meta.url), 'utf8')
  assert.match(exeSource, /--silent --welcome/)
  assert.match(builder, /--silent --welcome/)
  assert.match(panelEntry, /welcome: args\.includes\('--welcome'\)/)
})

test('a daemon that answers the token exchange counts as reachable', async () => {
  const { srv, port } = await server((req, res) => {
    res.writeHead(req.url.includes('token=') ? 302 : 401, { Location: '/amadeus/panel/index.html' })
    res.end()
  })
  try {
    assert.equal(await panelAnswers({ port, token: 'tok' }), true)
  } finally {
    srv.close()
  }
})

test('a daemon that refuses the token counts as unreachable', async () => {
  const { srv, port } = await server((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/html' })
    res.end('<title>AMADEUS</title>')
  })
  try {
    assert.equal(await panelAnswers({ port, token: 'bad' }), false)
  } finally {
    srv.close()
  }
})

test('a dead port counts as unreachable instead of hanging', async () => {
  const { srv, port } = await server((req, res) => res.end('x'))
  await new Promise((r) => srv.close(r))
  assert.equal(await panelAnswers({ port, token: 'tok' }), false)
})

/**
 * The window that was opened but never seen: `windowsHide: true` makes
 * Windows hand the browser SW_HIDE, Chromium applies it to its first window,
 * and the panel ends up visible only in the process list.
 */
test('the panel browser is never started hidden', () => {
  assert.equal(BROWSER_SPAWN_OPTIONS.windowsHide, false)
  assert.equal(BROWSER_SPAWN_OPTIONS.detached, true)
})

test('the app window asks for the phone size, the profile and autoplay', () => {
  const args = appWindowArgs('http://127.0.0.1:1/panel#app-300x520', {
    size: '300,520',
    profileDir: 'C:\\data\\panel-profile',
  })
  assert.ok(args.some((a) => a === '--app=http://127.0.0.1:1/panel#app-300x520'))
  assert.ok(args.includes('--window-size=300,520'))
  assert.ok(args.includes('--user-data-dir=C:\\data\\panel-profile'))
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
})

test('the app window works without a private profile too', () => {
  const args = appWindowArgs('http://127.0.0.1:1/panel')
  assert.equal(args.filter((a) => a.startsWith('--user-data-dir=')).length, 0)
  assert.ok(args.some((a) => a.startsWith('--window-size=')))
})

/**
 * Two launches inside the same second - the watcher seeing Codex appear while
 * the startup shortcut runs - used to produce two windows. Only the first may
 * win, and the guard has to expire so closing the panel and reopening it later
 * still works.
 */
test('a launch in flight suppresses the next one, then expires', () => {
  const paths = tempPaths()
  try {
    assert.equal(launchInFlight(paths), false, 'nothing launched yet')
    const lock = path.join(paths.runtimeDir, 'panel-launch.lock')
    fs.writeFileSync(lock, 'x')
    assert.equal(launchInFlight(paths), true)
    assert.equal(launchInFlight(paths, { now: Date.now() + 60_000 }), false, 'stale launch must not block')
  } finally {
    cleanup(paths)
  }
})

test('a launcher without a data root never blocks itself', () => {
  assert.equal(launchInFlight(null), false)
  assert.equal(launchInFlight({}), false)
})
