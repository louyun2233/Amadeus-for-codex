#!/usr/bin/env node
/** Real-browser two-window regression with an isolated daemon and fake media/model. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createDaemon } from '../../src/host/daemon.mjs'
import { wireChatEvents } from '../../src/host/chat-events.mjs'
import { EventHub } from '../../src/host/events.mjs'
import { ChatEngine } from '../../src/core/chat.mjs'
import { ConfigStore } from '../../src/core/config.mjs'
import { SecretStore } from '../../src/core/secrets.mjs'
import { AuditLog } from '../../src/core/audit.mjs'
import { SessionStore } from '../../src/core/sessions.mjs'
import { MemoryStore } from '../../src/core/memory.mjs'
import { VoiceLibrary } from '../../src/core/voices.mjs'
import { tempPaths, cleanup } from '../../tests/helpers.mjs'

const browserCandidates = [
  process.env.AMADEUS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) {
  console.error('No Edge/Chrome found; set AMADEUS_BROWSER to its executable path.')
  process.exit(2)
}

function silentWav() {
  const samples = 1600
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  return wav
}

const paths = tempPaths()
let daemon
let browser
try {
  const config = new ConfigStore(paths)
  // A continuous session makes cross-window history synchronisation observable.
  config.update({ chat: { oneshot: false } })
  const sessions = new SessionStore(paths)
  const sharedSession = sessions.create({ name: 'isolated browser check' })
  const memory = new MemoryStore(paths, config)
  const hub = new EventHub()
  const llm = {
    pick: () => ({
      chat: async ({ user, onDelta, signal }) => {
        if (user === '慢速取消测试') {
          await new Promise((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason)
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        signal.throwIfAborted()
        const text = '【neutral】こんにちは。\n【neutral】你好，测试完成。'
        onDelta?.(text)
        return { text }
      },
    }),
  }
  const chat = new ChatEngine({ sessions, memory, llm, config, audit: null })
  wireChatEvents({ chat, hub, config, memory })
  const wav = silentWav()
  const tts = {
    stats: () => ({ provider: 'isolated-fake' }),
    providerId: () => 'isolated-fake',
    synthesize: async () => ({ mime: 'audio/wav', audio: wav, words: [], cached: false }),
  }
  daemon = createDaemon({
    paths, config, secrets: new SecretStore(paths), sessions, memory,
    audit: new AuditLog(paths), chat, tts, hub,
    diag: async () => ({ ok: true }), assets: null, proactive: null,
    systemTts: null, voices: new VoiceLibrary(paths), version: 'isolated-test',
  })
  const info = await daemon.start()
  browser = await chromium.launch({
    executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const viewport = { width: 300, height: 520 } // the shipped app-window size
  const a = await (await browser.newContext({ viewport })).newPage()
  const b = await (await browser.newContext({ viewport })).newPage()
  const errors = []
  const ttsFetches = { a: 0, b: 0 }
  for (const [key, page] of [['a', a], ['b', b]]) {
    page.on('pageerror', (error) => errors.push(`${key}: ${error.message}`))
    page.on('request', (request) => {
      if (request.url().includes('/amadeus/tts')) ttsFetches[key] += 1
    })
  }

  const url = `${daemon.urlForPanel()}&app=1`
  await a.goto(url, { waitUntil: 'domcontentloaded' })
  await b.goto(url, { waitUntil: 'domcontentloaded' })
  await a.waitForFunction(() => sessionStorage.getItem('amadeus.clientId') && document.querySelector('#history .empty'))
  await b.waitForFunction(() => sessionStorage.getItem('amadeus.clientId') && document.querySelector('#history .empty'))
  await a.waitForFunction(async () => {
    const response = await fetch('/amadeus/status')
    return (await response.json()).events.clients === 2
  })
  const idA = await a.evaluate(() => sessionStorage.getItem('amadeus.clientId'))
  const idB = await b.evaluate(() => sessionStorage.getItem('amadeus.clientId'))
  if (idA === idB || hub.status().clients !== 2) throw new Error('tabs did not establish separate SSE clients')
  await a.locator('#onboarding').waitFor({ state: 'visible' })
  await b.locator('#onboarding').waitFor({ state: 'visible' })
  for (const size of [viewport, { width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await a.setViewportSize(size)
    const guideFits = await a.evaluate(() => {
      const rect = document.querySelector('#onboarding').getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })
    if (!guideFits) throw new Error(`guide exceeds ${size.width}×${size.height} viewport`)
  }
  await a.setViewportSize(viewport)
  if (process.env.AMADEUS_ONBOARDING_SHOT) {
    await a.screenshot({ path: process.env.AMADEUS_ONBOARDING_SHOT })
  }
  if (config.getPath('voice.enabled') !== false || config.getPath('broadcast.enabled') !== false) {
    throw new Error('new-install speech defaults must remain opt-in')
  }
  await a.click('#guide-next')
  if (process.env.AMADEUS_ONBOARDING_CHOICES_SHOT) {
    await a.screenshot({ path: process.env.AMADEUS_ONBOARDING_CHOICES_SHOT })
  }
  await a.click('#guide-back')
  await a.click('#guide-next')
  await a.check('#guide-voice')
  await a.click('#guide-finish')
  await a.locator('#onboarding').waitFor({ state: 'hidden' })
  await b.locator('#onboarding').waitFor({ state: 'hidden' })
  if (config.getPath('panel.onboardingSeen') !== true || config.getPath('voice.enabled') !== true ||
      config.getPath('broadcast.enabled') !== false) {
    throw new Error('first-use choices were not persisted correctly')
  }
  console.log('PASS  skippable first-use guide persists opt-in choices across windows')
  const accessibility = await a.evaluate(() => {
    document.querySelector('#input').focus()
    return {
      statusRole: document.querySelector('#status-chip')?.getAttribute('role'),
      inputName: document.querySelector('#input')?.getAttribute('aria-label'),
      focusStyle: getComputedStyle(document.querySelector('#input')).outlineStyle,
    }
  })
  if (accessibility.statusRole !== 'status' || !accessibility.inputName || accessibility.focusStyle === 'none') {
    throw new Error(`status/input accessibility regression: ${JSON.stringify(accessibility)}`)
  }
  const layout = await a.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    inputVisible: document.querySelector('#input').getBoundingClientRect().bottom <= window.innerHeight,
  }))
  if (layout.horizontalOverflow || !layout.inputVisible) throw new Error(`300×520 layout regression: ${JSON.stringify(layout)}`)
  if (process.env.AMADEUS_PANEL_SHOT) await a.screenshot({ path: process.env.AMADEUS_PANEL_SHOT })
  console.log('PASS  two independent panel clients connected')

  // Preview the call geometry without queuing a real utterance or ringing.
  await a.evaluate(() => {
    document.querySelector('#phone').classList.add('call-ringing')
    document.querySelector('#call-overlay').classList.remove('hidden')
  })
  const callLayout = await a.evaluate(() => {
    const phone = document.querySelector('#phone').getBoundingClientRect()
    const screen = document.querySelector('#screen').getBoundingClientRect()
    const accept = document.querySelector('#call-accept').getBoundingClientRect()
    const deny = document.querySelector('#call-deny').getBoundingClientRect()
    return {
      ratio: screen.height / phone.height,
      acceptVisible: accept.left >= screen.left && accept.right <= screen.right && accept.bottom <= screen.bottom,
      denyVisible: deny.left >= screen.left && deny.right <= screen.right && deny.bottom <= screen.bottom,
      label: document.querySelector('#call-sub').textContent,
    }
  })
  if (callLayout.ratio < .75 || !callLayout.acceptVisible || !callLayout.denyVisible ||
      callLayout.label !== 'Call from Kurisu.') {
    throw new Error(`incoming-call layout regression: ${JSON.stringify(callLayout)}`)
  }
  if (process.env.AMADEUS_CALL_SHOT) await a.screenshot({ path: process.env.AMADEUS_CALL_SHOT })
  await a.click('#call-deny')
  if (await a.locator('#phone').evaluate((el) => el.classList.contains('call-ringing'))) {
    throw new Error('declining did not restore the regular phone layout')
  }
  console.log('PASS  incoming call fills the screen and restores the keypad after decline')

  // Focus is a user-visible action: ownership must follow the focused tab.
  await a.bringToFront()
  await a.evaluate(() => window.dispatchEvent(new Event('focus')))
  await a.waitForFunction(async (id) => {
    const response = await fetch('/amadeus/status')
    return (await response.json()).events.audioOwner === id
  }, idA)
  hub.enqueueUtterance({ text: '一号窗口测试' })
  await a.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('/amadeus/tts')))
  await a.waitForTimeout(300)
  if (ttsFetches.a !== 1 || ttsFetches.b !== 0) throw new Error(`audio duplicated: ${JSON.stringify(ttsFetches)}`)
  console.log('PASS  focused window alone fetches its speech')

  await b.bringToFront()
  await b.evaluate(() => window.dispatchEvent(new Event('focus')))
  await b.waitForFunction(async (id) => {
    const response = await fetch('/amadeus/status')
    return (await response.json()).events.audioOwner === id
  }, idB)
  hub.enqueueUtterance({ text: '二号窗口测试' })
  await b.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('/amadeus/tts')))
  await b.waitForTimeout(300)
  if (ttsFetches.a !== 1 || ttsFetches.b !== 1) throw new Error(`ownership did not move: ${JSON.stringify(ttsFetches)}`)
  console.log('PASS  focus transfers speech ownership without duplication')

  await a.fill('#input', '双窗口同步测试')
  await a.click('#send')
  await a.waitForFunction(() => document.querySelectorAll('#history .msg').length === 2)
  await b.waitForFunction(() => document.querySelectorAll('#history .msg').length === 2)
  if (!sessions.get(sharedSession.id).messages.some((message) => message.role === 'assistant')) {
    throw new Error('fake model answer was not persisted')
  }
  console.log('PASS  model reply and history synchronise across windows')

  await a.fill('#input', '慢速取消测试')
  await a.click('#send')
  await a.waitForFunction(() => document.querySelector('#send')?.getAttribute('aria-label') === '取消回复')
  await a.click('#send')
  await a.waitForFunction(() => document.querySelector('#send')?.getAttribute('aria-label') === '发送')
  const lastReply = await a.locator('#history .msg.amadeus .bubble').last().innerText()
  if (!lastReply.includes('已取消')) throw new Error(`cancel did not reach the panel: ${lastReply}`)
  await a.click('.tab[data-view="settings"]')
  await a.getByRole('combobox', { name: '音色', exact: true }).selectOption('__import__')
  await a.getByRole('combobox', { name: '音色来源' }).selectOption('dashscope')
  const importLayout = await a.evaluate(() => {
    const pane = document.querySelector('#settings')
    const edge = pane.getBoundingClientRect().right
    const overflow = [...pane.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > edge + 1)
      .slice(0, 6)
      .map((el) => ({ tag: el.tagName, row: el.closest('.row')?.querySelector('.label')?.textContent,
        right: Math.round(el.getBoundingClientRect().right) }))
    return { content: pane.scrollWidth, viewport: pane.clientWidth, overflow }
  })
  if (importLayout.content > importLayout.viewport + 1) {
    throw new Error(`voice import form overflows 300px panel: ${JSON.stringify(importLayout)}`)
  }
  await a.getByRole('textbox', { name: '音色 ID' }).scrollIntoViewIfNeeded()
  if (process.env.AMADEUS_IMPORT_SHOT) await a.screenshot({ path: process.env.AMADEUS_IMPORT_SHOT })
  await a.getByRole('textbox', { name: '音色 ID' }).fill('qwen_clone_test')
  await a.getByRole('button', { name: '添加', exact: true }).click()
  await a.waitForFunction(async () => {
    const response = await fetch('/amadeus/config')
    const { config } = await response.json()
    return config.voice.name === 'qwen_clone_test' &&
      config.voice.provider === 'dashscope' &&
      config.voice.dashscopeModel === 'qwen3-tts-vc-2026-01-22'
  })
  console.log('PASS  an existing cloud voice ID imports without uploading a sample')
  await a.locator('#settings .row').filter({ hasText: '使用引导' }).getByRole('button', { name: '查看' }).click()
  await a.locator('#onboarding').waitFor({ state: 'visible' })
  await a.keyboard.press('Escape') // escaping follows the explicit Skip path
  await a.locator('#onboarding').waitFor({ state: 'hidden' })
  if (config.getPath('voice.enabled') !== true) throw new Error('reopening and skipping changed the saved choice')

  config.update({ panel: { onboardingSeen: false } })
  const c = await (await browser.newContext({ viewport })).newPage()
  c.on('pageerror', (error) => errors.push(`c: ${error.message}`))
  await c.goto(url, { waitUntil: 'domcontentloaded' })
  await c.locator('#onboarding').waitFor({ state: 'visible' })
  await c.click('#guide-skip')
  await c.locator('#onboarding').waitFor({ state: 'hidden' })
  if (config.getPath('panel.onboardingSeen') !== true || config.getPath('voice.enabled') !== true ||
      new ConfigStore(paths).getPath('panel.onboardingSeen') !== true) {
    throw new Error('skipping the guide did not persist safely')
  }
  console.log('PASS  guide can be reopened, escaped, and skipped without changing choices')
  hub.enqueueUtterance({ kind: 'call', text: '来电链路测试', cn: '来电链路测试' })
  await b.locator('#call-overlay').waitFor({ state: 'visible' })
  if (!(await b.locator('#phone').evaluate((el) => el.classList.contains('call-ringing'))) ||
      (await b.locator('#call-sub').textContent()) !== 'Call from Kurisu.') {
    throw new Error('a real call event did not open the retro caller screen')
  }
  await b.click('#call-deny')
  await b.locator('#call-overlay').waitFor({ state: 'hidden' })
  console.log('PASS  real incoming-call event uses the retro screen')
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  console.log('PASS  cancel returns the UI to idle without page errors')
} finally {
  await browser?.close()
  await daemon?.stop()
  const tempRoot = path.resolve(path.dirname(paths.dataRoot))
  if (path.dirname(tempRoot) !== path.resolve(os.tmpdir()) ||
      !path.basename(tempRoot).startsWith(`amadeus-test-${process.pid}-`)) {
    throw new Error(`refusing to remove unexpected temporary path: ${tempRoot}`)
  }
  cleanup(paths)
}
