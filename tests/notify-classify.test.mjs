import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyNotifyEvent } from '../src/core/notify-event.mjs'

/**
 * The regression this file exists for: Codex Desktop sends
 * `{"type":"agent-turn-complete", ...}` and the hook only recognised
 * `goal.*complete|task.*complete|turn.completed`, so a finished task was filed
 * as `turn-end` and the panel stayed silent.
 */
const REAL_PAYLOAD =
  '{"type":"agent-turn-complete","thread-id":"01a14033-afd4-71d1-ab9a-5158afbb30dc",' +
  '"turn-id":"01a14033-b058-7631-8da3-aa22021e91d0","cwd":"C:\\\\work",' +
  '"client":"codex_exec","input-messages":["reply with one word"],"last-assistant-message":"收到"}'

test('the payload Codex Desktop really sends counts as a finished task', () => {
  assert.deepEqual(classifyNotifyEvent(REAL_PAYLOAD), {
    kind: 'task-complete',
    type: 'agent-turn-complete',
    origin: 'codex',
  })
})

test('the separator between words does not change the verdict', () => {
  const spellings = [
    'agent-turn-complete',
    'agent.turn.complete',
    'agent_turn_completed',
    'turn.completed',
    'turn-complete',
    'turn_complete',
    'turncompleted',
    'task-complete',
    'goal.complete',
    'goalComplete',
  ]
  for (const type of spellings) {
    assert.equal(classifyNotifyEvent(JSON.stringify({ type })).kind, 'task-complete', type)
  }
})

test('a turn that merely ended is not a finished task', () => {
  const spellings = ['turn-end', 'turn-ended', 'agent-turn-start', 'turn-incomplete', 'stream.delta']
  for (const type of spellings) {
    assert.equal(classifyNotifyEvent(JSON.stringify({ type })).kind, 'turn-end', type)
  }
})

test('a payload without a type still classifies as a turn end', () => {
  assert.deepEqual(classifyNotifyEvent('{"thread-id":"x"}'), { kind: 'turn-end', type: '', origin: 'codex' })
  assert.deepEqual(classifyNotifyEvent('{}'), { kind: 'turn-end', type: '', origin: 'codex' })
})

/**
 * The panel talks to Codex through `codex exec` in its own data directory, so
 * that turn also ends with `agent-turn-complete`. Announcing it as a finished
 * task made her say the reply *and* "target achieved" on top of each other.
 */
test('a turn the panel started is recognised and never announced', () => {
  const dataRoot = 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'
  const panelTurn = JSON.stringify({
    type: 'agent-turn-complete',
    cwd: 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\runtime\\chatcwd',
    client: 'codex_exec',
  })
  assert.deepEqual(classifyNotifyEvent(panelTurn, { dataRoot }), {
    kind: 'task-complete',
    type: 'agent-turn-complete',
    origin: 'panel',
  })

  const userTask = JSON.stringify({
    type: 'agent-turn-complete',
    cwd: 'C:\\Users\\ExampleUser\\Documents\\Codex\\2026-10-09\\some-project',
  })
  assert.equal(classifyNotifyEvent(userTask, { dataRoot }).origin, 'codex')
  assert.equal(classifyNotifyEvent(REAL_PAYLOAD, { dataRoot }).origin, 'codex')
  // no data root configured: never claim a turn is ours
  assert.equal(classifyNotifyEvent(panelTurn).origin, 'codex')
})

test('a sibling directory that merely shares a prefix is not ours', () => {
  const dataRoot = 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus'
  const sibling = JSON.stringify({ type: 'agent-turn-complete', cwd: 'C:\\Users\\ExampleUser\\AppData\\Local\\AmadeusBackup' })
  assert.equal(classifyNotifyEvent(sibling, { dataRoot }).origin, 'codex')
})

test('the event name is also read from an `event` field', () => {
  assert.equal(classifyNotifyEvent('{"event":"agent-turn-complete"}').kind, 'task-complete')
})

test('an error payload is a failure regardless of its event name', () => {
  assert.equal(classifyNotifyEvent('{"type":"agent-turn-complete","status":"error"}').kind, 'task-failed')
  assert.equal(classifyNotifyEvent('{"type":"x","error":"boom"}').kind, 'task-failed')
  assert.equal(classifyNotifyEvent('the tool failed').kind, 'task-failed')
})

test('unparsable and empty input degrades instead of throwing', () => {
  for (const payload of [undefined, null, '', '{}x', 'turn-ended', '[]']) {
    const result = classifyNotifyEvent(payload)
    assert.ok(['unknown', 'turn-end'].includes(result.kind), String(payload))
  }
  assert.equal(classifyNotifyEvent('').kind, 'unknown')
  assert.equal(classifyNotifyEvent('{}x').kind, 'unknown')
})
