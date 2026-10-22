#!/usr/bin/env node
/**
 * Two-tab check: audio ownership, and cross-tab session sync.
 *
 * Before client identity existed, every connected tab received every utterance
 * (two tabs spoke at once) and a tab that opened later replayed the queue.
 *
 * The chat step is skipped by default because it spends a real model turn:
 *   AMADEUS_TWO_TAB_CHAT=1 node scripts/ui/verify-two-tabs.mjs
 *
 * Requires playwright-core and a system Edge/Chrome.
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

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ executablePath, headless: true })
// separate contexts => separate sessionStorage => two distinct clients
const ctxA = await browser.newContext({ viewport: { width: 520, height: 900 } })
const ctxB = await browser.newContext({ viewport: { width: 520, height: 900 } })
const tabA = await ctxA.newPage()
const tabB = await ctxB.newPage()

const ttsFetches = { a: 0, b: 0 }
tabA.on('request', (r) => {
  if (r.url().includes('/amadeus/tts')) ttsFetches.a += 1
})
tabB.on('request', (r) => {
  if (r.url().includes('/amadeus/tts')) ttsFetches.b += 1
})
const errors = []
for (const [name, page] of [['A', tabA], ['B', tabB]]) {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
}

const url = `${base}/amadeus/panel/index.html?token=${info.token}`
await Promise.all([tabA.goto(url, { waitUntil: 'domcontentloaded' }), tabB.goto(url, { waitUntil: 'domcontentloaded' })])
await tabA.waitForTimeout(4000)

const clientId = (page) => page.evaluate(() => sessionStorage.getItem('amadeus.clientId'))
const idA = await clientId(tabA)
const idB = await clientId(tabB)
check('two tabs get distinct client ids', Boolean(idA && idB && idA !== idB), `${idA} / ${idB}`)

const hubStatus = async () => (await (await fetch(`${base}/amadeus/status`, { headers: auth })).json()).events
const say = (text) =>
  fetch(`${base}/amadeus/say`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, emotion: 'neutral' }),
  })

let st = await hubStatus()
check('daemon sees both clients', st.clients === 2, `clients=${st.clients}`)
check('exactly one audio owner', st.audioOwner === idA || st.audioOwner === idB, `owner=${st.audioOwner}`)

// speech must reach exactly one tab; both fetching TTS means double audio
const ownerIsA = st.audioOwner === idA
ttsFetches.a = 0
ttsFetches.b = 0
await say('テスト')
await tabA.waitForTimeout(3500)
check(
  'only the owner fetches audio',
  (ownerIsA ? ttsFetches.a : ttsFetches.b) >= 1 && (ownerIsA ? ttsFetches.b : ttsFetches.a) === 0,
  `owner=${ownerIsA ? ttsFetches.a : ttsFetches.b} other=${ownerIsA ? ttsFetches.b : ttsFetches.a}`,
)

// focus moves ownership, and the queue goes with it
const target = ownerIsA ? tabB : tabA
const targetId = ownerIsA ? idB : idA
await target.bringToFront()
await target.evaluate(() => window.dispatchEvent(new Event('focus')))
await tabA.waitForTimeout(1200)
st = await hubStatus()
check('focus transfers ownership', st.audioOwner === targetId, `owner=${st.audioOwner}`)

ttsFetches.a = 0
ttsFetches.b = 0
await say('もう一度')
await tabA.waitForTimeout(3500)
check(
  'the new owner plays, the old one stays silent',
  (targetId === idA ? ttsFetches.a : ttsFetches.b) >= 1 && (targetId === idA ? ttsFetches.b : ttsFetches.a) === 0,
  `owner=${targetId === idA ? ttsFetches.a : ttsFetches.b}`,
)

if (process.env.AMADEUS_TWO_TAB_CHAT === '1') {
  const historyCount = (page) => page.evaluate(() => document.querySelectorAll('#history .msg').length)
  const beforeA = await historyCount(tabA)
  const beforeB = await historyCount(tabB)

  await tabA.bringToFront()
  await tabA.fill('#input', '一句话打个招呼')
  await tabA.click('#send')

  let afterA = beforeA
  let afterB = beforeB
  for (let i = 0; i < 40; i++) {
    await tabA.waitForTimeout(1500)
    afterA = await historyCount(tabA)
    afterB = await historyCount(tabB)
    if (afterA >= beforeA + 2 && afterB >= beforeB + 2) break
  }
  // deltas: the session may already carry history from earlier runs
  check('originator appends exactly its own turn', afterA === beforeA + 2, `A ${beforeA} -> ${afterA}`)
  check('the other tab syncs the same messages', afterB === beforeB + 2, `B ${beforeB} -> ${afterB}`)
  await tabB.locator('#phone').screenshot({ path: path.join(SHOTS, 'two-tab-sync.png') })
} else {
  console.log('SKIP  cross-tab chat sync (set AMADEUS_TWO_TAB_CHAT=1 to include it)')
}

check('no script errors in either tab', errors.length === 0, errors.join(' | ').slice(0, 160))

await browser.close()
console.log(`\n${failures === 0 ? 'all two-tab checks passed' : failures + ' check(s) failed'}`)
process.exit(failures === 0 ? 0 : 1)
