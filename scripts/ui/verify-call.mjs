#!/usr/bin/env node
/**
 * The incoming call, driven the way the daemon really drives it.
 *
 * `npm run verify:ui` fakes the overlay through the DOM; this one posts to
 * `/amadeus/call` and watches the panel do the whole thing:
 *
 *   1. the overlay appears and the ring plays on its own element
 *   2. the hub queue is empty - the line is held client side, not re-sent
 *   3. answering stops the ring and hands the line to the speech queue
 *   4. declining stops the ring without speaking
 *
 * Needs a running daemon (`bin/amadeus.mjs start`) and the panel profile free.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const dataRoot = process.env.AMADEUS_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'Amadeus')
const daemonFile = path.join(dataRoot, 'runtime', 'daemon.json')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let failures = 0
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`)
  if (!ok) failures += 1
}

const info = JSON.parse(fs.readFileSync(daemonFile, 'utf8'))
const auth = { Authorization: `Bearer ${info.token}` }
const api = (apiPath, init = {}) =>
  fetch(`http://127.0.0.1:${info.port}${apiPath}`, {
    ...init,
    headers: { ...auth, ...(init.headers || {}) },
  })

const exe = [process.env.AMADEUS_BROWSER, EDGE, CHROME].find((p) => p && fs.existsSync(p))
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  let ttsFetches = 0
  page.on('request', (req) => {
    if (req.url().includes('/amadeus/tts')) ttsFetches += 1
  })
  await page.goto(`http://127.0.0.1:${info.port}/amadeus/panel/index.html?token=${info.token}#app-300x520`, {
    waitUntil: 'load',
  })
  await page.waitForTimeout(1500)
  await page.mouse.click(150, 200)

  // Speech only ever goes to the audio owner, and the user's own panel window
  // already holds it, so this tab claims it the way a focused tab would.
  const clientId = await page.evaluate(() => sessionStorage.getItem('amadeus.clientId'))
  const claim = await (await api('/amadeus/client/active', {
    method: 'POST',
    headers: { 'x-amadeus-client': String(clientId || '') },
  })).json()
  check('the test tab owns audio', claim.owner === clientId, `owner=${claim.owner ?? '?'}`)

  const ringRes = await api('/amadeus/sound/incoming')
  check('the ring route answers audio', ringRes.ok && /^audio\//.test(ringRes.headers.get('content-type') || ''), `${ringRes.status} ${ringRes.headers.get('content-type')}`)

  const queued = await (await api('/amadeus/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'verify-call' }),
  })).json()
  check('the daemon accepts a call', queued.ok === true, JSON.stringify(queued.utterance?.id ?? null))

  await page.waitForTimeout(1500)
  const ringing = await page.evaluate(() => {
    const overlay = document.getElementById('call-overlay')
    const ring = document.getElementById('ring')
    return {
      overlay: !overlay.classList.contains('hidden'),
      paused: ring.paused,
      time: Number(ring.currentTime.toFixed(2)),
      src: ring.src,
      volume: ring.volume,
    }
  })
  check('the call overlay is shown', ringing.overlay === true)
  check('the incoming call rings', ringing.paused === false && ringing.time > 0, `${ringing.src} t=${ringing.time}s v=${ringing.volume}`)

  const status = await (await api('/amadeus/status')).json()
  check('the held line is acknowledged, not re-sent', status.events.pendingUtterances === 0, `pending=${status.events.pendingUtterances}`)

  await page.click('#call-accept')
  // The line is synthesized on demand (a second or two on the cloud voice).
  for (let i = 0; i < 20 && ttsFetches === 0; i += 1) await page.waitForTimeout(500)
  const after = await page.evaluate(() => {
    const ring = document.getElementById('ring')
    const player = document.getElementById('player')
    return {
      ringingStopped: ring.paused === true,
      overlayHidden: document.getElementById('call-overlay').classList.contains('hidden'),
      playerSrc: player.src.slice(0, 24),
    }
  })
  check('answering stops the ring', after.ringingStopped === true)
  check('answering closes the overlay', after.overlayHidden === true)
  check('answering hands the line to the speech queue', ttsFetches > 0, `tts requests=${ttsFetches} src=${after.playerSrc}`)

  const second = await (await api('/amadeus/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'verify-call-decline' }),
  })).json()
  await page.waitForTimeout(1200)
  await page.click('#call-deny')
  await page.waitForTimeout(800)
  const declined = await page.evaluate(() => ({
    ringingStopped: document.getElementById('ring').paused === true,
    overlayHidden: document.getElementById('call-overlay').classList.contains('hidden'),
  }))
  check('declining stops the ring', declined.ringingStopped === true)
  check('declining closes the overlay', declined.overlayHidden === true, `id=${second.utterance?.id ?? '?'}`)

  check('the panel reported no errors', errors.length === 0, errors.join(' | '))
  check('no utterance was left queued', (await (await api('/amadeus/status')).json()).events.pendingUtterances === 0)
} finally {
  await browser.close()
}

process.stdout.write(failures === 0 ? '\ncall verification passed\n' : `\n${failures} call check(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1
