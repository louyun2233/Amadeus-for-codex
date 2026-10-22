// Panel entry point: wires transport, audio, avatar and views together.
//
// Robustness rules owned here:
//  - a turn is only rendered when its turnId matches the turn this tab started
//  - every wait is bounded: chat turns, playback, and the SSE gap mid-turn
//  - the render loop is wrapped, so one throw degrades to the placeholder
//    instead of silently freezing the frame

import { createTransport } from './transport.js'
import { createAudioQueue } from './audio-queue.js'
import { createLive2D } from './live2d.js'
import { createPlaceholder } from './placeholder.js'
import { createMotionSequence, maySpeakTap } from './sfx.js'
import { createRingtone } from './ringtone.js'
import { modelAssetUrl, runtimeAssetUrl } from './asset-urls.js'
import { createOnboarding } from './onboarding.js'
import { createChatView, createMemoryView, createSettingsView, createDiagView } from './views.js'
import { speakWelcomeWhenReady } from './welcome.js'

const $ = (id) => document.getElementById(id)

// The launcher opens this page as its own window (`#app-WxH`, or `?app=1` by
// hand). A fragment is used because it survives the token-exchange redirect.
// The window is also resized from here: Chromium quietly ignores
// --window-size when the browser is already running, and a phone-sized window
// is the whole point of this mode.
const appMatch = /#app(?:-(\d+)x(\d+))?/.exec(location.hash)
// The watcher adds this fragment only on a new Codex launch. Remove it before
// doing anything asynchronous so a refresh or SSE reconnect cannot repeat it.
const welcomeRequested = /(?:^|&)welcome=1(?:&|$)/.test(location.hash.slice(1))
if (welcomeRequested) {
  history.replaceState(null, '', location.pathname + location.search + location.hash.replace(/&?welcome=1(?:&|$)/, ''))
}
if (appMatch || new URLSearchParams(location.search).get('app') === '1') {
  document.documentElement.dataset.mode = 'app'
  const askedW = Number(appMatch?.[1] || 0)
  const askedH = Number(appMatch?.[2] || 0)
  if (askedW >= 200 && askedH >= 300) {
    const fit = () => {
      // Never more than ~72% of the screen height: on a scaled display the
      // work area can be surprisingly short, and a phone-shaped window should
      // still leave room for the work behind it. The aspect ratio is kept.
      const maxH = Math.max(400, Math.round(screen.availHeight * 0.72))
      const maxW = Math.max(260, Math.round(screen.availWidth * 0.52))
      let height = Math.min(askedH, maxH)
      let width = Math.round(height * (askedW / askedH))
      if (width > maxW) {
        width = maxW
        height = Math.round(width * (askedH / askedW))
      }
      width = Math.max(240, width)
      height = Math.max(400, height)
      try {
        window.resizeTo(width, height)
      } catch {
        /* blocked: the layout still caps the phone to a normal size */
      }
    }
    // Once after paint, and once more after the 302/cookie handshake settles.
    setTimeout(fit, 250)
    window.addEventListener('load', () => setTimeout(fit, 150))
  }
}

// The backend stops a model run after 60s; leave time for its error event.
const TURN_TIMEOUT_MS = 75000
const OFFLINE_GRACE_MS = 20000

const transport = createTransport()

const state = {
  config: null,
  assets: null,
  secrets: null,
  voices: null,
  speechInput: null,
  characterContent: null,
  sessionId: null,
  emotion: 'neutral',
  pendingTurn: null,
}

let live2d = null
const motionSequence = createMotionSequence()
let avatarMode = null
let loopBroken = false
let lastFrame = 0
let offlineTimer = null
let welcomeCancelled = false

const fallbackCanvas = $('avatar-fallback')
const liveCanvas = $('avatar')
const placeholder = createPlaceholder(fallbackCanvas)

function applyAvatarMode(mode) {
  if (avatarMode === mode) return
  avatarMode = mode
  liveCanvas.hidden = mode !== 'live2d'
  fallbackCanvas.hidden = mode !== 'placeholder'
}

