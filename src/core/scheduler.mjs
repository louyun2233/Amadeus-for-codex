import { loadCharacterContent } from './character.mjs'

/**
 * Proactive interaction scheduler: the "she calls you" and "she speaks up when
 * it has been quiet" behaviours.
 *
 * This module is pure logic on purpose. Time, configuration, audience, model
 * access and delivery are all injected, so every rule below is unit-testable
 * without timers and without a running daemon:
 *
 *   - one proactive line at a time (a tick that is already delivering does nothing)
 *   - a minimum gap between any two proactive lines, so a call and an idle
 *     chatter can never land back to back
 *   - a long gap (machine suspended, clock jumped) produces exactly one line,
 *     not a burst of "missed" ones
 *   - nothing is spoken when there is no panel connected, when a conversation
 *     turn is in flight, or when voice is disabled
 *   - a failed model call falls back to a canned line instead of going silent
 */

export const PROACTIVE_MIN_GAP_MS = 10 * 60 * 1000
export const GENERATE_TIMEOUT_MS = 45000

// --- inner state -----------------------------------------------------------
//
// Idea from the multi-character story-mode notes: who speaks should not be a
// fixed turn or a fixed timer, it should follow an inner state, and the state
// should move by *deltas* rather than being assigned absolute values (absolute
// values make a character jump around instead of staying herself).
//
// Single-character translation: `will` is how much she wants to open her mouth
// right now, and it scales the idle threshold. `part`/`drift` are the two ends
// of one bar (the notes are explicit that they must never be independent), so
// `drift` is derived, never stored.
export const WILL_BASELINE = 50
export const WILL_DECAY_PER_TICK = 0.05
export const IDLE_SCALE_MIN = 0.4
export const IDLE_SCALE_MAX = 1.6

/** will 50 -> x1.0 (today's behaviour), will 100 -> faster, will 0 -> slower. */
export function idleScaleFor(will) {
  const w = Math.max(0, Math.min(100, Number.isFinite(will) ? will : WILL_BASELINE))
  const scale = 1.5 - w / 100
  return Math.max(IDLE_SCALE_MIN, Math.min(IDLE_SCALE_MAX, scale))
}

function clampMood(value) {
  const n = Number.isFinite(value) ? value : WILL_BASELINE
  return Math.max(0, Math.min(100, n))
}

import { looksLikeJapanese, parseReply, stripTags } from './parse.mjs'

/**
 * Map a model reply onto the scheduler's line shape.
 *
 * This lives here, using the real parser by default, precisely because an
 * earlier version assumed `{jp, cn}` while `parseReply` returns `{ja, zh}` —
 * every generated line was silently discarded and replaced by a canned one,
 * and the unit tests missed it because their parser double happened to return
 * the assumed shape.
 */
function defaultLineParser(raw) {
  // A model may try to call amadeus_call itself and then include a denied-tool
  // message in the line. Calls are already made by the scheduler, not the LLM.
  // Accept only the requested two-line script; otherwise use a safe canned line.
  const script = String(raw ?? '').trim()
  if (!/^(?:【[a-z_]+】\s*)?JP[:：]\s*[^\r\n]+\r?\nCN[:：]\s*[^\r\n]+$/i.test(script)) return null
  const parsed = parseReply(raw)
  // `parseReply().ja` keeps the per-sentence 【emotion】 tags (the chat path
  // uses its per-segment text instead). Handing that to TTS would make her say
  // the tag out loud, so strip them here.
  const jp = stripTags(parsed.ja || parsed.zh || '')
  const cn = stripTags(parsed.zh || parsed.ja || '')
  if (!looksLikeJapanese(jp) || jp.length > 80 || cn.length > 120) return null
  if (/来电未能发起|审批策略|工具调用|调用被.*拦截|amadeus_call|tool call|permission denied/i.test(`${jp}\n${cn}`)) return null
  return { jp, cn, emotion: parsed.emotion || 'neutral' }
}

export const CALL_SYSTEM = [
  '你是当前项目人设指定的角色，按提供的人设说话。',
  '程序已经负责发起来电和播放铃声。你只负责写接通后的一句简短日语招呼。',
  '不要调用任何工具、尝试发起或审批来电，也不要描述工具或审批状态。',
  '格式严格如下，不要输出别的内容：',
  '【emotion】',
  'JP: 日语（不超过 30 字）',
  'CN: 对应的中文',
  'emotion 只能取 soft | neutral | question | happy。',
].join('\n')

