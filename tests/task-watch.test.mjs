import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TaskWatcher,
  parseTaskEvent,
  readSessionMeta,
  readSessionCwd,
  isOwnSessionCwd,
  newestRollouts,
} from '../src/host/task-watch.mjs'

/**
 * Desktop turns never reach the notify hook, so she stayed quiet while the user
 * watched a task run. Codex writes its own session rollout as JSONL and every
 * turn shows up there; these tests pin the read-only tail that turns those
 * lines into "she said something".
 */

function tempSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-rollouts-'))
  const day = path.join(root, '2026', '10', '17')
  fs.mkdirSync(day, { recursive: true })
  return { root, day }
}

function rollout(day, name, { cwd = 'C:\\work\\project' } = {}) {
  const file = path.join(day, `rollout-${name}.jsonl`)
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_meta', payload: { session_id: name, cwd } })}\n`,
  )
  return file
}

function append(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
}

test('the three turn boundaries are recognised', () => {
  const line = (payload) => JSON.stringify({ timestamp: '2026-10-17T00:00:00.000Z', type: 'event_msg', payload })
  assert.deepEqual(parseTaskEvent(line({ type: 'task_started', turn_id: 't1' })), {
    kind: 'start',
    turnId: 't1',
    at: Date.parse('2026-10-17T00:00:00.000Z'),
  })
  assert.equal(parseTaskEvent(line({ type: 'task_complete', turn_id: 't2' })).kind, 'complete')
  assert.equal(parseTaskEvent(line({ type: 'turn_aborted', turn_id: 't3' })).kind, 'failed')
  assert.equal(parseTaskEvent(line({ type: 'reasoning' })), null)
  assert.equal(parseTaskEvent(line({ type: 'task_complete' })), null, 'a turn without an id is ignored')
  assert.equal(parseTaskEvent('not json'), null)
})