function showAssetNote(text, { install = false } = {}) {
  const note = $('asset-note')
  note.innerHTML = ''
  const span = document.createElement('span')
  span.textContent = text
  note.appendChild(span)
  if (install) {
    const btn = document.createElement('button')
    btn.className = 'btn-ghost'
    btn.style.marginLeft = '8px'
    btn.textContent = '安装素材'
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = '安装中…'
      try {
        const res = await transport.api('/amadeus/assets/install', { method: 'POST', body: {} })
        if (res && res.ok) {
          note.classList.add('hidden')
          await loadAvatar()
          return
        }
        span.textContent = `安装失败：${describeInstallFailure(res)}`
      } catch (e) {
        span.textContent = `安装失败：${e.message}`
      } finally {
        btn.disabled = false
        btn.textContent = '重试'
      }
    })
    note.appendChild(btn)
  }
  note.classList.remove('hidden')
}

function describeInstallFailure(res) {
  const bad = (res && res.results ? res.results : []).filter((r) => r.ok === false)
  if (bad.length) return bad.map((r) => `${r.id}: ${r.error || '失败'}`).join('; ')
  return (res && (res.error || res.reason)) || '失败'
}

function degradeToPlaceholder(reason) {
  if (live2d) {
    try {
      live2d.dispose()
    } catch {
      /* ignore */
    }
    live2d = null
  }
  applyAvatarMode('placeholder')
  showAssetNote(`已退回占位图：${reason}`)
}

function fitCanvases() {
  const rect = $('avatar-wrap').getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  if (w < 10 || h < 10) return
  fallbackCanvas.width = w
  fallbackCanvas.height = h
  if (live2d) live2d.setCanvasSize(w, h)
  else {
    liveCanvas.width = w
    liveCanvas.height = h
  }
}

async function loadAvatar() {
  fitCanvases()
  let status
  try {
    status = await transport.api('/amadeus/assets/status')
  } catch (e) {
    showAssetNote(`无法读取素材状态：${e.message}`)
    return
  }
  state.assets = status

  const packs = status.packs || []
  const model = Object.hasOwn(status, 'activeModel') ? status.activeModel : packs.find((p) => p.kind === 'model')
  const runtime = Object.hasOwn(status, 'activeRuntime') ? status.activeRuntime : packs.find((p) => p.kind === 'runtime')
  if (!model || !model.installed) return showAssetNote('Live2D 模型未安装。', { install: true })
  if (!runtime || !runtime.installed) return showAssetNote('缺少 Cubism 2 运行时（live2d.min.js）。', { install: true })
  if (!runtime.matches) return showAssetNote('运行时文件哈希不匹配，需要重新安装。', { install: true })

  const modelUrl = modelAssetUrl(model)
  const runtimeUrl = runtimeAssetUrl(runtime)
  if (!modelUrl || !runtimeUrl) return showAssetNote('素材入口缺失：请重启 Amadeus 服务。')

  try {
    live2d = createLive2D({
      canvas: liveCanvas,
      vendorBase: '/amadeus/panel/vendor/',
      runtimeUrl,
      modelUrl,
      layout: model.layout || undefined,
      expressionMap: model.expressionMap || {},
      motionMap: model.motionMap || {},
      parameterMap: model.parameterMap || {},
      onContextLost: () => degradeToPlaceholder('WebGL 上下文丢失'),
    })
    await live2d.init()
    // The UI harness reads this: a WebGL canvas cannot be read back reliably,
    // so "is the character centred" has to come from the renderer's own numbers.
    window.__amadeusAvatar = () => (live2d && live2d.ready ? live2d.debugInfo() : null)
    $('asset-note').classList.add('hidden')
    applyAvatarMode('live2d')
    bindAvatarTap()
  } catch (e) {
    degradeToPlaceholder(e.message)
    transport.report('warn', 'live2d init failed', e.message, 'avatar')
  }
}

