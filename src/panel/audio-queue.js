/**
 * Speech playback queue.
 *
 * The previous implementation could stall forever: it awaited `onended`
 * without any watchdog, so a single missing event froze every later utterance
 * and left object URLs dangling. This version owns:
 *   - the watchdog (bounded playback)
 *   - de-duplication by utterance id
 *   - object URL cleanup on every path
 *   - the mouth value derived from audio energy + word timings
 */

const PLAY_TIMEOUT_FLOOR_MS = 45000
const SEEN_LIMIT = 300

function decodeWords(header) {
  if (!header) return []
  try {
    const json = decodeURIComponent(escape(atob(header)))
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function synthesisFailureMessage(res) {
  let detail = ''
  try {
    const body = await res.json()
    detail = typeof body?.error === 'string' ? body.error.replace(/\s+/g, ' ').trim() : ''
  } catch {
    // An upstream or proxy error may not have a JSON body.
  }
  if (/Model not exist\./i.test(detail)) {
    return '阿里云复刻模型不可用：请检查 API Key 所属地域和模型权限'
  }
  if (/InvalidApiKey|Invalid API-key/i.test(detail)) {
    return '阿里云语音密钥无效：请核对密钥及所属地域'
  }
  if (/no Aliyun.*key configured/i.test(detail)) {
    return '未配置阿里云语音密钥：请在设置中填写'
  }
  return detail ? `合成失败（HTTP ${res.status}）：${detail.slice(0, 120)}` : `合成失败 HTTP ${res.status}`
}

export function createAudioQueue({ transport, onStatus = () => {}, onEmotion = () => {} }) {
  const queue = []
  const seen = new Set()
  const seenOrder = []
  let playing = false
  let player = null
  let actx = null
  let analyser = null
  let sample = null
  let currentWords = []
  let startedAt = 0
  let speaking = false
  // Chromium refuses to start audio until the page has been interacted with.
  // An app window normally launches with --autoplay-policy=no-user-gesture-
  // required, but a plain browser tab does not - and a blocked line used to be
  // acked as failed and dropped, which is exactly "she never answers".
  const blocked = []
  let unlockArmed = false

  function isAutoplayBlock(e) {
    const message = String((e && e.message) || '')
    return (
      (e && e.name === 'NotAllowedError') ||
      /user didn't interact|autoplay|not allowed/i.test(message)
    )
  }

  function armUnlock() {
    if (unlockArmed) return
    unlockArmed = true
    const unlock = () => {
      unlockArmed = false
      if (actx && actx.state === 'suspended') actx.resume().catch(() => {})
      if (blocked.length > 0) {
        // Put them back in order; the ids are already marked as seen, and this
        // path does not go through enqueue(), so nothing is filtered out.
        queue.unshift(...blocked.splice(0, blocked.length))
      }
      pump()
    }
    document.addEventListener('pointerdown', unlock, { once: true })
    document.addEventListener('keydown', unlock, { once: true })
  }

  function remember(id) {
    if (id === undefined || id === null) return false
    if (seen.has(id)) return true
    seen.add(id)
    seenOrder.push(id)
    while (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift())
    return false
  }

  function ensurePlayer() {
    if (!player) {
      player = document.getElementById('player') || document.createElement('audio')
      player.preload = 'auto'
    }
    return player
  }

  function attachAnalyser() {
    if (!player || analyser !== null) return
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      actx = new AC()
      const src = actx.createMediaElementSource(player)
      analyser = actx.createAnalyser()
      analyser.fftSize = 512
      sample = new Uint8Array(analyser.fftSize)
      src.connect(analyser)
      analyser.connect(actx.destination)
    } catch {
      // MediaElementSource can only be created once per element; if it fails we
      // simply fall back to the word-timing envelope.
      analyser = null
      sample = null
    }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {})
  }

  function energy() {
    if (!analyser || !sample) return 0
    analyser.getByteTimeDomainData(sample)
    let sum = 0
    for (let i = 0; i < sample.length; i++) {
      const v = (sample[i] - 128) / 128
      sum += v * v
    }
    return Math.min(1, Math.sqrt(sum / sample.length) * 3.2)
  }

  function waitForEnd(el, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        el.onended = null
        el.onerror = null
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        try {
          el.pause()
        } catch {
          /* ignore */
        }
        finish(new Error('播放超时'))
      }, timeoutMs)
      el.onended = () => finish()
      el.onerror = () => finish(new Error('音频解码失败'))
    })
  }

  async function ack(id, status, detail) {
    if (id === undefined || id === null) return
    try {
      await transport.api('/amadeus/utterance/ack', { method: 'POST', body: { id, status, detail } })
    } catch (e) {
      transport.report('warn', 'ack failed', e.message, 'audio')
    }
  }

  function speechUrl(item) {
    return (
      '/amadeus/tts?text=' + encodeURIComponent(item.text) + '&emotion=' + encodeURIComponent(item.emotion || 'neutral')
    )
  }

  async function fetchSpeech(item) {
    const res = await fetch(speechUrl(item), { cache: 'no-store' })
    if (!res.ok) throw new Error(await synthesisFailureMessage(res))
    const words = decodeWords(res.headers.get('X-Amadeus-Words'))
    const blob = await res.blob()
    return { blob, words }
  }

  /**
   * Synthesize the next line while the current one is playing.
   *
   * A reply arrives as one utterance per sentence and each one used to be
   * synthesized only after the previous sentence had finished: every sentence
   * boundary was a cloud round trip of silence, which is the stutter that was
   * reported. Prefetching hides that latency; the result is dropped if the line
   * was cleared or already spoken.
   */
  const prefetched = new Map()
  const prefetching = new Set()

  function prefetchNext() {
    const next = queue[0]
    if (!next || prefetched.has(next.id) || prefetching.has(next.id)) return
    prefetching.add(next.id)
    fetchSpeech(next)
      .then((speech) => prefetched.set(next.id, { speech }))
      .catch((e) => prefetched.set(next.id, { error: e }))
      .finally(() => prefetching.delete(next.id))
  }

  async function pump() {
    if (playing || queue.length === 0) return
    playing = true
    const item = queue.shift()
    let objectUrl = null
    try {
      const ready = prefetched.get(item.id)
      prefetched.delete(item.id)
      let speech = ready?.speech || null
      if (!speech) {
        if (ready?.error) throw ready.error
        speech = await fetchSpeech(item)
      }

      currentWords = speech.words
      objectUrl = URL.createObjectURL(speech.blob)
      const el = ensurePlayer()
      attachAnalyser()
      el.src = objectUrl
      onEmotion(item.emotion || 'neutral')
      await el.play()
      startedAt = performance.now()
      speaking = true
      // start the next sentence now, so it is ready the moment this one ends
      prefetchNext()
      const durationMs = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : 0
      await waitForEnd(el, Math.max(PLAY_TIMEOUT_FLOOR_MS, durationMs + 8000))
      await ack(item.id, 'ok')
    } catch (e) {
      if (isAutoplayBlock(e)) {
        // Keep the line instead of burning a delivery attempt: ack it as
        // handled server-side, park it here, and replay after the first click.
        blocked.push(item)
        await ack(item.id, 'ok')
        onStatus('点一下面板，她就能开口了')
        transport.report('info', 'speech held until first user gesture', e.message, 'audio')
        armUnlock()
        return
      }
      transport.report('warn', 'speech playback failed', e.message, 'audio')
      await ack(item.id, 'failed', e.message)
      onStatus(`语音播放失败：${e.message}`)
    } finally {
      onEmotion('neutral')
      speaking = false
      currentWords = []
      startedAt = 0
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          /* ignore */
        }
      }
      playing = false
      pump()
    }
  }

  return {
    enqueue(item) {
      if (!item || typeof item.text !== 'string' || item.text.trim().length === 0) return
      // Nothing pronounceable (emoji-only, punctuation-only): the provider would
      // answer 400 and the failure would look like lost audio.
      if (!/[\p{L}\p{N}]/u.test(item.text)) return
      if (remember(item.id)) return
      queue.push(item)
      // Receipt is acknowledged straight away: a queued sentence is not being
      // played yet, and the hub used to re-send (and finally drop) anything it
      // had not heard back about. Playback failures still go to
      // /amadeus/report through the catch below.
      ack(item.id, 'accepted')
      pump()
    },

    /** Current mouth opening 0..1, combining word timing and audio energy. */
    mouthValue(now) {
      if (!speaking) return 0
      const t = now - startedAt
      for (const w of currentWords) {
        if (t >= w.o && t < w.o + w.d) {
          return Math.min(1, 0.55 + 0.45 * Math.abs(Math.sin((t - w.o) / 60)))
        }
      }
      return energy()
    },

    isSpeaking: () => speaking,
    isBusy: () => playing || queue.length > 0 || blocked.length > 0,
    pending: () => queue.length,
    clear() {
      queue.length = 0
      prefetched.clear()
      try {
        player?.pause()
      } catch {
        /* ignore */
      }
    },
  }
}
