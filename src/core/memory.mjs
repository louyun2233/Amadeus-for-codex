import path from 'node:path'
import crypto from 'node:crypto'
import { readJson, writeJsonAtomic } from './store.mjs'
import { analyzeChange } from './contradiction.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'

export const NAMESPACES = ['panel', 'codex']

function id() {
  return crypto.randomBytes(8).toString('hex')
}

function terms(text) {
  return String(text)
    .toLowerCase()
    .match(/[a-z0-9_]{2,}|[\u3040-\u30ff\u4e00-\u9fff]/g) || []
}

/**
 * How long a retrieval keeps boosting a fact.
 *
 * lingshu's mechanism is `search -> last_access -> recall`: what you keep asking
 * about stays near the top. Carried over here, with one guard — the boost
 * expires, otherwise a fact touched once keeps winning forever (the
 * rich-get-richer drift their own bench_recall_drift measures).
 */
export const TOUCH_BOOST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const TOUCH_THROTTLE_MS = 60 * 1000

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Where a fact came from, in words.
 *
 * lingshu's `recall_with_evidence` returns why a fact is believed, not just the
 * fact. Single-character version of the same idea: she should be able to say
 * "you told me that last week" instead of asserting it out of nowhere, and the
 * user should be able to audit what she thinks she knows.
 */
const ORIGIN_LABEL = {
  'auto-extract': '面板对话里提到的',
  mcp: 'Agent 记下的',
  cli: '手动写入的',
  api: '手动写入的',
  unknown: '来源不明',
}