export const IDLE_SYSTEM = [
  '你是当前项目人设指定的角色，按提供的人设说话。',
  '你只负责写一句台词；程序负责播放。不要调用任何工具。',
  '用户已经有一段时间没说话了，你想自然地开口找一句话。',
  '话题可以是日常、科学小知识、轻度的吐槽，不要说教。',
  '格式严格如下，不要输出别的内容：',
  '【emotion】',
  'JP: 日语（不超过 40 字）',
  'CN: 对应的中文',
  'emotion 只能取 soft | neutral | question | happy | excited。',
].join('\n')

export const CALL_CANNED = Object.freeze(loadCharacterContent('kurisu').callCanned)
export const IDLE_CANNED = Object.freeze(loadCharacterContent('kurisu').idleCanned)

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

export class ProactiveScheduler {
  /**
   * @param {object} deps
   * @param {() => number} deps.clock        injectable time source
   * @param {object} deps.config             ConfigStore-like, read on every tick
   * @param {object} deps.state              persisted counters (mutated in place)
   * @param {() => void} deps.persist        called after state changes
   * @param {() => boolean} deps.hasAudience true when at least one panel is connected
   * @param {() => boolean} deps.isBusy      true while a chat turn is in flight
   * @param {(system:string) => Promise<string>} deps.complete  model call
   * @param {(line:{kind,jp,cn,emotion}) => void} deps.deliver
   * @param {(level:string, msg:string, detail?:string) => void} [deps.report]
   */
  constructor({
    clock = () => Date.now(),
    config,
    state,
    persist = () => {},
    hasAudience = () => true,
    isBusy = () => false,
    complete,
    deliver,
    parse = defaultLineParser,
    report = () => {},
    characterContent = loadCharacterContent('kurisu'),
    personaText = '',
  }) {
    this.clock = clock
    this.config = config
    this.state = state
    this.persist = persist
    this.hasAudience = hasAudience
    this.isBusy = isBusy
    this.complete = complete
    this.deliver = deliver
    this.parse = parse
    this.report = report
    this.characterContent = characterContent
    this.personaText = personaText
    this.inFlight = false
    this.interactionVersion = 0
  }

  /**
   * Called whenever the user interacts. Restarts the idle clock and nudges her
   * inner state by deltas — deterministic signals only, no extra model call:
   * being talked to raises her appetite for the conversation, a question raises
   * it further, a long message means the topic has substance, and a quick back
   * and forth means she is engaged right now.
   */
  noteInteraction({ text = '' } = {}) {
    this.interactionVersion += 1
    const now = this.clock()
    const state = this.state
    const previous = typeof state.lastUserAt === 'number' ? state.lastUserAt : 0
    const message = String(text ?? '')

    let willDelta = 6
    let partDelta = 5
    if (message.length >= 40) {
      willDelta += 4
      partDelta += 5
    }
    if (/[?？]/.test(message)) willDelta += 6
    if (previous > 0 && now - previous <= 2 * 60 * 1000) {
      willDelta += 4
      partDelta += 4
    }

    state.will = clampMood((state.will ?? WILL_BASELINE) + willDelta)
    state.part = clampMood((state.part ?? WILL_BASELINE) + partDelta)
    state.lastUserAt = now
    this.persist(state)
  }