function bindAvatarTap() {
  if (liveCanvas.dataset.tapBound === '1') return
  liveCanvas.dataset.tapBound = '1'
  liveCanvas.addEventListener('pointerdown', (ev) => {
    if (!live2d || !live2d.ready) return
    const rect = liveCanvas.getBoundingClientRect()
    const x = ((ev.clientX - rect.left) / rect.width) * liveCanvas.width
    const y = ((ev.clientY - rect.top) / rect.height) * liveCanvas.height
    const area = live2d.hitTest(x, y)
    const action = area === 'head' ? 'head' : area === 'body' ? 'body' : 'other'
    const motion = state.assets?.activeModel?.motionMap?.[action]
    const index = motionSequence.next(action, motion?.variants || 3)
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      live2d.playMotion(action, index)
    }
    playTapReaction()
  })
}

const audio = createAudioQueue({
  transport,
  onStatus: (text) => setStatus(text, 'warn'),
  onEmotion: (emotion) => setEmotion(emotion),
})

/**
 * What a tap on her sounds like.
 *
 * Taps use a short line through the selected voice provider. Imported media
 * is reserved for non-speech notifications and the incoming-call ring.
 */
const TAP_REACTION_GAP_MS = 2500
let lastTapReactionAt = 0

async function playTapReaction() {
  // A decorative tap must not speak over, or queue an unrelated line behind,
  // the user's actual answer. The motion still plays for immediate feedback.
  if (!maySpeakTap({
    voiceEnabled: state.config?.voice?.enabled !== false,
    turnPending: Boolean(state.pendingTurn),
    speechBusy: audio.isBusy(),
    callPending: Boolean(pendingCall),
  })) return
  const now = Date.now()
  if (now - lastTapReactionAt < TAP_REACTION_GAP_MS) return
  lastTapReactionAt = now
  const lines = state.characterContent?.tapReactions || []
  if (lines.length === 0) return
  const line = lines[Math.floor(Math.random() * lines.length)]
  try {
    await transport.api('/amadeus/say', {
      method: 'POST',
      body: { text: line.text, emotion: line.emotion },
    })
  } catch (e) {
    // A reaction is decoration: never let it break the tap handling.
    transport.report('info', 'tap reaction skipped', e && e.message ? e.message : String(e), 'audio')
  }
}

/**
 * The ring lives on its own element and never touches the speech queue.
 *
 * `voice.ringEnabled`/`voice.ringVolume` are settings; a call with no ring
 * sound available still shows the overlay and speaks her line as before.
 */
const ringtone = createRingtone({
  element: $('ring'),
  onStatus: (status, detail) => {
    if (status === 'blocked') {
      $('call-ring-status').textContent = '点击面板启用来电铃声'
      transport.report('info', 'call ring held until first gesture', detail, 'audio')
    } else if (status === 'unavailable') {
      $('call-ring-status').textContent = '铃声播放失败，请检查声音设置'
      transport.report('warn', 'call ring unavailable', detail, 'audio')
    } else if (status === 'playing' || status === 'stopped') {
      $('call-ring-status').textContent = ''
    }
  },
  armGestureRetry: (retry) => {
    const once = () => {
      document.removeEventListener('pointerdown', once)
      document.removeEventListener('keydown', once)
      retry()
    }
    document.addEventListener('pointerdown', once, { once: true })
    document.addEventListener('keydown', once, { once: true })
  },
})

function ringVolume() {
  const configured = state.config?.voice?.ringVolume
  return typeof configured === 'number' ? configured : 0.7
}

function ringEnabled() {
  return state.config?.voice?.ringEnabled !== false && state.config?.voice?.enabled !== false
}

function setEmotion(emotion) {
  state.emotion = emotion || 'neutral'
  if (live2d && live2d.ready) live2d.setEmotion(state.emotion)
}

function setStatus(text, kind) {
  $('status-text').textContent = text
  const chip = $('status-chip')
  chip.classList.toggle('off', kind === 'off')
  chip.classList.toggle('warn', kind === 'warn')
}

