import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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

test('a soft capacity never silently deletes durable memories', () => {
  const paths = tempPaths()
  try {
    const config = new ConfigStore(paths)
    config.update({ memory: { maxPerNamespace: 10 } })
    const memory = new MemoryStore(paths, config)
    for (let i = 0; i < 12; i++) {
      memory.add('panel', { content: `摘要 ${i}`, type: 'summary', supersede: false, ts: i + 1 })
    }
    assert.equal(memory.stats().panel.total, 12)
    assert.deepEqual(memory.list('panel').map((entry) => entry.content),
      Array.from({ length: 12 }, (_, index) => `摘要 ${11 - index}`))
  } finally {
    cleanup(paths)
  }
})

test('recaps have their own short retention window and never evict facts', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    const fact = memory.add('panel', { content: '用户喜欢科幻电影', ts: 1 })
    for (let i = 0; i < 6; i++) {
      memory.add('panel', { content: `上次聊天：第${i}次`, type: 'recap', source: 'conversation', ts: i + 2 })
    }
    assert.equal(memory.list('panel', { types: ['recap'] }).length, 3)
    assert.equal(memory.list('panel', { types: ['fact'] })[0].id, fact.id)
    assert.equal(memory.list('panel', { types: ['recap'] })[0].content, '上次聊天：第5次')
  } finally {
    cleanup(paths)
  }
})

test('memory reads its backup after a torn write, without resetting to empty', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    memory.add('panel', { content: '用户喜欢天文学' })
    memory.add('panel', { content: '用户喜欢物理学' })
    const file = path.join(paths.memoryDir, 'panel.json')
    assert.equal(fs.existsSync(`${file}.bak`), true)
    fs.writeFileSync(file, '{"entries": [', 'utf8')
    assert.equal(memory.list('panel')[0].content, '用户喜欢天文学')
    memory.add('panel', { content: '用户喜欢数学' })
    assert.deepEqual(memory.list('panel').map((entry) => entry.content),
      ['用户喜欢数学', '用户喜欢天文学'])
  } finally {
    cleanup(paths)
  }
})

test('corrupt memory with no good backup fails closed instead of becoming empty', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    const file = path.join(paths.memoryDir, 'panel.json')
    fs.mkdirSync(paths.memoryDir, { recursive: true })
    fs.writeFileSync(file, '{broken', 'utf8')
    assert.throws(() => memory.add('panel', { content: '不能覆盖原文件' }), /could not be read/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  } finally {
    cleanup(paths)
  }
})

test('explicit forgetting removes the automatic backup as well', () => {
  const paths = tempPaths()
  try {
    const memory = makeStore(paths)
    const first = memory.add('panel', { content: '用户喜欢猫' })
    memory.add('panel', { content: '用户喜欢狗' })
    const backup = path.join(paths.memoryDir, 'panel.json.bak')
    assert.equal(fs.existsSync(backup), true)
    memory.remove(first.id)
    assert.equal(fs.existsSync(backup), false)
    memory.add('panel', { content: '用户喜欢鸟' })
    memory.clear('panel')
    assert.equal(fs.existsSync(backup), false)
    assert.equal(memory.stats().panel.total, 0)
  } finally {
    cleanup(paths)
  }
})
