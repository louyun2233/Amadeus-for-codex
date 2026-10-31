import { EventEmitter } from 'node:events'
import { parseReply } from './parse.mjs'
import { buildSystemPrompt, loadPersona } from './persona.mjs'
import { MEMORY_TIMEOUT_MS } from './llm.mjs'
import { createChildLogger } from '../shared/log.mjs'

const logger = createChildLogger('[chat]')

const EXTRACT_PROMPT = `分析下面的对话，提取值得长期记住的用户信息。

只提取长期有效的事实：称呼、职业、长期偏好、习惯、重要关系、持续进行的研究或项目、长期目标、已经发生的人生节点。
不要提取：当前动作（在吃饭/在忙）、当天计划、寒暄、情绪化的临时状态。
只根据用户原话提取，不得把 Amadeus 的回答、推测或提问当作用户事实；不得补充原话没有的信息。
每条事实尽量摘录用户原句中的连续片段，不要把原句改写成猜测。
判断标准：这条信息一周后还有意义吗？没有就不要。

每条一行，格式：- [事实] 内容
没有值得记住的内容时，只输出：无

对话：
`

const COMPRESS_PROMPT = `把下面的旧对话压缩成一段简洁摘要，供角色保持上下文连贯。

要求：
- 保留话题、用户的偏好与立场、重要决定、未完成的事
- 丢弃寒暄与重复内容
- 不超过 300 字，不要分条

旧对话：
`

function toHistory(messages) {
  return messages.filter((m) => !m.isSummary).map((m) => ({
    role: m.role,
    zh: m.zh,
    ja: m.ja,
  }))
}

/** Avoid a second model call for greetings and questions with no user fact to retain. */
export function mayContainLongTermFact(text) {
  const value = String(text || '')
  return /(?:我|咱|俺|本人|我们).{0,24}(?:是|叫|姓|住|有|喜欢|讨厌|习惯|过敏|从事|工作|一直|长期|以后|今后)|(?:请叫我|记住我|别忘了我|记住这件事|请记下)/.test(value) ||
    /(?:我|我们).{0,12}(?:在做|研究|开发|训练|制作).{0,18}(?:实验|研究|项目|课题|产品|软件|论文|模型|机器人)/.test(value)
}

/** A broad recall request has no lexical overlap with the facts it asks for. */
export function asksForMemoryOverview(text) {
  const value = String(text || '').replace(/[\s，。！？?!]/g, '')
  return /(?:你|妳)(?:还|都|仍然)?记得我(?:吗|的哪些事|什么|多少|哪些事)?$/.test(value) ||
    /关于我(?:你|妳).{0,3}记得(?:什么|哪些事)/.test(value)
}

/** Reject extracted details that cannot be traced back to a user's own words. */
export function candidateSupportedByUser(candidate, userText) {
  const claim = String(candidate || '').replace(/^(?:用户|本人|我)(?:的)?/, '').replace(/[\s，。！？、]/g, '')
  const source = String(userText || '').replace(/[\s，。！？、]/g, '')
  if (!claim || !source) return false
  if (source.includes(claim)) return true
  if (claim.length < 4) return false
  const pairs = [...new Set(Array.from({ length: claim.length - 1 }, (_, i) => claim.slice(i, i + 2)))]
  return pairs.filter((pair) => source.includes(pair)).length >= 2 &&
    pairs.filter((pair) => source.includes(pair)).length / pairs.length >= 0.8
}

/**
 * Conversation engine. Owns the turn lifecycle: memory recall -> prompt build
 * -> LLM call -> parse -> persist -> async memory maintenance.
 */
export class ChatEngine extends EventEmitter {
  constructor({ sessions, memory, llm, config, audit, personaName = 'kurisu' }) {
    super()
    this.sessions = sessions
    this.memory = memory
    this.llm = llm
    this.config = config
    this.audit = audit
    this.personaName = personaName
    this.turnSeq = 0
    this.turns = new Map()
    this.sessionQueues = new Map()
  }