async function refreshStatus() {
  try {
    const data = await transport.api('/amadeus/status')
    state.config = data.config
    state.secrets = data.secrets || {}
    state.speechInput = data.speechInput || null
    state.characterContent = data.characterContent || null
    if (state.characterContent?.displayName) {
      $('call-name').textContent = state.characterContent.displayName
      $('input').placeholder = `和 ${state.characterContent.displayName} 说话…`
    }
    if (settings) settings.setConfig(data.config)
    setStatus(`${(data.voice && data.voice.provider) || '—'} · 记忆 ${(data.memory && data.memory.panel && data.memory.panel.total) || 0}`)
  } catch (e) {
    setStatus('host 不可达', 'off')
  }
}

/** 默认 + 导入的音色列表；失败时面板退回「默认」而不是留空。 */
async function refreshVoices() {
  try {
    state.voices = await transport.api('/amadeus/voices')
  } catch {
    state.voices = null
  }
  if (settings) settings.sync()
}

const chat = createChatView({ onSend: () => send(), onCancel: () => cancelTurn(), onToggleMic: () => toggleMic() })

const settings = createSettingsView({
  api: transport.api,
  report: transport.report,
  onConfigChanged: (cfg) => {
    state.config = cfg
    settings.setConfig(cfg)
  },
  getAssetStatus: () => state.assets,
  onInstallAssets: async () => {
    const res = await transport.api('/amadeus/assets/install', { method: 'POST', body: {} })
    state.assets = await transport.api('/amadeus/assets/status')
    if (!res.ok) throw new Error(describeInstallFailure(res))
  },
  onReloadAvatar: () => loadAvatar(),
  getSecrets: () => state.secrets || {},
  onSecretsChanged: () => refreshStatus(),
  getVoices: () => state.voices,
  onVoicesChanged: () => refreshVoices(),
  onOpenGuide: () => onboarding.open({ force: true }),
})

const onboarding = createOnboarding({
  api: transport.api,
  getConfig: () => state.config,
  onConfigChanged: (cfg) => {
    state.config = cfg
    settings.setConfig(cfg)
  },
})

const memoryView = createMemoryView({ api: transport.api, report: transport.report })
const diagView = createDiagView({ api: transport.api, report: transport.report })

function showView(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name))
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name))
  if (name === 'memory') memoryView.refresh()
  if (name === 'settings') settings.sync()
  if (name === 'diag') diagView.run()
}

function clearTurn(finish) {
  const turn = state.pendingTurn
  state.pendingTurn = null
  if (turn) clearTimeout(turn.timer)
  if (offlineTimer) {
    clearTimeout(offlineTimer)
    offlineTimer = null
  }
  chat.setBusy(false)
  if (finish && turn) finish(turn)
}

async function send() {
  if (state.pendingTurn) return
  const text = chat.value().trim()
  if (!text) return
  welcomeCancelled = true
  chat.clearInput()
  chat.addUser(text)
  chat.beginStream()
  chat.setBusy(true)

  const turn = {
    turnId: null, startedAt: Date.now(), timer: null,
    cancelRequested: false, cancelSent: false, earlyEvents: [],
  }
  turn.timer = setTimeout(() => {
    if (state.pendingTurn !== turn) return
    if (turn.turnId) {
      transport.api('/amadeus/chat/cancel', { method: 'POST', body: { turnId: turn.turnId } }).catch(() => {})
    }
    clearTurn(() => chat.finishStream('⚠ 等待回复超时，请重试。', { error: true }))
    transport.report('error', 'turn timed out', String(TURN_TIMEOUT_MS), 'chat')
  }, TURN_TIMEOUT_MS)
  state.pendingTurn = turn

  try {
    const res = await transport.api('/amadeus/chat', {
      method: 'POST',
      body: { sessionId: state.sessionId, text },
    })
    if (state.pendingTurn !== turn) {
      if (res.turnId) {
        transport.api('/amadeus/chat/cancel', { method: 'POST', body: { turnId: res.turnId } }).catch(() => {})
      }
      return
    }
    turn.turnId = res.turnId
    if (res.sessionId) state.sessionId = res.sessionId
    for (const event of turn.earlyEvents) handleTurnEvent(event.type, event.data)
    turn.earlyEvents.length = 0
    if (turn.cancelRequested) cancelTurn()
  } catch (e) {
    clearTurn(() => chat.finishStream('⚠ ' + e.message, { error: true }))
    transport.report('error', 'chat request failed', e.message, 'chat')
  }
}

