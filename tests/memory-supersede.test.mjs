import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { analyzeChange, similarity } from '../src/core/contradiction.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Scenarios adapted from lingshu's bench suite (MIT, © 2026 FuRongJun-1999):
 *   bench_correction.py — polarity / number / antonym corrections must not be
 *                         swallowed as duplicates, and synonymous restatement
 *                         must not be mistaken for a correction
 *   bench_supersede.py  — after an update, the new value has to outrank the old
 */

function store() {
  const paths = tempPaths()
  return { paths, memory: new MemoryStore(paths, new ConfigStore(paths)) }
}

test('analyzeChange classifies polarity, number and antonym', () => {
  assert.equal(analyzeChange('用户对青霉素过敏', '用户对青霉素不过敏')?.kind, 'polarity')
  assert.equal(analyzeChange('剂量是 20 毫克', '剂量是 30 毫克')?.kind, 'number')
  assert.equal(analyzeChange('服务器在线', '服务器离线')?.kind, 'antonym')
})

test('analyzeChange stays silent on pure restatement', () => {
  // punctuation, filler and spacing must not read as a correction
  const pairs = [
    ['用户喜欢猫', '用户喜欢猫。'],
    ['用户喜欢猫', '用户 喜欢 猫'],
    ['用户非常喜欢猫', '用户非常喜欢猫。'],
    ['用户对花生过敏', '用户对花生过敏啊'],
  ]
  for (const [a, b] of pairs) {
    assert.equal(analyzeChange(a, b), null, `${a} vs ${b}`)
  }
})

test('negation-shaped words that do not negate are not a polarity flip', () => {
  // 「非常」「无论」 contain 非/无 but assert nothing negative
  assert.equal(analyzeChange('用户非常喜欢猫', '用户喜欢猫'), null)
  assert.equal(analyzeChange('用户无论多忙都会跑步', '用户多忙都会跑步'), null)
})

test('unrelated facts that merely look similar are not corrections', () => {
  assert.equal(analyzeChange('用户喜欢猫', '用户喜欢狗'), null)
  assert.equal(analyzeChange('用户在学 Rust', '用户在学 Go'), null)
})

test('a polarity correction supersedes the fact it corrects', () => {
  const { paths, memory } = store()
  try {
    const first = memory.add('panel', { content: '用户对青霉素过敏' })
    const second = memory.add('panel', { content: '用户对青霉素不过敏' })

    const active = memory.list('panel')
    assert.equal(active.length, 1)
    assert.equal(active[0].id, second.id)
    assert.equal(second.changeKind, 'polarity')
    assert.deepEqual(second.supersedes, first.id)

    const all = memory.list('panel', { includeSuperseded: true })
    assert.equal(all.length, 2, 'the corrected fact is kept for audit')
    const old = all.find((e) => e.id === first.id)
    assert.equal(old.supersededBy, second.id)
    assert.equal(old.supersedeKind, 'polarity')
    assert.equal(old.confidence, 0)
  } finally {
    cleanup(paths)
  }
})

test('a number correction supersedes, and the new value ranks first', () => {
  const { paths, memory } = store()
  try {
    const old = memory.add('panel', { content: '用户每天服用 20 毫克' })
    const fresh = memory.add('panel', { content: '用户每天服用 30 毫克' })
    assert.equal(fresh.changeKind, 'number')

    const hits = memory.search('用户每天服用多少毫克', { k: 5 })
    assert.equal(hits[0].id, fresh.id, 'the corrected value must win the top slot')
    assert.ok(!hits.some((h) => h.id === old.id), 'the stale value must not be served')
  } finally {
    cleanup(paths)
  }
})

test('an antonym correction supersedes', () => {
  const { paths, memory } = store()
  try {
    memory.add('codex', { content: '北区订单服务器在线' })
    const fresh = memory.add('codex', { content: '北区订单服务器离线' })
    assert.equal(fresh.changeKind, 'antonym')
    assert.equal(memory.list('codex').length, 1)
  } finally {
    cleanup(paths)
  }
})

test('superseded entries are hidden but still counted', () => {
  const { paths, memory } = store()
  try {
    memory.add('panel', { content: '用户对花生过敏' })
    memory.add('panel', { content: '用户对花生不过敏' })
    const stats = memory.stats()
    assert.equal(stats.panel.total, 2)
    assert.equal(stats.panel.active, 1)
    assert.equal(stats.panel.superseded, 1)
    assert.equal(memory.search('花生', { k: 5 }).length, 1)
    assert.equal(memory.search('花生', { k: 5, includeSuperseded: true }).length, 2)
  } finally {
    cleanup(paths)
  }
})

test('supersede can be switched off per write', () => {
  const { paths, memory } = store()
  try {
    memory.add('panel', { content: '用户对花生过敏' })
    memory.add('panel', { content: '用户对花生不过敏', supersede: false })
    assert.equal(memory.list('panel').length, 2, 'both are kept when supersede is off')
  } finally {
    cleanup(paths)
  }
})

test('correcting twice keeps only the newest fact active', () => {
  const { paths, memory } = store()
  try {
    const a = memory.add('panel', { content: '剂量是 10 毫克' })
    const b = memory.add('panel', { content: '剂量是 20 毫克' })
    const c = memory.add('panel', { content: '剂量是 30 毫克' })
    const active = memory.list('panel')
    assert.equal(active.length, 1)
    assert.equal(active[0].id, c.id)
    const all = memory.list('panel', { includeSuperseded: true })
    assert.equal(all.length, 3)
    assert.equal(all.find((e) => e.id === a.id).supersededBy, b.id)
    assert.equal(all.find((e) => e.id === b.id).supersededBy, c.id)
  } finally {
    cleanup(paths)
  }
})

test('a previously corrected fact can be asserted again', () => {
  const { paths, memory } = store()
  try {
    const first = memory.add('panel', { content: '用户对花生过敏' })
    const second = memory.add('panel', { content: '用户对花生不过敏' })
    const third = memory.add('panel', { content: '用户对花生过敏' })
    assert.notEqual(third.id, first.id)
    assert.equal(memory.list('panel').length, 1)
    assert.equal(memory.list('panel')[0].id, third.id)
    assert.equal(memory.list('panel', { includeSuperseded: true }).find((x) => x.id === second.id).supersededBy, third.id)
  } finally {
    cleanup(paths)
  }
})

test('the near-duplicate gate keeps the detector conservative', () => {
  // same polarity flip, but the two sentences are not near-duplicates
  assert.ok(similarity('用户对青霉素过敏', '用户对青霉素不过敏') > 0.6)
  assert.equal(analyzeChange('用户对青霉素过敏，开药注意', '张三对布洛芬不过敏，饮食注意'), null)
})
