import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeChange, similarity } from '../src/core/contradiction.mjs'

/**
 * Measure the contradiction detector instead of trusting a handful of examples.
 *
 * Follows lingshu's discipline (MIT, © 2026 FuRongJun-1999; see
 * bench/repro/bench_contradiction_fp.py): only judge the detector on pairs that
 * would actually reach it — near-duplicates — and report the rate plus samples
 * rather than a pass/fail hunch.
 *
 * Two rates matter, and they trade off against each other:
 *   false positive — a truth-preserving rewrite read as a correction. The cost
 *                    is a *true* fact being silently hidden from her context.
 *   miss           — a real correction not detected, so both the stale and the
 *                    corrected fact stay servable.
 *
 * The corpus is synthetic on purpose: it is deterministic, reviewable, and uses
 * the same sentence shapes this project's memory actually stores.
 */

const FACTS = [
  '用户每天服用 20 毫克，饭后半小时服用',
  '用户对青霉素严重过敏，开药时需要特别注意',
  '用户住在东城区 12 号，周末在家',
  '用户负责北极星计划，截止时间是下个月',
  '用户的车牌是京 A12345，工作日开车上班',
  '用户喜欢在慢时光咖啡馆写代码',
  '用户提交的年度预算方案在部门会议上获得通过',
  '编号 42 的安全漏洞已经修复，补丁在上周发布',
  '用户常去的健身房在江岸区，每周去三次',
  '用户的航班定于 9 点起飞，登机口在 12 号',
]

// Truth-preserving rewrites. Anything the detector flags here is a false positive.
const REWRITES = [
  (s) => s + '。',
  (s) => s.replace('，', ','),
  (s) => s + '啊',
  (s) => s.replace('，', '，') + '呢',
  (s) => s.replace('特别注意', '非常注意'),
  (s) => s.replace('每天', '每日'),
  (s) => s.replace('，饭后', '， 饭后'),
]

// Real corrections. `number` is exact (it is checked before the diff); the
// polarity/antonym kinds legitimately overlap, because 否/未 are both negation
// markers and one half of an antonym pair — measuring the rates is what surfaced
// that, so the contract asserts detection plus a plausible kind.
const CORRECTIONS = [
  ['用户对青霉素严重过敏，开药时需要特别注意', '用户对青霉素不过敏，开药时需要特别注意', ['polarity']],
  ['编号 42 的安全漏洞已经修复，补丁在上周发布', '编号 42 的安全漏洞尚未修复，补丁在上周发布', ['polarity', 'antonym']],
  ['用户提交的年度预算方案在部门会议上获得通过', '用户提交的年度预算方案在部门会议上被否决', ['antonym', 'polarity']],
  ['用户常去的健身房在江岸区，每周去三次', '用户常去的健身房不在江岸区，每周去三次', ['polarity']],
  ['用户每天服用 20 毫克，饭后半小时服用', '用户每天服用 30 毫克，饭后半小时服用', ['number']],
  ['用户的航班定于 9 点起飞，登机口在 12 号', '用户的航班定于 11 点起飞，登机口在 12 号', ['number']],
  ['用户的车牌是京 A12345，工作日开车上班', '用户的车牌是京 A54321，工作日开车上班', ['number']],
  ['用户的服务器在线，随时可以连', '用户的服务器离线，随时可以连', ['antonym']],
]

const NEAR_DUPLICATE = 0.5

test('false positives on truth-preserving rewrites stay at zero', () => {
  const pairs = []
  for (const fact of FACTS) {
    for (const rewrite of REWRITES) {
      const other = rewrite(fact)
      if (other === fact) continue
      // only judge pairs that would actually reach the detector
      if (similarity(fact, other) < NEAR_DUPLICATE && !sameShape(fact, other)) continue
      pairs.push([fact, other])
    }
  }
  assert.ok(pairs.length >= 30, `expected a meaningful sample, got ${pairs.length}`)

  const flagged = pairs.filter(([a, b]) => analyzeChange(a, b))
  const rate = flagged.length / pairs.length
  console.log(
    `  near-duplicate pairs judged: ${pairs.length}; false positives: ${flagged.length} (${(rate * 100).toFixed(1)}%)`,
  )
  for (const [a, b] of flagged.slice(0, 5)) console.log(`    FP sample:\n      a: ${a}\n      b: ${b}`)

  assert.equal(flagged.length, 0, 'a truth-preserving rewrite must never be read as a correction')
})

test('every real correction is detected, with a plausible kind', () => {
  const missed = []
  const kindCount = {}
  for (const [before, after, allowed] of CORRECTIONS) {
    const found = analyzeChange(before, after)
    if (found) kindCount[found.kind] = (kindCount[found.kind] || 0) + 1
    if (!found) missed.push(`not detected: ${before} -> ${after}`)
    else if (!allowed.includes(found.kind)) {
      missed.push(`wrong kind: ${before} -> ${after} (got ${found.kind}, expected one of ${allowed.join('/')})`)
    }
  }
  console.log(
    `  corrections: ${CORRECTIONS.length - missed.length}/${CORRECTIONS.length} detected` +
      `  kinds: ${JSON.stringify(kindCount)}`,
  )
  for (const m of missed) console.log(`    miss: ${m}`)
  assert.deepEqual(missed, [], 'a real correction must be detected exactly once, with a plausible kind')
})

test('the detector reports the number kind precisely', () => {
  // numbers are compared before the diff, so this kind must never be fuzzy
  for (const [before, after, allowed] of CORRECTIONS) {
    if (!allowed.includes('number')) continue
    const found = analyzeChange(before, after)
    assert.equal(found?.kind, 'number', `${before} -> ${after}`)
    assert.ok(found.before !== found.after, 'the changed value should be reported')
  }
})

// mirror of the module's own near-duplicate gate, used only to decide whether a
// pair is worth judging (the module exposes similarity, not the gate)
function sameShape(a, b) {
  const na = String(a).replace(/[^\u4e00-\u9fff0-9A-Za-z]/g, '').toLowerCase()
  const nb = String(b).replace(/[^\u4e00-\u9fff0-9A-Za-z]/g, '').toLowerCase()
  let p = 0
  while (p < na.length && p < nb.length && na[p] === nb[p]) p += 1
  let s = 0
  while (s < na.length - p && s < nb.length - p && na[na.length - 1 - s] === nb[nb.length - 1 - s]) s += 1
  return p + s >= 0.6 * Math.max(na.length, nb.length)
}