function cancelTurn() {
  const turn = state.pendingTurn
  if (!turn) return
  turn.cancelRequested = true
  if (!turn.turnId || turn.cancelSent) return
  turn.cancelSent = true
  transport.api('/amadeus/chat/cancel', {
    method: 'POST', body: { turnId: turn.turnId },
  }).catch((e) => transport.report('warn', 'chat cancel failed', e.message, 'chat'))
}

/**
 * A call rings first and is spoken once it is answered.
 *
 * Ringing and talking at the same time made the ring inaudible and the line
 * hard to follow, so the spoken line waits in `pendingCall` until the user
 * picks up; declining drops it.
 */
let pendingCall = null

/**
 * Tell the hub the call line arrived.
 *
 * The line is deliberately *not* queued for speech yet, so the audio queue
 * cannot acknowledge it - and an unacknowledged utterance is re-sent (and would
 * ring again) until the hub gives up and drops it.
 */
async function ackHeldUtterance(id) {
  if (id === undefined || id === null) return
  try {
    await transport.api('/amadeus/utterance/ack', { method: 'POST', body: { id, status: 'ok' } })
  } catch {
    /* the hub retries on its own; a failed ack must not break the overlay */
  }
}

function deliverUtterance(item) {
  if (!item) return
  welcomeCancelled = true
  if (item.kind === 'call') {
    $('call-sub').textContent = item.cn || item.text || '来电中…'
    $('call-ring-status').textContent = ''
    $('call-overlay').classList.remove('hidden')
    pendingCall = item
    if (ringEnabled()) ringtone.start('/amadeus/sound/incoming', ringVolume())
    else $('call-ring-status').textContent = '铃声已在设置中关闭'
    ackHeldUtterance(item.id)
    return
  }
  audio.enqueue(item)
  if (item.kind === 'broadcast' && item.cn) chat.addAssistant(item.cn)
}

transport.on('open', ({ resumed }) => {
  setStatus('已连接')
  if (resumed) transport.report('info', 'sse reconnected', '', 'transport')
})

transport.on('offline', () => {
  setStatus('离线，重连中…', 'off')
  if (!state.pendingTurn || offlineTimer) return
  offlineTimer = setTimeout(() => {
    offlineTimer = null
    if (!state.pendingTurn) return
    clearTurn(() => chat.finishStream('⚠ 连接中断，回复可能已丢失，请重试。', { error: true }))
  }, OFFLINE_GRACE_MS)
})

// The daemon sends the queue in `hello` for the first owner, and again in
// `pending` whenever ownership is handed over (focus change, tab closed).
function deliverPending(data) {
  for (const item of (data && data.pending) || []) deliverUtterance(item)
}
transport.on('hello', deliverPending)
transport.on('pending', deliverPending)

// Informational: only the owner receives speech, so this is just for the status
// line and for support diagnostics.
transport.on('audio-owner', (data) => {
  if (!data || !data.owner) return
  if (data.owner !== transport.clientId()) setStatus('语音由另一个标签页播放', 'warn')
  else refreshStatus()
})

// Another tab committed a message; keep this tab's history in sync instead of
// leaving it stale until a manual reload.
transport.on('session:append', (data) => {
  if (!data || !data.message) return
  if (data.sessionId !== state.sessionId) return
  if (data.origin === transport.clientId()) return // already rendered live here
  chat.appendMessage(data.message)
})
transport.on('utterance', deliverUtterance)