  #maxMemories() {
    // bounded recall keeps the prompt small and predictable; the value is a
    // deliberate constant rather than a tunable so prompt size can't drift.
    return 12
  }

  getTurn(turnId) {
    return this.turns.get(turnId) || null
  }

  /** True while any conversation turn is in flight (used by the scheduler). */
  isRunning() {
    for (const turn of this.turns.values()) {
      if (turn.status === 'running' || turn.status === 'queued') return true
    }
    return false
  }

  isSessionBusy(sessionId) {
    for (const turn of this.turns.values()) {
      if (turn.sessionId === sessionId && (turn.status === 'running' || turn.status === 'queued')) return true
    }
    return false
  }

  cancelTurn(turnId) {
    const turn = this.turns.get(turnId)
    if (!turn || (turn.status !== 'running' && turn.status !== 'queued')) return false
    turn.controller.abort()
    return true
  }

  /**
   * Run one turn. Returns immediately with a turnId; progress is delivered
   * through the emitted events so the HTTP layer can stream to the panel.
   */
  startTurn({ sessionId, userText, image = null, workspace = null, origin = null }) {
    const turnId = `t${++this.turnSeq}-${Date.now().toString(36)}`
    // `origin` is the panel client that started the turn, so streaming deltas go
    // back to that tab only instead of every open tab.
    const turn = {
      id: turnId, sessionId, status: 'queued', text: '', error: null, closed: false,
      phase: 'queued', startedAt: Date.now(), firstDeltaAt: null,
      durationMs: null, origin, controller: new AbortController(),
    }
    this.turns.set(turnId, turn)
    this.#pruneTurns()
    const previous = this.sessionQueues.get(sessionId) || Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      turn.controller.signal.throwIfAborted()
      turn.status = 'running'
      turn.phase = 'preparing'
      this.emit('turn:status', { turnId, phase: turn.phase, origin })
      await this.#runTurn(turn, { sessionId, userText, image, workspace, origin })
    }).catch((e) => {
      turn.status = 'error'
      const cancelled = turn.controller.signal.aborted
      turn.error = cancelled ? '已取消' : e && e.message ? e.message : String(e)
      turn.phase = cancelled ? 'cancelled' : 'error'
      turn.durationMs = Date.now() - turn.startedAt
      const candidate = cancelled ? 'cancelled' : e?.degrade
      const reason = typeof candidate === 'string' && /^[a-z0-9-]{1,40}$/.test(candidate)
        ? candidate : 'chat-failed'
      let closed = false
      if (this.config.getPath('chat.oneshot') === true) {
        try {
          this.sessions.close(sessionId)
          closed = true
        } catch (closeError) {
          logger.warn('failed to close a failed one-shot session:', closeError?.message || closeError)
        }
      }
      this.audit?.record({ source: 'chat', tool: 'turn.error', summary: `${turnId} ${reason} ${turn.durationMs}ms` })
      turn.closed = closed
      this.emit('turn:error', {
        turnId, sessionId, closed, error: turn.error,
        code: cancelled ? 'cancelled' : e?.code, reason, origin,
      })
    })
    this.sessionQueues.set(sessionId, run)
    run.finally(() => {
      if (this.sessionQueues.get(sessionId) === run) this.sessionQueues.delete(sessionId)
    })
    return turnId
  }

  #pruneTurns() {
    if (this.turns.size <= 50) return
    const settled = [...this.turns.values()]
      .filter((t) => t.status === 'done' || t.status === 'error')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const t of settled.slice(0, this.turns.size - 50)) this.turns.delete(t.id)
  }

  async #runTurn(turn, { sessionId, userText, image, workspace, origin }) {
    turn.controller.signal.throwIfAborted()
    const text = String(userText ?? '').trim()
    if (text.length === 0) throw new Error('empty message')
    if (text.length > 2000) throw new Error('message too long (max 2000)')

    const session = this.sessions.get(sessionId)
    const persona = loadPersona(this.personaName)

    // Two switches decide how much she remembers, and both default to the
    // "stranger" end: no memory, and no context carried across turns.
    const memoryOn = this.config.getPath('memory.enabled') === true
    const oneshot = this.config.getPath('chat.oneshot') === true
    const recalled = memoryOn
      ? this.memory.search(text, { k: this.#maxMemories(), namespace: 'panel', types: ['fact', 'emotion', 'summary'] })
      : []
    if (memoryOn && recalled.length === 0 && asksForMemoryOverview(text)) {
      recalled.push(...this.memory.list('panel', {
        limit: 6, types: ['fact', 'emotion', 'summary'],
      }))
    }
    const recap = memoryOn ? this.memory.list('panel', { limit: 1, types: ['recap'] })[0] : null

    const system = buildSystemPrompt({
      persona,
      memories: recalled,
      recap,
      summary: session.summary || '',
    })

    const history = oneshot ? [] : toHistory(this.sessions.recentMessages(sessionId, 20))

    const userEntry = this.sessions.append(sessionId, { role: 'user', zh: text, ja: text, emotion: 'neutral' })
    this.emit('message:appended', { sessionId, message: userEntry, origin })
    this.emit('turn:start', { turnId: turn.id, sessionId, origin })
    this.audit?.record({ source: 'chat', tool: 'turn.start', summary: `${turn.id} provider=${this.config.getPath('chat.provider')}` })

    const adapter = this.llm.pick(this.config.getPath('chat.provider'))
    const res = await adapter.chat({
      system,
      history,
      user: image && text === '[图片]' ? '请描述这张图片的内容。' : text,
      image,
      signal: turn.controller.signal,
      onStatus: (phase) => {
        if (!['connecting', 'generating', 'retrying', 'reply'].includes(phase) || turn.phase === phase) return
        turn.phase = phase
        this.emit('turn:status', { turnId: turn.id, phase, origin })
        this.audit?.record({ source: 'chat', tool: 'turn.stage', summary: `${turn.id} ${phase} ${Date.now() - turn.startedAt}ms` })
      },
      onDelta: (delta) => {
        if (turn.firstDeltaAt === null) {
          turn.firstDeltaAt = Date.now()
          this.audit?.record({ source: 'chat', tool: 'turn.first-reply', summary: `${turn.id} ${turn.firstDeltaAt - turn.startedAt}ms` })
        }
        turn.text += delta
        this.emit('turn:delta', { turnId: turn.id, delta, origin })
      },
    })
    turn.controller.signal.throwIfAborted()
    const raw = res.text

    const parsed = parseReply(raw)
    const assistantEntry = this.sessions.append(sessionId, {
      role: 'assistant',
      zh: parsed.zh,
      ja: parsed.ja,
      emotion: parsed.emotion,
    })
    this.emit('message:appended', { sessionId, message: assistantEntry, origin })

    turn.status = 'done'
    turn.phase = 'done'
    turn.durationMs = Date.now() - turn.startedAt
    turn.parsed = parsed
    let closed = false
    if (oneshot) {
      try {
        this.sessions.close(sessionId)
        closed = true
      } catch (e) {
        logger.warn('failed to close a one-shot session:', e && e.message ? e.message : e)
      }
    }
    turn.closed = closed
    this.emit('turn:done', { turnId: turn.id, sessionId, origin, closed, ...parsed })
    const firstMs = turn.firstDeltaAt === null ? 'none' : `${turn.firstDeltaAt - turn.startedAt}ms`
    this.audit?.record({ source: 'chat', tool: 'turn.done', summary: `${turn.id} ${turn.durationMs}ms first=${firstMs}` })

    // Keep maintenance inside the session queue: compression rewrites messages,
    // so a following turn must not append while that rewrite is in progress.
    await this.#maintain(sessionId, { workspace, closed }).catch((e) => {
      logger.warn('memory maintenance failed:', e && e.message ? e.message : e)
    })
  }

  /** Extract long-term facts and compress history, both best-effort. */
  async #maintain(sessionId, { workspace, closed = false }) {
    if (this.config.getPath('memory.enabled') !== true) return
    const messages = this.sessions.get(sessionId).messages
    const assistantCount = messages.filter((m) => m.role === 'assistant').length

    /**
     * One-shot mode closes the session after *every* exchange, so the "every
     * sixth message" rule never became true: `assistantCount` was always 1 and
     * long-term memory stayed empty no matter how much you talked to her. A
     * session that just closed is exactly the moment worth looking at.
     */
    const dueForExtraction = assistantCount % 6 === 0 || closed
    const candidateFact = messages.filter((m) => m.role === 'user').slice(-6)
      .some((m) => mayContainLongTermFact(m.zh || m.ja))
    if (this.config.getPath('memory.autoExtract') === true && assistantCount > 0 && dueForExtraction && candidateFact) {
      await this.extractMemories(sessionId, { workspace })
    }

    // The conversational thread, not just extracted facts: "last time we talked
    // about …" is what a user notices when they come back.
    if (closed) this.recordRecap(sessionId)

    const threshold = this.config.getPath('chat.compressThreshold') ?? 40
    if (messages.length > threshold) await this.compress(sessionId)
  }

  async extractMemories(sessionId, { workspace = null } = {}) {
    const messages = this.sessions.recentMessages(sessionId, 10)
    // One exchange is enough in one-shot mode; requiring two made extraction
    // impossible there.
    if (messages.length < 2) return { added: 0 }
    const adapter = this.llm.pick(this.config.getPath('chat.provider'))
    const userMessages = messages.filter((m) => m.role === 'user')
    const dialog = userMessages
      .map((m) => `用户: ${m.zh || m.ja}`)
      .join('\n')
    if (!userMessages.some((m) => mayContainLongTermFact(m.zh || m.ja))) return { added: 0 }
    let raw
    try {
      const res = await adapter.chat({
        system: EXTRACT_PROMPT,
        history: [],
        user: dialog,
        timeoutMs: MEMORY_TIMEOUT_MS,
      })
      raw = res.text
    } catch (e) {
      logger.warn('extract memories failed:', e && e.message ? e.message : e)
      return { added: 0 }
    }
    const lines = String(raw)
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•]\s*(\[[^\]]+\])?\s*/, '').trim())
      .filter((l) => l.length > 2 && l.length <= 120 && l !== '无' && !/^无$/.test(l))
      .slice(0, 5)

    let added = 0
    for (const content of lines) {
      if (!candidateSupportedByUser(content, dialog)) continue
      try {
        const before = this.memory.list('panel', { limit: 1000 }).length
        this.memory.add('panel', { content, source: 'auto-extract', workspace })
        if (this.memory.list('panel', { limit: 1000 }).length > before) added += 1
      } catch {
        /* skip invalid candidate */
      }
    }
    if (added > 0) {
      this.audit?.record({ source: 'chat', tool: 'memory.extract', summary: `+${added}` })
      this.emit('memory:changed', { namespace: 'panel', added })
    }
    return { added }
  }

  /**
   * Remember the shape of the last exchange.
   *
   * Kept deliberately short and pruned to a handful of entries, so this can
   * never drown the extracted facts (which are the ones worth keeping long
   * term).
   */
  recordRecap(sessionId) {
    try {
      const messages = this.sessions.recentMessages(sessionId, 6)
      const user = [...messages].reverse().find((m) => m.role === 'user')
      const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
      if (!user || !assistant) return { added: 0 }
      const clip = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)
      const line = `上次聊天：用户说「${clip(user.zh || user.ja, 60)}」，我回应「${clip(assistant.zh || assistant.ja, 60)}」`
      this.memory.add('panel', { content: line, source: 'conversation', type: 'recap' })
      this.emit('memory:changed', { namespace: 'panel', added: 1 })
      return { added: 1 }
    } catch (e) {
      logger.warn('recap failed:', e && e.message ? e.message : e)
      return { added: 0 }
    }
  }

  async compress(sessionId) {
    const session = this.sessions.get(sessionId)
    const keepRecent = this.config.getPath('chat.keepRecent') ?? 20
    const messages = session.messages
    const toCompress = messages.slice(0, Math.max(0, messages.length - keepRecent))
    const toKeep = messages.slice(-keepRecent)
    if (toCompress.length < 4) return { compressed: false }

    const adapter = this.llm.pick(this.config.getPath('chat.provider'))
    const dialog = toCompress
      .map((m) => `${m.role === 'user' ? '用户' : 'Amadeus'}: ${(m.zh || m.ja || '').slice(0, 400)}`)
      .join('\n')

    let summary = ''
    try {
      const res = await adapter.chat({
        system: COMPRESS_PROMPT,
        history: [],
        user: (session.summary ? `已有摘要：${session.summary}\n\n` : '') + dialog,
        timeoutMs: MEMORY_TIMEOUT_MS,
      })
      summary = String(res.text || '').trim().slice(0, 2000)
    } catch (e) {
      logger.warn('compress failed:', e && e.message ? e.message : e)
      return { compressed: false }
    }
    if (summary.length === 0) return { compressed: false }

    this.sessions.setSummary(sessionId, summary)
    this.sessions.replaceMessages(sessionId, toKeep)
    this.emit('session:changed', { sessionId })
    return { compressed: true, kept: toKeep.length, summary }
  }
}
