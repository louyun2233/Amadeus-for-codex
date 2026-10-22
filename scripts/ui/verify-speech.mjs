#!/usr/bin/env node
/**
 * Speech behaviour that was reported as broken:
 *
 *   1. tapping her used to play the model's original voice clips, a different
 *      timbre from the configured one - the tap must now go through the voice
 *      provider (`/amadeus/say` → `/amadeus/tts`)
 *   2. a multi-sentence reply stuttered between sentences and lost its ending
 *      (unacknowledged lines were re-sent, de-duplicated, then dropped) - every
 *      sentence must be synthesized exactly once and the queue must end empty
 *
 * Needs a running daemon and the panel profile free.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const dataRoot = process.env.AMADEUS_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'Amadeus')
const info = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime', 'daemon.json'), 'utf8'))
const auth = { Authorization: `Bearer ${info.token}` }
const api = (apiPath, init = {}) =>
  fetch(`http://127.0.0.1:${info.port}${apiPath}`, { ...init, headers: { ...auth, ...(init.headers || {}) } })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let failures = 0
function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`)
  if (!ok) failures += 1
}

const exe = [process.env.AMADEUS_BROWSER, EDGE, CHROME].find((p) => p && fs.existsSync(p))
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  const errors = []
  const ttsTexts = []
  const modelClipFetches = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/amadeus/tts')) ttsTexts.push(decodeURIComponent(new URL(url).searchParams.get('text') || ''))
    if (/\/amadeus\/assets\/current\/sounds\//.test(url)) modelClipFetches.push(url)
  })

  await page.goto(`http://127.0.0.1:${info.port}/amadeus/panel/index.html?token=${info.token}#app-300x520`, {
    waitUntil: 'load',
  })
  await page.waitForTimeout(2500)
  const clientId = await page.evaluate(() => sessionStorage.getItem('amadeus.clientId'))
  await api('/amadeus/client/active', { method: 'POST', headers: { 'x-amadeus-client': String(clientId || '') } })

  // 1. tapping her speaks in the configured voice
  const liveReady = await page.evaluate(() =>
    Boolean(document.getElementById('avatar') && !document.getElementById('avatar').hidden),
  )
  check('the live2d canvas is up (a tap needs the model)', liveReady === true)
  const box = await page.locator('#avatar-wrap').boundingBox()
  for (let attempt = 0; attempt < 3 && ttsTexts.length === 0; attempt += 1) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * (0.3 + attempt * 0.15))
    await page.waitForTimeout(2500)
  }
  check('tapping her asks the voice provider to speak', ttsTexts.length >= 1, `tts requests=${ttsTexts.length}`)
  check('the original voice clips are not used by default', modelClipFetches.length === 0, modelClipFetches.join(' '))

  // Let the tap reaction finish so it cannot land in the middle of the sequence.
  await page.waitForTimeout(4000)
  const statusBefore = (await (await api('/amadeus/status')).json()).events
  const droppedBefore = statusBefore.dropped.length

  // 2. three sentences in a row: each synthesized once, none dropped
  const MARKERS = ['ALPHA', 'BETA', 'GAMMA']
  for (const marker of MARKERS) {
    await api('/amadeus/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${marker}。`, emotion: 'neutral' }),
    })
    await page.waitForTimeout(200)
  }
  const deadline = Date.now() + 45000
  const spokenMarkers = () => ttsTexts.filter((t) => MARKERS.some((m) => t.includes(m)))
  while (new Set(spokenMarkers()).size < 3 && Date.now() < deadline) await page.waitForTimeout(500)
  const spoken = spokenMarkers()
  check('every sentence is synthesized once', spoken.length === 3, `requests=${spoken.join(' | ')}`)
  check(
    'the sentences are spoken in order',
    spoken.join('|') === MARKERS.map((m) => `${m}。`).join('|'),
    spoken.join(' | '),
  )

  const status = await (await api('/amadeus/status')).json()
  check(
    'nothing was dropped as unacknowledged',
    status.events.dropped.length === droppedBefore,
    JSON.stringify(status.events.dropped.slice(droppedBefore)),
  )
  check('the queue drains', status.events.pendingUtterances === 0, `pending=${status.events.pendingUtterances}`)

  const reports = await (await api('/amadeus/logs?limit=20')).json()
  const playbackFailures = (reports.client || []).filter((r) => /playback failed|合成失败/.test(r.message || ''))
  check('no playback failures were reported', playbackFailures.length === 0, JSON.stringify(playbackFailures.slice(0, 2)))
  check('the panel reported no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
}

process.stdout.write(failures === 0 ? '\nspeech verification passed\n' : `\n${failures} speech check(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1