function handleTurnEvent(type, data) {
  const turn = state.pendingTurn
  if (!turn || !data?.turnId) return
  // The SSE stream can outrun the POST response on a fast local model.
  if (!turn.turnId) {
    if (turn.earlyEvents.length < 300) turn.earlyEvents.push({ type, data })
    return
  }
  if (data.turnId !== turn.turnId) return
  if (type === 'turn:status') {
    const labels = {
      preparing: '正在准备对话…',
      connecting: '正在连接模型…',
      generating: '已连接，等待回答…',
      retrying: '模型连接超时，正在重试…',
      reply: '正在接收回答…',
    }
    if (labels[data.phase]) chat.setWaitStatus(labels[data.phase])
  } else if (type === 'chunk') {
    chat.appendStream(data.delta || '')
  } else if (type === 'turn:done') {
    clearTurn(() => chat.finishStream(data.zh || data.ja || ''))
    if (data.emotion && state.config?.voice?.enabled === false) setEmotion(data.emotion)
    if (data.closed) {
      state.sessionId = null
      setStatus('已断开（单句模式）', 'off')
    }
  } else if (type === 'turn:error') {
    if (data.code === 'cancelled') clearTurn(() => chat.finishStream('已取消'))
    else clearTurn(() => chat.finishStream('⚠ ' + (data.error || '出错了'), { error: true }))
  }
}

for (const type of ['turn:status', 'chunk', 'turn:done', 'turn:error']) {
  transport.on(type, (data) => handleTurnEvent(type, data))
}

transport.on('config', (data) => {
  if (data && data.config) {
    state.config = data.config
    settings.setConfig(data.config)
    onboarding.sync(data.config)
  }
})
transport.on('degraded', (data) => setStatus('降级：' + ((data && (data.reason || data.kind)) || '?'), 'warn'))
transport.on('memory', () => refreshStatus())

// The daemon emits install progress; without a handler the user stares at
// "安装中…" for the whole 8.6 MB download.
transport.on('assets:progress', (data) => {
  if (!data) return
  if (data.phase === 'download' && data.total) {
    const pct = Math.min(100, Math.round((data.received / data.total) * 100))
    setStatus(`下载素材 ${pct}%`)
  } else if (data.phase === 'extract') {
    setStatus('解压素材…')
  } else if (data.phase === 'cached') {
    setStatus('素材已缓存')
  } else if (data.phase === 'done') {
    setStatus('素材已安装')
    refreshStatus()
  }
})

// `shutdown` arrives just before the daemon exits; say so instead of leaving a
// stale status line behind.
transport.on('shutdown', () => {
  setStatus('daemon 已停止', 'off')
  audio.clear()
  pendingCall = null
  ringtone.stop('shutdown')
})

// the hub cleared its queue (manual clear); drop anything buffered locally too
transport.on('cleared', () => {
  audio.clear()
  pendingCall = null
  ringtone.stop('cleared')
})

// One mic button, two channels: `browser` uses the platform recogniser (needs
// no key; the browser may use an online recognition service), `api` records here and lets the daemon transcribe.
// Whichever ran, the button has to end up usable again, so every path funnels
// through resetMic() and no path leaves a stream or a timer behind.

const RECORD_MAX_MS = 60000
let recognition = null
let recorder = null
let recorderTimer = null
let micOn = false
let micStarting = false

function speechProvider() {
  const st = state.speechInput
  if (st && st.provider) return st
  // No status yet (first paint, or the daemon is down): behave like the default
  // configuration instead of refusing to open the microphone.
  return { provider: 'browser', ready: true, reason: '' }
}

function resetMic() {
  micOn = false
  clearTimeout(recorderTimer)
  recorderTimer = null
  recorder = null
  recognition = null
  chat.setMicActive(false)
}

function stopTracks(stream) {
  try {
    for (const track of stream.getTracks()) track.stop()
  } catch {
    /* nothing to stop */
  }
}

function stopMic() {
  if (recorder) {
    try {
      recorder.stop()
      return
    } catch {
      /* already stopped */
    }
  }
  try {
    recognition?.stop()
  } catch {
    /* already stopped */
  }
}

function toggleMic() {
  if (micOn) {
    stopMic()
    return
  }
  if (micStarting) return
  const st = speechProvider()
  if (st.provider === 'none') {
    chat.addSystem('语音输入已在设置里关闭。')
    return
  }
  if (st.provider === 'api') recordForApi()
  else startBrowserRecognition()
}

