import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TaskWatcher,
  parseTaskEvent,
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
    fs.writeFileSync(live, '{}\n')
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
