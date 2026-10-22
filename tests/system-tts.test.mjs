import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SystemTts, sanitize, SYSTEM_TTS_MAX_CHARS } from '../src/core/system-tts.mjs'

/**
 * System speech is the one channel that can leave a process behind, overlap
 * itself, or read markup out loud. The rules under test: one process at a
 * time, a bounded queue that never drops the line already being spoken, the
 * text never on the command line on Windows, and a reason instead of a throw
 * whenever the platform has no voice at all.
 */

function fakeChild({ autoExit = true } = {}) {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    setImmediate(() => child.emit('exit', null, 'SIGTERM'))
    return true
  }
  if (autoExit) setImmediate(() => child.emit('exit', 0, null))
  return child
}

function harness({ platform = 'win32', which = () => true, timeoutMs, autoExit = true } = {}) {
  const spawned = []
  const tts = new SystemTts({
    platform,
    spawnImpl: (cmd, args, opts) => {
      const child = fakeChild({ autoExit })
      spawned.push({ cmd, args, opts, child })
      return child
    },
    whichImpl: which,
    env: {},
    timeoutMs,
  })
  return { tts, spawned }
}

test('sanitize strips markup and caps what the engine has to read', () => {
  assert.equal(sanitize('  【excited】目标   达成  '), '目标 达成')
  assert.equal(sanitize('【only markup】'), null)
  assert.equal(sanitize('   '), null)
  assert.equal(sanitize(undefined), null)
  assert.equal(sanitize('あ'.repeat(500)).length, SYSTEM_TTS_MAX_CHARS)
})

test('windows speaks through the environment, never through the command line', async () => {
  const { tts, spawned } = harness()
  const line = tts.speak('目标达成【excited】')

  assert.equal(spawned.length, 1)
  const [call] = spawned
  assert.equal(call.cmd, 'powershell.exe')
  assert.equal(call.opts.env.AMADEUS_SPEAK_TEXT, '目标达成')
  const argv = call.args.join(' ')
  assert.ok(!argv.includes('目标达成'), 'the text must not be interpolated into the command')
  assert.ok(!argv.includes('【'), 'and neither may the raw markup')

  call.child.emit('exit', 0, null)
  const result = await line
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'windows-sapi')
  assert.equal(result.chars, '目标达成'.length)
})

test('macos and linux hand the text over as an argument', async () => {
  const mac = harness({ platform: 'darwin' })
  const macLine = mac.tts.speak('测试一句')
  assert.equal(mac.spawned[0].cmd, 'say')
  assert.deepEqual(mac.spawned[0].args, ['测试一句'])
  mac.spawned[0].child.emit('exit', 0, null)
  assert.equal((await macLine).ok, true)

  const linux = harness({ platform: 'linux', which: (cmd) => cmd === 'espeak-ng' })
  assert.equal(linux.tts.describe().backend, 'linux-espeak')
  const linuxLine = linux.tts.speak('测试')
  assert.equal(linux.spawned[0].cmd, 'espeak-ng')
  linux.spawned[0].child.emit('exit', 0, null)
  assert.equal((await linuxLine).ok, true)
})

test('a platform without a speech command degrades instead of throwing', async () => {
  const { tts } = harness({ platform: 'aix' })
  assert.equal(tts.available(), false)
  assert.equal(tts.describe().reason.includes('aix'), true)
  const result = await tts.speak('你好')
  assert.equal(result.ok, false)
  assert.equal(result.degrade, 'no-system-voice')

  const missing = harness({ platform: 'linux', which: () => false })
  assert.equal(missing.tts.available(), false)
  assert.equal((await missing.tts.speak('你好')).degrade, 'no-system-voice')
})

test('the backend probe runs once and is cached', () => {
  const seen = []
  const { tts } = harness({
    platform: 'linux',
    which: (cmd) => {
      seen.push(cmd)
      return cmd === 'espeak-ng'
    },
  })
  assert.equal(tts.available(), true)
  assert.equal(tts.available(), true)
  assert.deepEqual(seen, ['spd-say', 'espeak-ng'])
})

test('lines never overlap, and the queue drops the newest instead of the speaking one', async () => {
  const { tts, spawned } = harness({ autoExit: false })
  const first = tts.speak('第一句')
  const second = tts.speak('第二句')
  const third = tts.speak('第三句')
  const dropped = tts.speak('第四句')

  assert.equal(spawned.length, 1, 'only one process may run at a time')
  assert.equal((await dropped).degrade, 'queue-full')

  spawned[0].child.emit('exit', 0, null)
  assert.equal((await first).ok, true)
  assert.equal(spawned.length, 2, 'the next queued line starts when the first finishes')
  assert.equal(spawned[1].opts.env.AMADEUS_SPEAK_TEXT, '第二句')

  spawned[1].child.emit('exit', 0, null)
  assert.equal((await second).ok, true)
  assert.equal(spawned.length, 3)
  spawned[2].child.emit('exit', 0, null)
  assert.equal((await third).ok, true)
  assert.equal(tts.describe().speaking, false)
  assert.equal(tts.describe().queue, 0)
})

test('a hung speech process is killed and reported', async () => {
  const children = []
  const tts = new SystemTts({
    platform: 'win32',
    spawnImpl: () => {
      const child = fakeChild({ autoExit: false })
      children.push(child)
      return child
    },
    whichImpl: () => true,
    env: {},
    timeoutMs: 20,
  })
  const result = await tts.speak('卡住的句子')
  assert.equal(result.ok, false)
  assert.equal(result.degrade, 'system-tts-timeout')
  assert.equal(children[0].killed, true)
})

test('a failing speech process reports a reason instead of throwing', async () => {
  const { tts, spawned } = harness()
  const line = tts.speak('会失败的句子')
  spawned[0].child.emit('exit', 1, null)
  const result = await line
  assert.equal(result.ok, false)
  assert.equal(result.degrade, 'system-tts-failed')
  assert.match(result.detail, /exit 1/)
  assert.equal(tts.describe().lastDegrade, 'system-tts-failed')
})

test('shutdown stops the current line and clears what was waiting', async () => {
  const { tts, spawned } = harness()
  const first = tts.speak('正在说的句子')
  const second = tts.speak('排队的句子')
  tts.shutdown()

  assert.equal((await first).degrade, 'shutdown')
  assert.equal((await second).degrade, 'shutdown')
  assert.equal(spawned[0].child.killed, true)
  assert.equal(tts.describe().speaking, false)
  assert.equal(tts.describe().queue, 0)
})

test('empty text is refused before any process is created', async () => {
  const { tts, spawned } = harness()
  assert.equal((await tts.speak('【仅标记】')).degrade, 'empty')
  assert.equal(spawned.length, 0)
})