/** Platform recogniser: no key and no upload, but it has to exist. */
function startBrowserRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    chat.addSystem('这个浏览器没有语音识别，可以把语音输入改成 API。')
    return
  }
  recognition = new SR()
  recognition.lang =
    (state.config && state.config.speechInput && state.config.speechInput.lang) || 'zh-CN'
  recognition.interimResults = false
  recognition.continuous = false
  recognition.onend = () => resetMic()
  recognition.onerror = (ev) => {
    const code = (ev && ev.error) || '?'
    resetMic()
    setStatus('语音输入错误：' + code, 'warn')
    transport.report('warn', 'speech recognition error', code, 'mic')
  }
  recognition.onresult = (ev) => {
    let text = ''
    for (let i = 0; i < ev.results.length; i++) {
      if (ev.results[i][0]) text += ev.results[i][0].transcript
    }
    if (!text) return
    $('input').value = text.trim()
    send()
  }
  try {
    recognition.start()
    micOn = true
    chat.setMicActive(true)
  } catch (e) {
    resetMic()
    setStatus('麦克风启动失败', 'warn')
    transport.report('warn', 'mic start failed', e.message, 'mic')
  }
}

/**
 * Record locally and let the daemon transcribe. A transcript that never
 * arrives must not cost the user the feature: `missing-key` and `use-browser`
 * both fall back to the platform recogniser, and `mic-disabled` explains itself
 * instead of silently doing nothing.
 */
async function recordForApi() {
  const MR = window.MediaRecorder
  const hasGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  if (!MR || !hasGetUserMedia) {
    chat.addSystem('这个浏览器不能录音，已改用系统语音识别。')
    startBrowserRecognition()
    return
  }

  micStarting = true
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    micStarting = false
    setStatus('无法访问麦克风', 'warn')
    transport.report('warn', 'microphone unavailable', e.message, 'mic')
    return
  }
  micStarting = false

  let fallback = ''
  try {
    const blob = await new Promise((resolve, reject) => {
      const chunks = []
      const rec = new MR(stream)
      recorder = rec
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data)
      }
      rec.onerror = (ev) => reject(new Error((ev && ev.error && ev.error.name) || 'recorder error'))
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
      recorderTimer = setTimeout(() => {
        try {
          rec.stop()
        } catch {
          /* already stopped */
        }
      }, RECORD_MAX_MS)
      rec.start()
      micOn = true
      chat.setMicActive(true)
    })
    if (!blob.size) throw new Error('没录到声音')
    const out = await transport.api('/amadeus/stt', { method: 'POST', body: blob })
    const text = String((out && out.text) || '').trim()
    if (!text) {
      setStatus('没听清，再说一次', 'warn')
      return
    }
    $('input').value = text
    send()
  } catch (e) {
    const degrade = (e && e.degrade) || ''
    if (degrade === 'use-browser' || degrade === 'missing-key') fallback = 'browser'
    else if (degrade === 'mic-disabled') fallback = 'off'
    else {
      setStatus('语音输入失败', 'warn')
      transport.report('warn', 'stt request failed', (e && e.message) || '?', 'mic')
    }
  } finally {
    resetMic()
    stopTracks(stream)
  }

  if (fallback === 'browser') {
    chat.addSystem('语音 API 不可用，改用系统语音识别。')
    startBrowserRecognition()
  } else if (fallback === 'off') {
    chat.addSystem('语音输入已在设置里关闭。')
  }
}

function loop(now) {
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016
  lastFrame = now
  const mouth = audio.mouthValue(now)
  try {
    if (live2d && live2d.ready) {
      applyAvatarMode('live2d')
      live2d.setMouth(mouth)
      live2d.update(dt)
    } else {
      applyAvatarMode('placeholder')
      placeholder.draw(now, { emotion: state.emotion, mouth })
    }
  } catch (e) {
    if (!loopBroken) {
      loopBroken = true
      transport.report('error', 'render loop threw', e.message, 'render')
      degradeToPlaceholder('渲染异常：' + e.message)
    }
  }
  requestAnimationFrame(loop)
}

window.addEventListener('error', (ev) => {
  transport.report('error', ev.message, (ev.filename || '') + ':' + (ev.lineno || 0), 'window')
})
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason
  transport.report('error', 'unhandledrejection', String((reason && reason.message) || reason), 'window')
})

