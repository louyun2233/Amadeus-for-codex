/**
 * Contradiction-aware change detection for near-duplicate facts.
 *
 * Ported (with simplification) from lingshu — https://github.com/FuRongJun-1999/lingshu
 * bench/repro/bench_correction.py + lingshu/core/contradiction.py, MIT,
 * Copyright (c) 2026 FuRongJun-1999. See NOTICE.
 *
 * Why it exists: "用户对青霉素过敏" and "用户对青霉素不过敏" are near-identical by
 * any bag-of-characters measure, so a memory that only de-duplicates will keep
 * both and can happily surface the stale one. A single 「不」 flips the meaning,
 * and bag-of-characters cannot see that.
 *
 * Rules (deterministic, zero-LLM, matching the reference):
 *   1. only run on pairs that are already *near duplicates* — the false-positive
 *      surface is bounded by that gate rather than by a cleverer detector
 *   2. numbers differ on both sides  -> 'number'
 *   3. the differing fragment toggles negation -> 'polarity'
 *   4. the differing fragments hit an antonym pair -> 'antonym'
 *
 * Deliberate simplification: the reference walks every diff block from a
 * character-level alignment; this uses the common prefix/suffix, which yields
 * one block per side. The number and polarity checks are whole-string anyway,
 * so multi-block edits only lose the rare double-antonym case.
 */

const NEG_MARKERS = [
  '并非',
  '并不',
  '毫无',
  '从未',
  '尚未',
  '没有',
  '不是',
  '不',
  '没',
  '未',
  '无',
  '非',
  '别',
  '勿',
  '莫',
  '否',
]

// Words that contain a negation-looking character but do not negate anything.
// Without this list every 「非常」「无论」「未来」 would read as a polarity flip.
const NON_NEGATING = [
  '非常',
  '无论',
  '未来',
  '否则',
  '不断',
  '不仅',
  '不少',
  '别人',
  '别的',
  '特别',
  '区别',
  '分别',
  '莫名',
  '无比',
  '毫无疑问',
  '没错',
  '不错',
  '没关系',
  '不客气',
  '不用谢',
  '不好意思',
  '无聊',
  '无数',
  '非洲',
]

const ANTONYMS = [
  ['已', '未'],
  ['成功', '失败'],
  ['允许', '禁止'],
  ['增加', '减少'],
  ['上升', '下降'],
  ['通过', '否决'],
  ['支持', '反对'],
  ['同意', '拒绝'],
  ['接受', '拒绝'],
  ['正确', '错误'],
  ['在线', '离线'],
  ['开启', '关闭'],
  ['存活', '死亡'],
  ['包含', '排除'],
  ['可以', '不能'],
  ['喜欢', '讨厌'],
  ['有效', '无效'],
  ['合法', '非法'],
  ['安全', '危险'],
  ['修复', '破坏'],
]

const NUMBER = /\d+(?:\.\d+)?/g
const CN_NUMBER = /[〇零一二两三四五六七八九十百千万亿]{2,}|[两三四五六七八九十百千万亿]/g
const NON_WORD = /[^\u4e00-\u9fff0-9A-Za-z]/g

function normalize(text) {
  return String(text ?? '').replace(NON_WORD, '').replace(/\s+/g, '').toLowerCase()
}

function bigrams(text) {
  const s = normalize(text)
  const out = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return new Set(out)
}

/** CJK bigram Jaccard, same measure the reference uses to gate near-duplicates. */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const g of A) if (B.has(g)) shared += 1
  return shared / (A.size + B.size - shared)
}

function numberSet(text) {
  const out = new Set()
  for (const m of String(text).matchAll(NUMBER)) out.add(m[0])
  const withoutDigits = String(text).replace(NUMBER, ' ')
  for (const m of withoutDigits.matchAll(CN_NUMBER)) out.add('cn:' + m[0])
  return out
}

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function hasNegation(fragment) {
  if (!fragment) return false
  let s = String(fragment).toLowerCase()
  for (const word of NON_NEGATING) s = s.split(word).join(' ')
  if (/\b(not|no|never|none|cannot|n't|without)\b/.test(s)) return true
  return NEG_MARKERS.some((marker) => s.includes(marker))
}

function commonPrefixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

function commonSuffixLength(a, b, from) {
  let i = 0
  while (i < a.length - from && i < b.length - from && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/**
 * True when a shared prefix+suffix already covers most of both strings — i.e.
 * the same statement with a different slot, even if bigram overlap is low.
 */
function isSameShape(na, nb) {
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return false
  const prefix = commonPrefixLength(na, nb)
  const suffix = commonSuffixLength(na, nb, prefix)
  return prefix + suffix >= 0.6 * maxLen
}

/**
 * Compare two facts. Returns a change descriptor, or null when the two are not
 * a near-duplicate pair or differ only in wording.
 */
export function analyzeChange(a, b, { minSimilarity = 0.5 } = {}) {
  const rawA = String(a ?? '')
  const rawB = String(b ?? '')
  if (rawA === rawB) return null

  const na = normalize(rawA)
  const nb = normalize(rawB)
  if (na === nb) return null // punctuation / filler-only restatement: a duplicate

  const numsA = numberSet(rawA)
  const numsB = numberSet(rawB)
  if (numsA.size > 0 && numsB.size > 0 && !sameSet(numsA, numsB)) {
    // still gated: two unrelated sentences that happen to contain different
    // numbers are not a correction
    if (isSameShape(na, nb) || similarity(rawA, rawB) >= minSimilarity) {
      return { kind: 'number', before: [...numsA].join(','), after: [...numsB].join(',') }
    }
    return null
  }

  const prefix = commonPrefixLength(na, nb)
  const suffix = commonSuffixLength(na, nb, prefix)
  const fragmentA = na.slice(prefix, na.length - suffix)
  const fragmentB = nb.slice(prefix, nb.length - suffix)

  // Near-duplicate gate. Bigram Jaccard alone rejects short sentences where the
  // changed part is a large fraction ("服务器在线" vs "服务器离线" scores 0.33),
  // so a shared prefix/suffix that covers most of both strings also counts as
  // "the same statement". The kind checks below stay narrow, which is what keeps
  // "喜欢猫 / 喜欢狗" from being read as a correction.
  if (!(isSameShape(na, nb) || similarity(rawA, rawB) >= minSimilarity)) return null

  if (hasNegation(fragmentA) !== hasNegation(fragmentB)) {
    return { kind: 'polarity', before: fragmentA, after: fragmentB }
  }

  // an antonym can be split by the alignment (在线/离线 differ by one character),
  // so look in a small window around the change and require each side to be the
  // only one carrying its word
  const windowA = na.slice(Math.max(0, prefix - 3), na.length - Math.max(0, suffix - 3))
  const windowB = nb.slice(Math.max(0, prefix - 3), nb.length - Math.max(0, suffix - 3))
  for (const [x, y] of ANTONYMS) {
    for (const [p, q] of [
      [x, y],
      [y, x],
    ]) {
      if (windowA.includes(p) && windowB.includes(q) && !nb.includes(p) && !na.includes(q)) {
        return { kind: 'antonym', before: p, after: q }
      }
    }
  }

  return null
}
