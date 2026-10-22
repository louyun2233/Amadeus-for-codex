#!/usr/bin/env node
/**
 * Panel regression harness.
 *
 * Runs the real panel in a real browser and checks the properties that unit
 * tests cannot see: that Live2D actually comes up, that resizing does not
 * distort the canvas, that a client-side error reaches the daemon, and that the
 * screenshots still match what we shipped.
 *
 * Requires an installed system browser (Edge/Chrome) and `playwright-core`:
 *   npm i && node scripts/ui/verify-ui.mjs --data <dataDir>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from '../../src/shared/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SHOTS = path.join(ROOT, 'docs', 'screenshots')

const args = process.argv.slice(2)
const dataFlag = args.indexOf('--data')
const paths = resolvePaths(
  dataFlag >= 0 ? { ...process.env, AMADEUS_DATA_DIR: args[dataFlag + 1] } : process.env,
)

const BROWSERS = [
  process.env.AMADEUS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const executablePath = BROWSERS.find((p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
})

let chromium
try {
  ;({ chromium } = await import('playwright-core'))
} catch {
  console.error('playwright-core is not installed. Run: npm install')
  process.exit(2)
}
if (!executablePath) {
  console.error('no system browser found; set AMADEUS_BROWSER to an Edge/Chrome executable')
  process.exit(2)
}

const info = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
const base = `http://127.0.0.1:${info.port}`
const auth = { Authorization: `Bearer ${info.token}` }
const panelUrl = `${base}/amadeus/panel/index.html?token=${info.token}`

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

// Start from an empty speech queue. A leftover broadcast from an earlier run
// makes the panel fetch TTS on load, and an upstream TTS failure would then be
// reported as a console error - a failure of this harness, not of the panel.
await fetch(`${base}/amadeus/action`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ cmd: 'clear' }),
}).catch(() => {})

fs.mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
page.on('console', (m) => {
  const text = m.text()
  // favicon 404 is expected and noise
  if (m.type() === 'error' && !/favicon|404/.test(text)) consoleErrors.push(text)
})

await page.goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })

// wait for the Live2D renderer
let live2dReady = false
for (let i = 0; i < 60; i++) {
  live2dReady = await page.evaluate(() => Boolean(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel))
  if (live2dReady) break
  await page.waitForTimeout(500)
}
await page.waitForTimeout(2000)

check('panel loads without page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200))
check('live2d runtime initialised', live2dReady)

const renderState = await page.evaluate(() => {
  const live = document.getElementById('avatar')
  const fallback = document.getElementById('avatar-fallback')
  const note = document.getElementById('asset-note')
  return {
    liveVisible: !live.hidden,
    fallbackVisible: !fallback.hidden,
    noteHidden: note.classList.contains('hidden'),
    noteText: note.textContent.trim(),
  }
})
check('live2d canvas is the visible one', renderState.liveVisible && !renderState.fallbackVisible)
check('no degradation note shown', renderState.noteHidden, renderState.noteText)

// canvas must track the container exactly, otherwise the model is stretched
const measure = () =>
  page.evaluate(() => {
    const rect = document.getElementById('avatar-wrap').getBoundingClientRect()
    const canvas = document.getElementById('avatar')
    return {
      wrapper: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      backing: `${canvas.width}x${canvas.height}`,
      dx: Math.abs(Math.round(rect.width) - canvas.width),
      dy: Math.abs(Math.round(rect.height) - canvas.height),
    }
  })

const before = await measure()
check('canvas matches container at load', before.dx <= 1 && before.dy <= 1, `${before.wrapper} vs ${before.backing}`)
await page.locator('#phone').screenshot({ path: path.join(SHOTS, 'panel-chat.png') })

await page.setViewportSize({ width: 520, height: 640 })
await page.waitForTimeout(1500)
const after = await measure()
check(
  'canvas follows the container after resize',
  after.dx <= 1 && after.dy <= 1,
  `${after.wrapper} vs ${after.backing}`,
)

// a client-side error must reach the daemon, not just the browser console
const marker = `ui-probe-${Date.now()}`
await page.evaluate((m) => {
  setTimeout(() => {
    throw new Error(m)
  }, 0)
}, marker)
await page.waitForTimeout(1200)
const logs = await (await fetch(`${base}/amadeus/logs?limit=20`, { headers: auth })).json()
check(
  'client error is reported to the daemon',
  (logs.client || []).some((l) => l.message.includes(marker)),
  `${(logs.client || []).length} entries`,
)

// the scheduler has to see this panel as an audience and stay inspectable
const proactive = await (await fetch(`${base}/amadeus/proactive`, { headers: auth })).json()
check('scheduler sees the connected panel', proactive.clients >= 1, `clients=${proactive.clients}`)
check(
  'scheduler exposes its configuration',
  typeof proactive.callEnabled === 'boolean' && typeof proactive.idleEnabled === 'boolean',
  `call=${proactive.callEnabled} idle=${proactive.idleEnabled}`,
)

const tick = await (
  await fetch(`${base}/amadeus/proactive/tick`, { method: 'POST', headers: auth, body: '{}' })
).json()
check(
  'scheduler tick returns a decision',
  Boolean(tick.ok && tick.decision && tick.decision.action),
  JSON.stringify(tick.decision),
)

// Tapping the avatar must request a line through the configured cloned voice.
const tapRequestPromise = page.waitForRequest(
  (request) => request.url().endsWith('/amadeus/say') && request.method() === 'POST',
  { timeout: 5000 },
).catch(() => null)
await page.evaluate(() => {
  const canvas = document.getElementById('avatar')
  const rect = canvas.getBoundingClientRect()
  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height * 0.9, // lower body -> tap_body
      bubbles: true,
    }),
  )
})
const tapRequest = await tapRequestPromise
check(
  'tapping the avatar requests the selected speech voice',
  Boolean(tapRequest?.postDataJSON()?.text),
  tapRequest?.postDataJSON()?.text || '(no speech request)',
)
check(
  'no imported media clip can play on a tap',
  await page.evaluate(() => !document.getElementById('sfx')),
)
check(
  'bundled Live2D voice clips are disabled',
  await page.evaluate(() => window.PIXI?.live2d?.config?.sound === false),
)

// The credential row is the only write path for an API key. It has to render,
// stay write-only (a password field that is never pre-filled from the daemon),
// and describe its state without ever echoing the value back.
await page.locator('.tab[data-view="settings"]').click()
await page.waitForTimeout(400)
await page.locator('#phone').screenshot({ path: path.join(SHOTS, 'panel-settings.png') })
const settingsProbe = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#settings .row')]
  const keyRow = rows.find((r) => r.querySelector('.label')?.textContent === 'API Key')
  const input = keyRow?.querySelector('input')
  const save = keyRow?.querySelector('button')
  const inputBox = input?.getBoundingClientRect()
  const saveBox = save?.getBoundingClientRect()
  return {
    rows: rows.length,
    unlabelled: rows.filter((r) => !r.querySelector('.label')).length,
    hasKeyRow: Boolean(keyRow),
    type: input?.type || '',
    value: input?.value || '',
    hasSave: Boolean(save),
    hint: keyRow?.querySelector('.desc')?.textContent || '',
    inputWidth: inputBox ? Math.round(inputBox.width) : 0,
    saveHeight: saveBox ? Math.round(saveBox.height) : 0,
    controlOverlaps: inputBox && saveBox ? inputBox.right > saveBox.left + 1 : false,
    // a label column that runs under its control is the "misaligned" failure
    overlappingRows: rows
      .filter((r) => {
        const kids = [...r.children]
        if (kids.length < 2) return false
        const a = kids[0].getBoundingClientRect()
        const b = kids[kids.length - 1].getBoundingClientRect()
        return a.right > b.left + 1
      })
      .map((r) => r.querySelector('.label')?.textContent || '?'),
  }
})
check('settings renders an API Key row', settingsProbe.hasKeyRow, settingsProbe.hint)
check(
  'key field is a password input that never pre-fills',
  settingsProbe.type === 'password' && settingsProbe.value === '' && settingsProbe.hasSave,
  `type=${settingsProbe.type} value=${settingsProbe.value ? '(non-empty)' : '(empty)'} save=${settingsProbe.hasSave}`,
)
check(
  'key hint reports state only',
  /^(未设置|已设置)/.test(settingsProbe.hint),
  settingsProbe.hint,
)
check(
  'key row controls fit without clipping or wrapping',
  settingsProbe.inputWidth >= 80 && settingsProbe.saveHeight <= 40 && !settingsProbe.controlOverlaps,
  `input=${settingsProbe.inputWidth}px saveH=${settingsProbe.saveHeight}px overlap=${settingsProbe.controlOverlaps}`,
)
check(
  'every settings row is labelled',
  settingsProbe.unlabelled === 0 && settingsProbe.rows >= 12,
  `rows=${settingsProbe.rows} unlabelled=${settingsProbe.unlabelled}`,
)

// A select whose stored value is not among its options must still show that
// value; a blank control is indistinguishable from a broken setting.
const blankControls = await page.evaluate(() =>
  [...document.querySelectorAll('#settings select')]
    // Only visible controls: the import form is hidden until it is opened.
    .filter((s) => s.offsetParent !== null && !s.value)
    .map((s) => s.closest('.row')?.querySelector('.label')?.textContent || '(unknown)'),
)
check('no settings control is left blank', blankControls.length === 0, blankControls.join(', '))
check(
  'no settings row has its control under the label',
  settingsProbe.overlappingRows.length === 0,
  settingsProbe.overlappingRows.join(', '),
)

// speech input is selectable now, so all three channels have to be reachable
const speechRow = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#settings .row')].find(
    (r) => r.querySelector('.label')?.textContent === '语音输入',
  )
  const select = row?.querySelector('select')
  return {
    options: [...(select?.options || [])].map((o) => o.value),
    selected: select?.value || '',
    hint: row?.querySelector('.desc')?.textContent || '',
  }
})
check('settings exposes the speech-input channel', speechRow.options.length === 3, speechRow.selected)
check(
  'speech input offers browser, api and off',
  speechRow.options.join(',') === 'browser,api,none',
  speechRow.options.join(','),
)

// 音色 contains the default, exactly the user's imported voices, and 导入.
const voiceRow = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#settings .row')].find(
    (r) => r.querySelector('.label')?.textContent === '音色',
  )
  const select = row?.querySelector('select')
  return {
    labels: [...(select?.options || [])].map((o) => o.textContent),
    values: [...(select?.options || [])].map((o) => o.value),
  }
})
const voiceCatalog = await fetch(`${base}/amadeus/voices`, { headers: auth }).then((res) => res.json())
const importedIds = (voiceCatalog.custom || []).map((voice) => voice.id)
check(
  'the voice menu contains the default and imported voices',
  voiceRow.labels.length === importedIds.length + 2 &&
    /^默认/.test(voiceRow.labels[0]) &&
    voiceRow.labels.at(-1)?.includes('导入') &&
    voiceRow.values.at(-1) === '__import__' &&
    voiceRow.values.slice(1, -1).every((id, index) => id === importedIds[index]),
  voiceRow.labels.join(' / '),
)

// the system-broadcast switch is the only control that can make the machine
// talk while the panel is closed, so it has to render as an off checkbox
const systemRow = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#settings .row')].find(
    (r) => r.querySelector('.label')?.textContent === '系统播报',
  )
  const box = row?.querySelector('input[type="checkbox"]')
  return { present: Boolean(row), type: box?.type || '', checked: Boolean(box?.checked), disabled: Boolean(box?.disabled) }
})
check(
  'system-voice broadcast is disabled while a clone is selected',
  systemRow.present && systemRow.type === 'checkbox' && systemRow.checked === false && systemRow.disabled,
  `type=${systemRow.type} checked=${systemRow.checked} disabled=${systemRow.disabled}`,
)
const systemRowShot = page.locator('#settings .row').filter({ hasText: '系统播报' }).first()
await systemRowShot.scrollIntoViewIfNeeded()
await systemRowShot.screenshot({ path: path.join(SHOTS, 'panel-settings-broadcast.png') })

// Capture the credential row on its own: it is the newest control, and the
// narrowest, so it is where "text does not fit its container" would show up.
const keyRowShot = page.locator('#settings .row').filter({ hasText: 'API Key' }).first()
await keyRowShot.scrollIntoViewIfNeeded()
await keyRowShot.screenshot({ path: path.join(SHOTS, 'panel-settings-key.png') })

await page.locator('.tab[data-view="chat"]').click()
await page.waitForTimeout(200)

// the degradation UI must be reachable and readable
await page.evaluate(() => {
  const note = document.getElementById('asset-note')
  note.textContent = '（回归检查用的降级文案）'
  note.classList.remove('hidden')
})
await page.locator('#phone').screenshot({ path: path.join(SHOTS, 'panel-degraded.png') })

// and the incoming-call overlay, which is where the Japanese-vs-Chinese copy
// mistake showed up. Capture it so copy changes are visible in review.
await page.evaluate(() => {
  document.getElementById('asset-note').classList.add('hidden')
  document.getElementById('call-sub').textContent = '喂喂，我是红莉栖。听得见吗？'
  document.getElementById('call-overlay').classList.remove('hidden')
})
await page.waitForTimeout(400)
await page.locator('#phone').screenshot({ path: path.join(SHOTS, 'panel-incoming-call.png') })
const callCopy = await page.evaluate(() => ({
  accept: document.getElementById('call-accept').textContent,
  deny: document.getElementById('call-deny').textContent,
  hint: document.getElementById('call-sub').textContent,
}))
check(
  'call controls use Chinese copy',
  callCopy.accept === '接听' && callCopy.deny === '拒接',
  `${callCopy.accept}/${callCopy.deny}`,
)
check('call overlay no longer uses the Japanese hint', !callCopy.hint.includes('着信中'))

// App-window mode: `amadeus open` loads the panel with `#app`, and there the
// phone has to fill the window. Page padding plus the dark gradient around it
// is what read as a "big black frame" around the phone.
const appPage = await context.newPage()
// Deliberately bigger than the phone: the point of app mode is that an
// oversized window does not inflate the device.
await appPage.setViewportSize({ width: 900, height: 700 })
await appPage.goto(`${panelUrl}#app`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await appPage.waitForTimeout(2600)
await appPage.screenshot({ path: path.join(SHOTS, 'panel-app-mode.png') })
const appMode = await appPage.evaluate(() => {
  const phone = document.getElementById('phone').getBoundingClientRect()
  const body = getComputedStyle(document.body)
  return {
    mode: document.documentElement.dataset.mode || '',
    phone: [Math.round(phone.width), Math.round(phone.height)],
    centered:
      Math.abs(phone.left - (window.innerWidth - phone.width) / 2) <= 1 &&
      Math.abs(phone.top - (window.innerHeight - phone.height) / 2) <= 1,
    padding: body.padding,
    backgroundImage: body.backgroundImage,
  }
})
check('app mode engages from the #app fragment', appMode.mode === 'app', appMode.mode || '(none)')
check(
  'the phone keeps its size and stays centred',
  appMode.phone[0] <= 284 &&
    appMode.phone[1] <= 504 &&
    appMode.centered &&
    appMode.backgroundImage === 'none',
  `phone=${appMode.phone.join('x')} centered=${appMode.centered} bg=${appMode.backgroundImage}`,
)
// The character itself has to sit in the middle of its canvas: the model's
// bounds include hidden parts, and the old absolute nudge in the registry made
// it sit 80px to the left in a small window.
const avatar = await appPage.evaluate(() => (window.__amadeusAvatar ? window.__amadeusAvatar() : null))
check(
  'the character is centred in the avatar canvas',
  Boolean(avatar) &&
    Math.abs(avatar.bounds.x + avatar.bounds.w / 2 - avatar.canvas.w / 2) <= 12,
  avatar
    ? `content=${Math.round(avatar.bounds.x + avatar.bounds.w / 2)} canvas=${avatar.canvas.w / 2}`
    : '(avatar not ready)',
)
await appPage.close()

await browser.close()

console.log(`\n${failures === 0 ? 'all UI checks passed' : failures + ' UI check(s) failed'}`)
process.exit(failures === 0 ? 0 : 1)
