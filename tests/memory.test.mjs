import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

function makeStore(paths) {
  const config = new ConfigStore(paths)
  return new MemoryStore(paths, config)
}

test('namespaces are isolated', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    memory.add('panel', { content: '用户喜欢叉子' })
    memory.add('codex', { content: '项目 A 使用 ESM' })
    assert.equal(memory.list('panel').length, 1)
    assert.equal(memory.list('codex').length, 1)
    assert.equal(memory.list('panel')[0].content, '用户喜欢叉子')
  } finally {
    cleanup(paths)
  }
})

test('duplicate content is not stored twice', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    memory.add('panel', { content: '用户住在上海' })
    memory.add('panel', { content: '用户住在上海' })
    assert.equal(memory.list('panel').length, 1)
  } finally {
    cleanup(paths)
  }
})

test('search matches content and reports a score', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    memory.add('panel', { content: '用户喜欢在周末看科幻电影' })
    memory.add('panel', { content: '用户使用 Windows' })
    const hits = memory.search('电影', { k: 5 })
    assert.equal(hits.length, 1)
    assert.match(hits[0].content, /电影/)
    assert.ok(hits[0].score > 0)
  } finally {
    cleanup(paths)
  }
})

test('remove / forgetByQuery / clear / export behave', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    const a = memory.add('panel', { content: '用户喜欢猫' })
    memory.add('panel', { content: '用户喜欢狗' })
    memory.add('codex', { content: '工作区是 amadeus' })

    assert.equal(memory.remove(a.id).removed, 1)
    assert.equal(memory.list('panel').length, 1)

    const forgotten = memory.forgetByQuery('狗')
    assert.equal(forgotten.removed, 1)

    const exported = memory.exportAll()
    assert.ok(Array.isArray(exported.namespaces.codex))

    const cleared = memory.clear('codex')
    assert.equal(cleared.removed, 1)
    assert.equal(memory.list('codex').length, 0)
  } finally {
    cleanup(paths)
  }
})

test('rejects empty or oversized content and unknown namespace', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    assert.throws(() => memory.add('panel', { content: '   ' }))
    assert.throws(() => memory.add('panel', { content: 'x'.repeat(501) }))
    assert.throws(() => memory.add('nope', { content: 'x' }))
  } finally {
    cleanup(paths)
  }
})

test('summary-only memory still obeys the namespace capacity', () => {
  const paths = tempPaths()
  try {
    const config = new ConfigStore(paths)
    config.update({ memory: { maxPerNamespace: 10 } })
    const memory = new MemoryStore(paths, config)
    for (let i = 0; i < 12; i++) {
      memory.add('panel', { content: `摘要 ${i}`, type: 'summary', supersede: false, ts: i + 1 })
    }
    assert.equal(memory.stats().panel.total, 10)
    assert.deepEqual(memory.list('panel').map((entry) => entry.content),
      Array.from({ length: 10 }, (_, index) => `摘要 ${11 - index}`))
  } finally {
    cleanup(paths)
  }
})