export function relativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '时间不明'
  const delta = Math.max(0, now - ts)
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)} 天前`
  return `${Math.floor(delta / (30 * DAY))} 个月前`
}

/** A one-line provenance string: when, from where, and whether it was corrected. */
export function describeMemory(entry, now = Date.now()) {
  const origin = ORIGIN_LABEL[entry?.source] || ORIGIN_LABEL.unknown
  const when = relativeTime(entry?.ts, now)
  const corrected = entry?.supersededBy ? '，已被更正' : ''
  return `${when}，${origin}${corrected}`
}

/** The timestamp a fact is ranked by: creation, or a *recent* retrieval. */
function effectiveTime(entry, now) {
  const created = typeof entry.ts === 'number' ? entry.ts : 0
  const touched = typeof entry.lastAccess === 'number' ? entry.lastAccess : 0
  if (touched > created && now - touched < TOUCH_BOOST_WINDOW_MS) return touched
  return created
}

function score(entry, queryTerms, now) {
  const content = entry.content.toLowerCase()
  let s = 0
  for (const t of queryTerms) if (content.includes(t)) s += 1
  if (s === 0) return 0
  const ageDays = Math.max(0, (now - effectiveTime(entry, now)) / 86400000)
  const recency = 1 / (1 + ageDays / 30)
  const tagBoost = (entry.tags || []).some((tag) => queryTerms.includes(String(tag).toLowerCase()))
    ? 0.5
    : 0
  return s * (1 + recency + tagBoost)
}

/**
 * Two namespaces on purpose (Q8/Q23/Q33):
 *   panel — auto-extracted from panel conversation
 *   codex — written explicitly by the agent via `amadeus_remember`
 * They never mix, so a Codex task can't pollute the companion's memory.
 */
export class MemoryStore {
  constructor(paths, config) {
    this.paths = paths
    this.config = config
    this.files = Object.fromEntries(
      NAMESPACES.map((ns) => [ns, path.join(paths.memoryDir, `${ns}.json`)]),
    )
  }

  #ns(namespace) {
    const ns = namespace || 'panel'
    if (!NAMESPACES.includes(ns)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `unknown memory namespace: ${ns}`)
    }
    return ns
  }

  #read(ns) {
    const data = readJson(this.files[ns], { entries: [] })
    const entries = Array.isArray(data.entries) ? data.entries : []
    return { entries }
  }

  #write(ns, data) {
    writeJsonAtomic(this.files[ns], data)
  }

  add(
    namespace,
    { content, tags = [], workspace = null, source = 'unknown', type = 'fact', supersede = true, ts = Date.now() },
  ) {
    const ns = this.#ns(namespace)
    const text = String(content ?? '').trim()
    if (text.length === 0) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'memory content is empty')
    }
    if (text.length > 500) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'memory content too long (max 500)')
    }
    // All storage I/O here is synchronous, and Node runs this file's code on a
    // single thread, so a lock adds ordering latency without adding safety.
    const data = this.#read(ns)
    const existing = data.entries.find((e) => e.content === text)
    if (existing) return existing
    const entry = {
      id: id(),
      namespace: ns,
      content: text,
      type: ['fact', 'emotion', 'summary'].includes(type) ? type : 'fact',
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 40)).slice(0, 8),
      workspace: workspace ? String(workspace).slice(0, 200) : null,
      source,
      confidence: 1,
      ts,
      lastAccess: ts,
    }

    // A correction must not sit next to the fact it corrects. Near-duplicates
    // that flip polarity / a number / an antonym supersede the older entry:
    // it is kept on disk for audit, but it stops being served.
    if (supersede) {
      for (const older of data.entries) {
        if (older.supersededBy) continue
        if (older.namespace !== ns) continue
        const change = analyzeChange(older.content, text)
        if (!change) continue
        older.supersededBy = entry.id
        older.supersededAt = entry.ts
        older.supersedeKind = change.kind
        older.confidence = 0
        entry.supersedes = older.id
        entry.changeKind = change.kind
      }
    }

    data.entries.push(entry)
    const max = this.config?.getPath?.('memory.maxPerNamespace') ?? 100
    if (data.entries.length > max) {
      // drop oldest non-summary entries first, then oldest overall
      const overflow = data.entries.length - max
      const candidates = data.entries
        .filter((e) => e.type !== 'summary')
        .sort((a, b) => a.ts - b.ts)
      const drop = new Set()
      for (let i = 0; i < overflow && i < candidates.length; i++) drop.add(candidates[i].id)
      if (drop.size < overflow) {
        const summaries = data.entries
          .filter((e) => !drop.has(e.id))
          .sort((a, b) => a.ts - b.ts)
        for (const entry of summaries.slice(0, overflow - drop.size)) drop.add(entry.id)
      }
      data.entries = data.entries.filter((e) => !drop.has(e.id))
    }
    this.#write(ns, data)
    return entry
  }

  list(namespace, { limit = 100, workspace = null, includeSuperseded = false } = {}) {
    const ns = this.#ns(namespace)
    let entries = this.#read(ns).entries
    if (!includeSuperseded) entries = entries.filter((e) => !e.supersededBy)
    if (workspace) entries = entries.filter((e) => e.workspace === workspace)
    return entries.slice().sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  search(
    query,
    { k = 8, namespace = null, workspace = null, includeSuperseded = false, now = Date.now(), touch = true } = {},
  ) {
    const q = terms(query)
    if (q.length === 0) return []
    const namespaces = namespace ? [this.#ns(namespace)] : NAMESPACES
    const scored = []
    for (const ns of namespaces) {
      for (const entry of this.#read(ns).entries) {
        if (!includeSuperseded && entry.supersededBy) continue
        if (workspace && entry.workspace && entry.workspace !== workspace) continue
        const s = score(entry, q, now)
        if (s > 0) scored.push({ ...entry, score: Number(s.toFixed(3)) })
      }
    }
    const top = scored.sort((a, b) => b.score - a.score).slice(0, k)
    if (touch && top.length > 0) this.#touch(top, now)
    return top
  }

  /**
   * Record that these facts were just retrieved. Throttled: a burst of queries
   * in the same minute must not rewrite the file once per query.
   */
  #touch(entries, now) {
    const byNamespace = new Map()
    for (const entry of entries) {
      const last = typeof entry.lastAccess === 'number' ? entry.lastAccess : 0
      if (now - last < TOUCH_THROTTLE_MS) continue
      if (!byNamespace.has(entry.namespace)) byNamespace.set(entry.namespace, new Set())
      byNamespace.get(entry.namespace).add(entry.id)
    }
    for (const [ns, ids] of byNamespace) {
      const data = this.#read(ns)
      let changed = false
      for (const entry of data.entries) {
        if (!ids.has(entry.id)) continue
        entry.lastAccess = now
        changed = true
      }
      if (!changed) continue
      try {
        this.#write(ns, data)
      } catch {
        // Recency bookkeeping is best-effort: if the write fails (disk full,
        // permissions) the caller still gets its results, the fact simply does
        // not get boosted. A failed touch must never break a conversation.
      }
    }
  }

  remove(memoryId) {
    for (const ns of NAMESPACES) {
      const data = this.#read(ns)
      const before = data.entries.length
      data.entries = data.entries.filter((e) => e.id !== memoryId)
      if (data.entries.length !== before) {
        this.#write(ns, data)
        return { removed: 1, namespace: ns }
      }
    }
    return { removed: 0, namespace: null }
  }

  forgetByQuery(query) {
    const q = terms(query)
    if (q.length === 0) return { removed: 0 }
    let removed = 0
    for (const ns of NAMESPACES) {
      const data = this.#read(ns)
      const keep = []
      for (const entry of data.entries) {
        const hit = q.some((t) => entry.content.toLowerCase().includes(t))
        if (hit) removed += 1
        else keep.push(entry)
      }
      if (keep.length !== data.entries.length) this.#write(ns, { entries: keep })
    }
    return { removed }
  }

  clear(namespace) {
    const ns = this.#ns(namespace)
    const data = this.#read(ns)
    const removed = data.entries.length
    this.#write(ns, { entries: [] })
    return { removed, namespace: ns }
  }

  exportAll() {
    const out = { exportedAt: new Date().toISOString(), namespaces: {} }
    for (const ns of NAMESPACES) out.namespaces[ns] = this.#read(ns).entries
    return out
  }

  stats() {
    const out = {}
    for (const ns of NAMESPACES) {
      const entries = this.#read(ns).entries
      const superseded = entries.filter((e) => e.supersededBy).length
      out[ns] = {
        total: entries.length,
        active: entries.length - superseded,
        superseded,
        byType: entries.reduce((acc, e) => {
          acc[e.type] = (acc[e.type] || 0) + 1
          return acc
        }, {}),
      }
    }
    return out
  }
}
