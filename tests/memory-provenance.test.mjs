import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, describeMemory, relativeTime } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { buildSystemPrompt, loadPersona } from '../src/core/persona.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Provenance, the single-character form of lingshu's `recall_with_evidence`
 * (MIT, © 2026 FuRongJun-1999): recall should carry why a fact is believed, so
 * she can say "you told me that last week" and the user can audit it.
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000

function store() {
  const paths = tempPaths()
  return { paths, memory: new MemoryStore(paths, new ConfigStore(paths)) }
}

test('relative time buckets read naturally', () => {
  assert.equal(relativeTime(NOW - 5 * 1000, NOW), '刚刚')
  assert.equal(relativeTime(NOW - 5 * MINUTE, NOW), '5 分钟前')
  assert.equal(relativeTime(NOW - 5 * HOUR, NOW), '5 小时前')
  assert.equal(relativeTime(NOW - 5 * DAY, NOW), '5 天前')
  assert.equal(relativeTime(NOW - 70 * DAY, NOW), '2 个月前')
  assert.equal(relativeTime(undefined, NOW), '时间不明')
})

test('provenance names the origin of every write path', () => {
  const cases = [
    ['auto-extract', '面板对话里提到的'],
    ['mcp', 'Agent 记下的'],
    ['cli', '手动写入的'],
    ['api', '手动写入的'],
    ['unknown', '来源不明'],
    ['something-new', '来源不明'],
  ]
  for (const [source, expected] of cases) {
    const text = describeMemory({ source, ts: NOW - DAY }, NOW)
    assert.ok(text.includes(expected), `${source} -> ${text}`)
    assert.ok(text.includes('1 天前'), text)
  }
})

test('a corrected fact says so', () => {
  const text = describeMemory({ source: 'mcp', ts: NOW - HOUR, supersededBy: 'x' }, NOW)
  assert.ok(text.includes('已被更正'), text)
})

test('the prompt carries provenance with each fact', () => {
  const persona = loadPersona('kurisu')
  const prompt = buildSystemPrompt({
    persona,
    now: NOW,
    memories: [
      { content: '用户对花生过敏', source: 'auto-extract', ts: NOW - DAY, namespace: 'panel' },
      { content: '项目代号是北极星', source: 'mcp', ts: NOW - 3 * DAY, namespace: 'codex' },
    ],
  })
  assert.ok(prompt.includes('用户对花生过敏（1 天前，面板对话里提到的）'), 'fact 1 should carry its origin')
  assert.ok(prompt.includes('项目代号是北极星（3 天前，Agent 记下的）'), 'fact 2 should carry its origin')
  assert.ok(/不要说出「记忆数据」/.test(prompt), 'the persona is told not to expose the mechanics')
})

test('recall never puts a corrected fact into the prompt', () => {
  const { paths, memory } = store()
  try {
    memory.add('panel', { content: '用户对花生过敏', source: 'auto-extract', ts: NOW - 2 * DAY })
    memory.add('panel', { content: '用户对花生不过敏', source: 'auto-extract', ts: NOW - DAY })
    const recalled = memory.search('花生', { k: 8, now: NOW, touch: false })
    const prompt = buildSystemPrompt({ persona: loadPersona('kurisu'), memories: recalled, now: NOW })
    assert.ok(prompt.includes('用户对花生不过敏'))
    assert.ok(!prompt.includes('用户对花生过敏（'), 'the stale fact must not reach her')
  } finally {
    cleanup(paths)
  }
})

test('the api-facing entries carry a provenance string', () => {
  const { paths, memory } = store()
  try {
    memory.add('panel', { content: '用户住在东城区', source: 'auto-extract', ts: NOW - HOUR })
    const entry = memory.list('panel')[0]
    // the daemon maps entries through describeMemory; assert the same shape
    assert.equal(describeMemory(entry, NOW), '1 小时前，面板对话里提到的')
  } finally {
    cleanup(paths)
  }
})
