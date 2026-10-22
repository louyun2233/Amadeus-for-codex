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

/**
 * Where to cut an over-long sentence: at punctuation if there is any in the
 * second half of the window, otherwise at the cap. Cutting mid-word makes the
 * synthesiser pause in the middle of a word, which reads as a stutter.
 */
function cutPoint(text, max) {
  const window = text.slice(0, max)
  let best = -1
  for (const mark of ['。', '！', '？', '!', '?', '、', '，', ',', ' ', '\n']) {
    const at = window.lastIndexOf(mark)
    if (at > best) best = at
  }
  return best >= Math.floor(max / 2) ? best + 1 : max
}

export function splitSentences(text, maxSentences = 24, maxLen = 200) {
  const out = []
  let buf = ''
  const push = () => {
    const t = buf.trim()
    buf = ''
    if (t.length === 0) return
    let rest = t
    while (rest.length > maxLen) {
      const cut = cutPoint(rest, maxLen)
      const head = rest.slice(0, cut).trim()
      rest = rest.slice(cut).trim()
      if (head.length > 0) out.push(head)
    }
    if (rest.length > 0) out.push(rest)
  }
  for (const ch of String(text ?? '')) {
    buf += ch
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '…' || ch === '\n') {
      push()
    }
  }
  push()
  /**
   * The old version stopped pushing once `maxSentences` was reached and dropped
   * the rest of the reply without saying so - one of the ways a sentence "just
   * disappeared". Anything past the budget is merged into the final chunk
   * (bounded), so the end of the reply is always spoken.
   */
  if (out.length > maxSentences) {
    const kept = out.slice(0, maxSentences - 1)
    const tail = out.slice(maxSentences - 1).join('')
    kept.push(tail.length > SPEECH_CHUNK_MAX ? `${tail.slice(0, SPEECH_CHUNK_MAX - 1)}…` : tail)
    return kept
  }
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
  const globalEmotion = firstTag(text) || 'neutral'

  const jpMatch = text.match(/JP[:：]\s*([\s\S]*?)(?=\n\s*CN[:：]|$)/)
  const cnMatch = text.match(/CN[:：]\s*([\s\S]*)$/)

  let ja = jpMatch ? jpMatch[1].trim() : ''
  let zh = cnMatch ? cnMatch[1].trim() : ''

  const parsed = ja.length > 0 || zh.length > 0

  if (!parsed) {
    const fallback = stripTags(text)
    const sentences = splitSentences(fallback)
    return {
      parsed: false,
      emotion: inferEmotion(fallback),
      zh: fallback,
      ja: looksLikeJapanese(fallback) ? fallback : '',
      segments: sentences.map((s) => ({ text: stripTags(s), emotion: inferEmotion(s) })),
    }
  }

  if (zh.length === 0) zh = stripTags(ja)
  if (ja.length === 0) ja = zh

  const segments = []
  for (const sentence of splitSentences(ja)) {
    const lead = firstTag(sentence)
    const bare = stripTags(sentence)
    if (bare.length === 0) continue
    segments.push({
      text: bare,
      emotion: normalizeEmotion(lead || globalEmotion, globalEmotion),
    })
  }

  return {
    parsed: true,
    emotion: normalizeEmotion(globalEmotion, 'neutral'),
    zh,
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
