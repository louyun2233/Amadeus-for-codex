import { EMOTIONS, inferEmotion, normalizeEmotion } from './emotion.mjs'

const TAG_RE = new RegExp(`【(${EMOTIONS.join('|')})】`, 'g')
const LEADING_TAG_RE = new RegExp(`^【(${EMOTIONS.join('|')})】\\s*`)

/**
 * Split on sentence terminators without a lookbehind assertion.
 * `(?<=...)` throws a SyntaxError at parse time on Safari < 16.4, which takes
 * the whole script down instead of degrading. This is the safe equivalent.
 */
/** The voice provider refuses more than 300 characters per request. */
export const SPEECH_CHUNK_MAX = 280
export const LOCAL_QWEN_CHUNK_MAX = 80

/**
 * Where to cut an over-long sentence: at punctuation if there is any in the
 * second half of the window, otherwise at the cap. Cutting mid-word makes the
 * synthesiser pause in the middle of a word, which reads as a stutter.
 */
function cutPoint(chars, max) {
  const window = chars.slice(0, max)
  for (const marks of ['。！？!?\n', '、，,；;', ' \t']) {
    for (let index = window.length - 1; index >= Math.floor(max / 3); index -= 1) {
      if (marks.includes(window[index])) return index + 1
    }
  }
  return max
}

/** Original text order and whitespace are preserved; short clips keep their cache key. */
export function splitLocalSpeech(text) {
  const chars = Array.from(String(text ?? ''))
  const out = []
  let offset = 0
  while (chars.length - offset > LOCAL_QWEN_CHUNK_MAX) {
    const count = cutPoint(chars.slice(offset, offset + LOCAL_QWEN_CHUNK_MAX), LOCAL_QWEN_CHUNK_MAX)
    out.push(chars.slice(offset, offset + count).join(''))
    offset += count
  }
  if (offset < chars.length) out.push(chars.slice(offset).join(''))
  return out
}

export function splitSentences(text, _maxSentences = 24, maxLen = 200) {
  // The former sentence-count limit silently truncated a long reply's tail.
  // Retain the argument for callers, but only cap each request's length.
  maxLen = Number.isFinite(maxLen) ? Math.max(1, Math.min(SPEECH_CHUNK_MAX, Math.floor(maxLen))) : 200
  const out = []
  let buf = []
  const push = () => {
    let rest = buf
    buf = []
    if (!rest.join('').trim()) return
    while (rest.length > maxLen || rest.join('').length > SPEECH_CHUNK_MAX) {
      let units = 0, budget = 0
      for (const ch of rest.slice(0, maxLen)) {
        if (units + ch.length > SPEECH_CHUNK_MAX) break
        units += ch.length
        budget += 1
      }
      const cut = cutPoint(rest, budget)
      out.push(rest.slice(0, cut).join(''))
      rest = rest.slice(cut)
    }
    if (rest.length > 0) out.push(rest.join(''))
  }
  for (const ch of String(text ?? '')) {
    buf.push(ch)
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '…' || ch === '\n') {
      push()
    }
  }
  push()
  return out
}

export function stripTags(text) {
  return String(text ?? '').replace(TAG_RE, '').trim()
}

export function looksLikeJapanese(text) {
  return /[\u3040-\u309f\u30a0-\u30ff]/.test(String(text ?? ''))
}

function firstTag(text) {
  const m = String(text ?? '').match(TAG_RE)
  if (!m || m.length === 0) return null
  const inner = m[0].slice(1, -1)
  return EMOTIONS.includes(inner) ? inner : null
}

function emotionalSegments(text, initialEmotion, fallbackEmotion) {
  const segments = []
  let currentEmotion = initialEmotion, offset = 0
  const append = (span) => {
    for (const sentence of splitSentences(span.trim())) {
      const bare = sentence.trim()
      if (bare) segments.push({ text: bare,
        emotion: normalizeEmotion(currentEmotion || inferEmotion(bare), fallbackEmotion) })
    }
  }
  // Remove complete tags before length cuts: a tag at character 200 must not
  // become spoken text, and all fragments retain the same selected emotion.
  for (const match of String(text).matchAll(new RegExp(TAG_RE.source, 'g'))) {
    append(text.slice(offset, match.index))
    currentEmotion = match[1]
    offset = match.index + match[0].length
  }
  append(text.slice(offset))
  return segments
}

/**
 * Parse the persona reply contract:
 *
 *   【emotion】
 *   JP: 【emotion】sentence...
 *   CN: chinese
 *
 * Returns per-sentence segments so the voice queue can apply a different
 * emotion to each spoken line, matching the DSH behaviour.
 */
export function parseReply(raw) {
  const text = String(raw ?? '').trim()
  const explicitEmotion = firstTag(text)

  const jpMatch = text.match(/JP[:：]\s*([\s\S]*?)(?=\n\s*CN[:：]|$)/)
  const cnMatch = text.match(/CN[:：]\s*([\s\S]*)$/)

  let ja = jpMatch ? jpMatch[1].trim() : ''
  let zh = cnMatch ? cnMatch[1].trim() : ''

  const parsed = ja.length > 0 || zh.length > 0

  if (!parsed) {
    const fallback = stripTags(text)
    const segments = emotionalSegments(text, explicitEmotion, inferEmotion(fallback))
    return {
      parsed: false,
      emotion: explicitEmotion || inferEmotion(fallback),
      zh: fallback,
      ja: looksLikeJapanese(fallback) ? fallback : '',
      segments,
    }
  }

  if (zh.length === 0) zh = stripTags(ja)
  if (ja.length === 0) ja = zh
  const globalEmotion = explicitEmotion || inferEmotion(stripTags(`${ja}\n${zh}`))

  const segments = emotionalSegments(ja, explicitEmotion, globalEmotion)

  return {
    parsed: true,
    emotion: normalizeEmotion(globalEmotion, 'neutral'),
    zh: stripTags(zh),
    ja,
    segments,
  }
}

/** Strip a leading emotion tag, used by the queue when re-tagging sentences. */
export function takeLeadingTag(text) {
  const m = String(text ?? '').match(LEADING_TAG_RE)
  if (!m) return { emotion: null, rest: String(text ?? '') }
  return { emotion: m[1], rest: String(text).slice(m[0].length) }
}