  /** will/part drift back toward baseline, so one spike does not last forever. */
  #decayMood() {
    const state = this.state
    const will = state.will ?? WILL_BASELINE
    const part = state.part ?? WILL_BASELINE
    const nextWill = will + (WILL_BASELINE - will) * WILL_DECAY_PER_TICK
    const nextPart = part + (WILL_BASELINE - part) * WILL_DECAY_PER_TICK
    if (Math.abs(nextWill - will) < 0.01 && Math.abs(nextPart - part) < 0.01) return false
    state.will = clampMood(nextWill)
    state.part = clampMood(nextPart)
    return true
  }

  status() {
    const cfg = this.config.get()
    return {
      callEnabled: cfg.proactive?.callEnabled === true,
      idleEnabled: cfg.proactive?.idleEnabled === true,
      callIntervalMs: cfg.proactive?.callIntervalMs ?? null,
      idleMs: cfg.proactive?.idleMs ?? null,
      minGapMs: PROACTIVE_MIN_GAP_MS,
      lastCallAt: this.state.lastCallAt || null,
      lastProactiveAt: this.state.lastProactiveAt || null,
      lastUserAt: this.state.lastUserAt || null,
      callCount: this.state.callCount || 0,
      inFlight: this.inFlight,
      // `drift` is derived, never stored: the notes are explicit that the two
      // must be two ends of one bar, not independent values.
      will: Math.round(this.state.will ?? WILL_BASELINE),
      part: Math.round(this.state.part ?? WILL_BASELINE),
      drift: 100 - Math.round(this.state.part ?? WILL_BASELINE),
      idleScale: Number(idleScaleFor(this.state.will).toFixed(2)),
    }
  }

  /**
   * Evaluate one tick. Returns a decision describing what happened, which is
   * what the tests assert on.
   */
  async tick() {
    try {
      return await this.#tick()
    } catch (e) {
      // a scheduler error must never kill the interval that drives it
      this.report('error', 'scheduler tick failed', e && e.message ? e.message : String(e))
      return { action: 'none', reason: 'error' }
    }
  }

  async #tick() {
    const now = this.clock()
    const cfg = this.config.get()
    const state = this.state

    if (this.#decayMood()) this.persist(state)

    if (this.inFlight) return { action: 'none', reason: 'in-flight' }
    if (cfg.voice?.enabled !== true) return { action: 'none', reason: 'voice-disabled' }
    if (!this.hasAudience()) return { action: 'none', reason: 'no-client' }
    if (this.isBusy()) return { action: 'none', reason: 'busy' }

    if (!state.lastUserAt) {
      state.lastUserAt = now
      this.persist(state)
    }
    if (!state.lastCallAt) {
      // first run: establish a baseline instead of calling immediately
      state.lastCallAt = now
      this.persist(state)
      return { action: 'none', reason: 'call-baseline' }
    }

    // one proactive line at a time, with a floor between any two of them
    if (now - (state.lastProactiveAt || 0) < PROACTIVE_MIN_GAP_MS) {
      return { action: 'none', reason: 'cooldown' }
    }

    const callDue =
      cfg.proactive?.callEnabled === true &&
      now - state.lastCallAt >= (cfg.proactive?.callIntervalMs ?? Infinity)
    const idleDue =
      cfg.proactive?.idleEnabled === true &&
      // her mood scales the threshold: eager -> sooner, withdrawn -> later
      now - state.lastUserAt >= (cfg.proactive?.idleMs ?? Infinity) * idleScaleFor(state.will)

    if (!callDue && !idleDue) return { action: 'none', reason: 'not-due' }

    // a call wins the tick, but idle is pushed out too so the next tick cannot
    // immediately produce a second line
    const kind = callDue ? 'call' : 'idle'
    state.lastProactiveAt = now
    state.lastUserAt = now
    if (kind === 'call') {
      state.lastCallAt = now
    }
    this.persist(state)

    // Guard the delivery window explicitly. The cooldown below usually masks
    // overlapping ticks, but the reason reported would be misleading and the
    // guard would disappear if the gap were ever configured to zero.
    this.inFlight = true
    try {
      const delivered = await this.#deliverLine(kind, this.interactionVersion)
      if (!delivered) return { action: 'none', reason: 'delivery-cancelled' }
      if (kind === 'call') {
        state.callCount = (state.callCount || 0) + 1
        this.persist(state)
      }
    } finally {
      this.inFlight = false
    }
    return { action: kind, reason: 'due' }
  }

  async #deliverLine(kind, interactionVersion) {
    const system = `${this.personaText}\n\n${kind === 'call' ? CALL_SYSTEM : IDLE_SYSTEM}`
    const fallback = pick(kind === 'call' ? this.characterContent.callCanned : this.characterContent.idleCanned)

    let line = null
    let timeout
    try {
      const raw = await Promise.race([
        this.complete(system),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('line generation timed out')), GENERATE_TIMEOUT_MS)
          timeout.unref?.()
        }),
      ])
      const parsed = this.parse(raw)
      if (parsed && (parsed.jp || parsed.cn)) {
        line = {
          jp: parsed.jp || parsed.cn,
          cn: parsed.cn || parsed.jp,
          emotion: parsed.emotion || 'neutral',
        }
      } else {
        this.report('warn', `${kind} line rejected`, 'model reply was not a clean JP/CN line')
      }
    } catch (e) {
      this.report('warn', `${kind} line generation failed`, e && e.message ? e.message : String(e))
    } finally {
      clearTimeout(timeout)
    }

    if (!line) line = { jp: fallback.jp, cn: fallback.cn, emotion: fallback.emotion }

    // Generating a line can take tens of seconds. A user who started chatting,
    // disabled the feature or closed the panel during that time must not get
    // interrupted by the previously scheduled call when generation finishes.
    const cfg = this.config.get()
    const enabled = kind === 'call' ? cfg.proactive?.callEnabled : cfg.proactive?.idleEnabled
    if (cfg.voice?.enabled !== true || enabled !== true || !this.hasAudience() ||
        this.isBusy() || interactionVersion !== this.interactionVersion) return false

    try {
      await this.deliver({ kind, ...line })
      return true
    } catch (e) {
      this.report('error', `${kind} delivery failed`, e && e.message ? e.message : String(e))
      return false
    }
  }
}