test('the panel own chat is not a user task', () => {
  const { root, day } = tempSessions()
  try {
    const mine = rollout(day, 'own', { cwd: 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\runtime\\chatcwd' })
    assert.equal(readSessionCwd(mine), 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\runtime\\chatcwd')
    assert.equal(isOwnSessionCwd(readSessionCwd(mine), 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'), true)
    assert.equal(isOwnSessionCwd('C:\\Users\\ExampleUser\\AppData\\Local\\AmadeusBackup', 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'), false)
    assert.equal(isOwnSessionCwd('C:\\work\\project', 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('large Codex metadata still exposes its cwd and parent thread', () => {
  const { root, day } = tempSessions()
  try {
    const file = path.join(day, 'rollout-long.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({
      type: 'session_meta',
      payload: { cwd: 'C:\\work\\project', parent_thread_id: 'parent', base_instructions: 'x'.repeat(24 * 1024) },
    })}\n`)
    assert.equal(readSessionCwd(file), 'C:\\work\\project')
    assert.equal(readSessionMeta(file).parent_thread_id, 'parent')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a new rollout announces its start on the first poll after priming', () => {
  const { root, day } = tempSessions()
  try {
    const events = []
    const watcher = new TaskWatcher({ sessionsRoot: root, onEvent: (event) => events.push(event) })
    watcher.poll({ prime: true })
    const file = rollout(day, 'new')
    append(file, {
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'first-turn', root_turn_id: 'first-turn' },
    })
    watcher.poll()
    assert.deepEqual(events.map((event) => `${event.kind}:${event.turnId}`), ['start:first-turn'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a fast-growing rollout still announces the start outside its tail window', () => {
  const { root, day } = tempSessions()
  try {
    const events = []
    const watcher = new TaskWatcher({
      sessionsRoot: root, tailBytes: 1024, onEvent: (event) => events.push(event),
    })
    watcher.poll({ prime: true })
    const file = rollout(day, 'large-new')
    append(file, {
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'fast-turn' },
    })
    append(file, { type: 'event_msg', payload: { type: 'reasoning', text: 'x'.repeat(20_000) } })
    watcher.poll()
    assert.deepEqual(events.map((event) => `${event.kind}:${event.turnId}`), ['start:fast-turn'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an older rollout first discovered after priming does not replay its task', () => {
  const { root, day } = tempSessions()
  try {
    const file = rollout(day, 'old-unseen')
    append(file, {
      timestamp: new Date(Date.now() - 60_000).toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'past-turn' },
    })
    const events = []
    let visible = false
    const watcher = new TaskWatcher({
      sessionsRoot: root,
      listFiles: () => visible ? [{ file, mtime: Date.now() }] : [],
      onEvent: (event) => events.push(event),
    })
    watcher.poll({ prime: true })
    visible = true
    watcher.poll()
    assert.deepEqual(events, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('large panel metadata prevents its own task from being announced', () => {
  const { root, day } = tempSessions()
  try {
    const dataRoot = 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'
    const file = path.join(day, 'rollout-own-long.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({
      type: 'session_meta', payload: {
        cwd: `${dataRoot}\\runtime\\chatcwd`, base_instructions: 'x'.repeat(24 * 1024),
      },
    })}\n`)
    const events = []
    const watcher = new TaskWatcher({ sessionsRoot: root, dataRoot, onEvent: (event) => events.push(event) })
    watcher.poll({ prime: true })
    append(file, {
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'own-turn' },
    })
    watcher.poll()
    assert.deepEqual(events, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('subagent rollouts stay quiet while two independent Desktop tasks are both seen', () => {
  const { root, day } = tempSessions()
  try {
    const first = rollout(day, 'first')
    const second = rollout(day, 'second')
    const helper = path.join(day, 'rollout-helper.jsonl')
    fs.writeFileSync(helper, `${JSON.stringify({
      type: 'session_meta', payload: { cwd: 'C:\\work\\project', parent_thread_id: 'first' },
    })}\n`)
    const events = []
    const watcher = new TaskWatcher({ sessionsRoot: root, onEvent: (event) => events.push(event) })
    watcher.poll({ prime: true })
    for (const [file, id] of [[first, 'first'], [second, 'second'], [helper, 'helper']]) {
      append(file, {
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'task_started', turn_id: id, root_turn_id: id === 'helper' ? 'first' : id },
      })
    }
    watcher.poll()
    assert.deepEqual(events.map((event) => event.turnId).sort(), ['first', 'second'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('only turns appended after the watcher started are announced', () => {
  const { root, day } = tempSessions()
  try {
    const file = rollout(day, 'a')
    append(file, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } })
    const events = []
    const watcher = new TaskWatcher({ sessionsRoot: root, onEvent: (e) => events.push(e) })
    watcher.poll({ prime: true })
    assert.deepEqual(events, [], 'history must never be replayed')

    append(file, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } })
    watcher.poll()
    assert.deepEqual(
      events.map((e) => `${e.kind}:${e.turnId}`),
      ['start:new'],
    )

    append(file, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new' } })
    watcher.poll()
    assert.deepEqual(
      events.map((e) => `${e.kind}:${e.turnId}`),
      ['start:new', 'complete:new'],
    )

    // the same line arriving twice (a re-read) must not repeat the announcement
    watcher.poll()
    assert.equal(events.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a session started by the panel is ignored entirely', () => {
  const { root, day } = tempSessions()
  try {
    const mine = rollout(day, 'own', { cwd: 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\runtime\\chatcwd' })
    const theirs = rollout(day, 'theirs', { cwd: 'C:\\work\\project' })
    const events = []
    const watcher = new TaskWatcher({
      sessionsRoot: root,
      dataRoot: 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus',
      onEvent: (e) => events.push(e),
    })
    watcher.poll({ prime: true })
    append(mine, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'own-turn' } })
    append(theirs, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'user-turn' } })
    watcher.poll()
    assert.deepEqual(
      events.map((e) => e.turnId),
      ['user-turn'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a half-written line waits for the rest of the line', () => {
  const { root, day } = tempSessions()
  try {
    const file = rollout(day, 'b')
    const events = []
    const watcher = new TaskWatcher({ sessionsRoot: root, onEvent: (e) => events.push(e) })
    watcher.poll({ prime: true })

    fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_started","turn_id":"part')
    watcher.poll()
    assert.deepEqual(events, [], 'a partial line is not an event')

    fs.appendFileSync(file, 'ial"}}\n')
    watcher.poll()
    assert.deepEqual(
      events.map((e) => e.turnId),
      ['partial'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A Desktop thread can run for days: the file being appended lives in the
 * folder it was *created* in, while newer folders hold finished sessions. The
 * first version walked the folders from the newest and stopped once it had
 * enough files, so the live file was never watched at all.
 */
test('the live thread is found even when it lives in an older folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-rollouts2-'))
  try {
    const oldDay = path.join(root, '2026', '10', '11')
    const newDay = path.join(root, '2026', '10', '17')
    fs.mkdirSync(oldDay, { recursive: true })
    fs.mkdirSync(newDay, { recursive: true })
    const live = path.join(oldDay, 'rollout-live.jsonl')
    fs.writeFileSync(live, `${JSON.stringify({
      type: 'session_meta', payload: { cwd: 'C:\\work\\project' },
    })}\n`)
    const now = Date.now() / 1000
    fs.utimesSync(live, now, now)
    // several finished sessions in the newer folder, all slightly older
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(newDay, `rollout-${i}.jsonl`)
      fs.writeFileSync(file, '{}\n')
      fs.utimesSync(file, now - 60 - i, now - 60 - i)
    }

    const found = newestRollouts(root, 3)
    assert.ok(
      found.some((entry) => entry.file === live),
      `the live file must be among the watched ones: ${found.map((e) => path.basename(e.file)).join(', ')}`,
    )

    const events = []
    const watcher = new TaskWatcher({
      sessionsRoot: root,
      maxFiles: 3,
      listFiles: (dir, limit) => newestRollouts(dir, limit),
      onEvent: (e) => events.push(e),
    })
    watcher.poll({ prime: true })
    append(live, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'live-thread' } })
    watcher.poll()
    assert.deepEqual(
      events.map((e) => e.turnId),
      ['live-thread'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
