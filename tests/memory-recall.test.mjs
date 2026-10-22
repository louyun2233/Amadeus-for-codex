import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore, TOUCH_BOOST_WINDOW_MS, TOUCH_THROTTLE_MS } from '../src/core/memory.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Retrieval recency, adapted from lingshu's bench_recall_drift.py (MIT,
 * Copyright (c) 2026 FuRongJun-1999): its mechanism is
 * `search -> last_access -> recall` — what you keep asking about stays near the
 * top. That bench exists to expose the drift this can cause, so the boost here
 * is deliberately bounded rather than permanent.
 */

const T0 = 1_700_000_000_000
const DAY = 86_400_000

function store() {
  const paths = tempPaths()
  return { paths, memory: new MemoryStore(paths, new ConfigStore(paths)) }
}

test('retrieval boosts what you keep asking about', () => {
  const { paths, memory } = store()
  try {
    const rust = memory.add('panel', { content: '用户在学 Rust', ts: T0 - 60 * DAY })
    const go = memory.add('panel', { content: '用户在学 Go', ts: T0 - 60 * DAY })

    // ask about Rust specifically, a minute apart so the throttle lets each one through
    for (let i = 1; i <= 5; i++) memory.search('Rust', { now: T0 + i * TOUCH_THROTTLE_MS })

    // now a query both facts match
    const hits = memory.search('在学', { now: T0 + 6 * TOUCH_THROTTLE_MS, touch: false })
    const scoreRust = hits.find((h) => h.id === rust.id)?.score ?? 0
    const scoreGo = hits.find((h) => h.id === go.id)?.score ?? 0
    assert.equal(hits[0].id, rust.id, 'the fact you keep asking about should rank first')
    assert.ok(scoreRust > scoreGo, `${scoreRust} should beat ${scoreGo}`)
  } finally {
    cleanup(paths)
  }
})

test('the boost expires instead of sticking forever', () => {
  const { paths, memory } = store()
  try {
    const rust = memory.add('panel', { content: '用户在学 Rust', ts: T0 - 60 * DAY })
    const go = memory.add('panel', { content: '用户在学 Go', ts: T0 - 60 * DAY })
    for (let i = 1; i <= 5; i++) memory.search('Rust', { now: T0 + i * TOUCH_THROTTLE_MS })

    const later = T0 + TOUCH_BOOST_WINDOW_MS + 10 * DAY
    const hits = memory.search('在学', { now: later, touch: false })
    const scoreRust = hits.find((h) => h.id === rust.id).score
    const scoreGo = hits.find((h) => h.id === go.id).score
    assert.equal(scoreRust, scoreGo, 'after the window both fall back to creation recency')
  } finally {
    cleanup(paths)
  }
})

test('a burst of lookups writes at most one timestamp', () => {
  const { paths, memory } = store()
  try {
    const fact = memory.add('panel', { content: '用户在学 Rust', ts: T0 })
    const at = T0 + TOUCH_THROTTLE_MS
    for (let i = 0; i < 10; i++) memory.search('Rust', { now: at })
    const stored = memory.list('panel', { includeSuperseded: true }).find((e) => e.id === fact.id)
    assert.equal(stored.lastAccess, at, 'ten lookups in the same instant must not rewrite ten times')
    assert.equal(stored.ts, T0, 'creation time is never rewritten')
  } finally {
    cleanup(paths)
  }
})

test('boosting one fact does not starve the others', () => {
  const { paths, memory } = store()
  try {
    const rust = memory.add('panel', { content: '用户在学 Rust', ts: T0 - 60 * DAY })
    const go = memory.add('panel', { content: '用户在学 Go', ts: T0 - 60 * DAY })
    for (let i = 1; i <= 5; i++) memory.search('Rust', { now: T0 + i * TOUCH_THROTTLE_MS })

    const goHits = memory.search('Go', { now: T0 + 6 * TOUCH_THROTTLE_MS })
    assert.equal(goHits[0].id, go.id, 'a query only Go matches still finds Go')
    assert.ok(!goHits.some((h) => h.id === rust.id))
  } finally {
    cleanup(paths)
  }
})

test('touch can be disabled for a read-only query', () => {
  const { paths, memory } = store()
  try {
    const fact = memory.add('panel', { content: '用户在学 Rust', ts: T0 })
    memory.search('Rust', { now: T0 + 5 * TOUCH_THROTTLE_MS, touch: false })
    const stored = memory.list('panel').find((e) => e.id === fact.id)
    assert.equal(stored.lastAccess, T0)
  } finally {
    cleanup(paths)
  }
})

test('superseded facts are never served, so they are never boosted', () => {
  const { paths, memory } = store()
  try {
    const old = memory.add('panel', { content: '用户对花生过敏', ts: T0 - 60 * DAY })
    memory.add('panel', { content: '用户对花生不过敏', ts: T0 - 60 * DAY })
    memory.search('花生', { now: T0 + 5 * TOUCH_THROTTLE_MS })
    const stored = memory.list('panel', { includeSuperseded: true }).find((e) => e.id === old.id)
    assert.equal(stored.lastAccess, T0 - 60 * DAY, 'a hidden fact must not accumulate recency')
  } finally {
    cleanup(paths)
  }
})

test('only a touching query records the access', () => {
  const { paths, memory } = store()
  try {
    const entry = memory.add('panel', { content: '用户在学 Rust', ts: T0 })
    const file = path.join(paths.memoryDir, 'panel.json')
    // Assert the stored field, never the file mtime: NTFS tunnels the
    // timestamps of a recreated file, so "write temp then rename over the same
    // name" can leave mtime byte-identical. An mtime probe both flakes and,
    // worse, passes vacuously when nothing was written at all.
    const onDisk = () =>
      JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((e) => e.id === entry.id).lastAccess

    assert.equal(onDisk(), T0, 'a fresh fact starts at its own timestamp')

    assert.equal(memory.search('Rust', { now: T0 + 5 * TOUCH_THROTTLE_MS, touch: false }).length, 1)
    assert.equal(onDisk(), T0, 'a read-only query must not record an access')

    assert.equal(memory.search('Rust', { now: T0 + 6 * TOUCH_THROTTLE_MS }).length, 1)
    assert.equal(onDisk(), T0 + 6 * TOUCH_THROTTLE_MS, 'a touching query records the access')

    // ...but the throttle still applies inside the window
    memory.search('Rust', { now: T0 + 6 * TOUCH_THROTTLE_MS + 1 })
    assert.equal(onDisk(), T0 + 6 * TOUCH_THROTTLE_MS, 'a second query inside the window is absorbed')
  } finally {
    cleanup(paths)
  }
})
