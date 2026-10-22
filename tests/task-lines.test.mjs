import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_LINES, TaskLinePicker } from '../src/core/task-lines.mjs'
import { EMOTIONS } from '../src/core/emotion.mjs'

test('task announcements have distinct short Japanese lines for each boundary', () => {
  for (const kind of ['start', 'complete', 'failed']) {
    const lines = TASK_LINES[kind]
    assert.ok(lines.length >= 4)
    assert.equal(new Set(lines.map((line) => line.text)).size, lines.length)
    for (const line of lines) {
      assert.match(line.text, /[\u3040-\u30ff]/)
      assert.ok(line.text.length <= 70)
      assert.ok(line.cn.length <= 80)
      assert.ok(EMOTIONS.includes(line.emotion))
    }
  }
  assert.equal(TASK_LINES.complete.some((line) => /目標、達成/.test(line.text)), false)
})

test('shuffle bags cover all variants before reuse and never repeat consecutively', () => {
  const picker = new TaskLinePicker(() => 0)
  for (const kind of ['start', 'complete', 'failed']) {
    const count = TASK_LINES[kind].length
    const first = Array.from({ length: count }, () => picker.next(kind).text)
    const second = Array.from({ length: count }, () => picker.next(kind).text)
    assert.equal(new Set(first).size, count)
    assert.equal(new Set(second).size, count)
    const together = [...first, ...second]
    for (let i = 1; i < together.length; i++) assert.notEqual(together[i], together[i - 1])
  }
  assert.equal(picker.next('unknown'), null)
})

test('task announcements can use a different source-controlled character', () => {
  const line = { text: '別の声です。', cn: '这是另一位角色。', emotion: 'neutral' }
  const picker = new TaskLinePicker(() => 0, { start: [line], complete: [line], failed: [line] })
  assert.equal(picker.next('start'), line)
  assert.equal(picker.next('complete'), line)
})