$('call-accept').addEventListener('click', () => {
  ringtone.stop('answered')
  $('call-overlay').classList.add('hidden')
  const item = pendingCall
  pendingCall = null
  // She speaks once the call is picked up, not over the ring.
  if (item) audio.enqueue(item)
})
$('call-deny').addEventListener('click', () => {
  ringtone.stop('declined')
  $('call-overlay').classList.add('hidden')
  pendingCall = null
})
$('refresh').addEventListener('click', async () => {
  await refreshStatus()
  try {
    state.assets = await transport.api('/amadeus/assets/status')
  } catch {
    /* keep the previous snapshot */
  }
  settings.sync()
})
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)))

function tickClock() {
  const d = new Date()
  $('clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
tickClock()
setInterval(tickClock, 10000)

if (window.ResizeObserver) {
  let resizeTimer = null
  new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      fitCanvases()
      if (live2d) live2d.relayout()
    }, 150)
  }).observe($('avatar-wrap'))
} else {
  window.addEventListener('resize', () => {
    fitCanvases()
    if (live2d) live2d.relayout()
  })
}

chat.mount()
memoryView.mount()
settings.mount()
diagView.mount()

// Speech follows attention: whichever tab is focused owns audio, so the user
// never has to wonder which window is talking (or hear it twice).
function claimAudio() {
  transport.api('/amadeus/client/active', { method: 'POST', body: {} }).catch(() => {})
}
window.addEventListener('focus', claimAudio)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) claimAudio()
})

;(async function boot() {
  transport.connect()
  claimAudio()
  await refreshStatus()
  onboarding.showIfNeeded()
  await refreshVoices()
  try {
    const sessions = await transport.api('/amadeus/sessions')
    // In one-shot mode the newest session is usually already closed: showing it
    // would mean "reading history", so only an open one is resumed.
    let list = (sessions.sessions || []).filter((s) => !s.endedAt)
    if (list.length === 0) {
      const created = await transport.api('/amadeus/sessions', { method: 'POST', body: {} })
      list = [created.session]
    }
    state.sessionId = list[0].id
    const msgs = await transport.api('/amadeus/sessions/' + state.sessionId + '/messages')
    chat.renderHistory(msgs.messages)
  } catch (e) {
    chat.addSystem('会话加载失败：' + e.message)
    transport.report('error', 'session load failed', e.message, 'boot')
  }
  await loadAvatar()
  requestAnimationFrame(loop)
  // Never guess a provider when the first status request raced daemon startup.
  // A missing config would bypass the local-clone gate and queue the greeting.
  if (welcomeRequested && !state.config) {
    for (let attempt = 0; attempt < 3 && !state.config; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await refreshStatus()
    }
  }
  const welcome = state.characterContent?.welcome
  if (welcomeRequested && welcome && state.config && state.config.voice?.enabled !== false && !welcomeCancelled && !pendingCall && !audio.isBusy()) {
    try {
      const result = await speakWelcomeWhenReady({
        provider: state.config?.voice?.provider,
        prepare: () => transport.api('/amadeus/tts/prepare', {
          method: 'POST',
          body: { text: welcome.text, emotion: welcome.emotion },
        }),
        speak: () => transport.api('/amadeus/say', {
          method: 'POST',
          body: { text: welcome.text, emotion: welcome.emotion },
        }),
        shouldCancel: () => welcomeCancelled || Boolean(state.pendingTurn) || Boolean(pendingCall) || audio.isBusy(),
        onWaiting: () => setStatus('克隆音色启动中，开场白稍后播放…', 'warn'),
        onTimeout: (error) => {
          setStatus('克隆音色未就绪，请检查本地 Qwen 服务', 'warn')
          transport.report('warn', 'welcome voice unavailable', error?.message || '', 'audio')
        },
      })
      if (result === 'sent' && state.config.voice?.provider === 'qwen-local') setStatus('克隆音色已就绪')
    } catch (e) {
      transport.report('warn', 'welcome speech failed', e.message, 'audio')
    }
  }
})()
