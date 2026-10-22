import test from 'node:test'
import assert from 'node:assert/strict'
import { ProactiveScheduler, PROACTIVE_MIN_GAP_MS, CALL_CANNED } from '../src/core/scheduler.mjs'

const HOUR = 3600000

function harness(overrides = {}) {
  let now = 1_000_000_000_000
  const delivered = []
  const reports = []
  const state = { lastCallAt: 0, callCount: 0, lastUserAt: 0, lastProactiveAt: 0 }
  const config = {
    value: {
      voice: { enabled: true },
      proactive: { callEnabled: true, callIntervalMs: 10 * HOUR, idleEnabled: true, idleMs: HOUR },
    },
    get() {
      return this.value
    },
  }

  const scheduler = new ProactiveScheduler({
    clock: () => now,
    config,
    state,
    persist: () => {},
    hasAudience: () => true,
    isBusy: () => false,
    complete: async () => '【soft】\nJP: 【soft】ねぇ、起きてる？\nCN: 喂，你醒着吗？',
    deliver: (line) => delivered.push(line),
    parse: overrides.parse,
    report: (level, msg, detail) => reports.push({ level, msg, detail }),
    ...overrides.deps,
  })

  return {
    scheduler,
    state,
    delivered,
    reports,
    config,
    at: (t) => {
      now = t
    },
    advance: (ms) => {
      now += ms
    },
    now: () => now,
  }
}

test('first tick only establishes a baseline, it never calls immediately', async () => {
  const h = harness()
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'call-baseline')
  assert.equal(h.delivered.length, 0)
})

test('a call fires once the interval has elapsed', async () => {
  const h = harness()
  await h.scheduler.tick() // baseline
  h.advance(10 * HOUR + 1000)
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'call')
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].kind, 'call')
  assert.match(h.delivered[0].jp, /起きてる/)
  assert.equal(h.state.callCount, 1)
})

test('a denied tool call never becomes the incoming-call caption or speech', async () => {
  const h = harness({
    deps: { complete: async () => '嘿，最近好吗？ 来电未能发起：调用被当前审批策略拦截。' },
  })
  await h.scheduler.tick()
  h.advance(10 * HOUR + 1000)
  await h.scheduler.tick()
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].kind, 'call')
  assert.ok(CALL_CANNED.some((line) => line.jp === h.delivered[0].jp))
  assert.doesNotMatch(h.delivered[0].cn, /审批策略|来电未能发起/)
  assert.ok(h.reports.some((report) => report.msg === 'call line rejected'))
})

test('proactive calls use the active character persona and fallback line', async () => {
  const custom = { jp: '別の役です。', cn: '我是另一位角色。', emotion: 'neutral' }
  let system = ''
  const h = harness({ deps: {
    characterContent: { callCanned: [custom], idleCanned: [custom] },
    personaText: '你是测试角色。',
    complete: async (value) => { system = value; return 'invalid format' },
  } })
  await h.scheduler.tick()
  h.advance(10 * HOUR + 1000)
  await h.scheduler.tick()
  assert.equal(h.delivered[0].jp, custom.jp)
  assert.match(system, /你是测试角色/)
  assert.doesNotMatch(system, /牧濑红莉栖/)
})

test('a policy error appended to an otherwise valid call line is rejected', async () => {
  const h = harness({
    deps: {
      complete: async () => '【soft】\nJP: ねぇ、起きてる？\nCN: 喂，你醒着吗？ 来电未能发起：调用被当前审批策略拦截。',
    },
  })
  await h.scheduler.tick()
  h.advance(10 * HOUR + 1000)
  await h.scheduler.tick()
  assert.ok(CALL_CANNED.some((line) => line.jp === h.delivered[0].jp))
  assert.doesNotMatch(h.delivered[0].cn, /审批策略|来电未能发起/)
})

test('a long gap (suspend / clock jump) produces exactly one line, not a burst', async () => {
  const h = harness()
  await h.scheduler.tick()
  h.advance(200 * HOUR) // machine slept through many intervals
  const first = await h.scheduler.tick()
  const second = await h.scheduler.tick()
  assert.equal(first.action, 'call')
  assert.equal(second.action, 'none')
  assert.equal(h.delivered.length, 1)
})

test('call and idle both due: only one line is delivered, and no immediate follow-up', async () => {
  const h = harness()
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  const first = await h.scheduler.tick()
  const second = await h.scheduler.tick()
  assert.equal(first.action, 'call')
  assert.equal(second.action, 'none')
  assert.equal(second.reason, 'cooldown')
  assert.equal(h.delivered.length, 1)
})

test('a second tick while a line is still being delivered does nothing', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const h = harness({
    deps: {
      complete: async () => {
        await gate
        return '【soft】\nJP: ねぇ\nCN: 喂'
      },
    },
  })
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  const inFlight = h.scheduler.tick()
  const concurrent = await h.scheduler.tick()
  assert.equal(concurrent.action, 'none')
  assert.equal(concurrent.reason, 'in-flight')
  release()
  await inFlight
  assert.equal(h.delivered.length, 1)
})

test('idle fires on its own when no call is due', async () => {
  const h = harness()
  h.config.value.proactive.callEnabled = false
  await h.scheduler.tick()
  h.advance(HOUR + 1000)
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'idle')
  assert.equal(h.delivered[0].kind, 'idle')
})

test('nothing happens without an audience, while busy, or with voice off', async () => {
  const noClient = harness({ deps: { hasAudience: () => false } })
  await noClient.scheduler.tick()
  noClient.advance(20 * HOUR)
  assert.equal((await noClient.scheduler.tick()).reason, 'no-client')
  assert.equal(noClient.delivered.length, 0)

  const busy = harness({ deps: { isBusy: () => true } })
  await busy.scheduler.tick()
  assert.equal((await busy.scheduler.tick()).reason, 'busy')

  const muted = harness()
  muted.config.value.voice.enabled = false
  assert.equal((await muted.scheduler.tick()).reason, 'voice-disabled')
  assert.equal(muted.delivered.length, 0)
})

test('a failed model call falls back to a canned line instead of going silent', async () => {
  const h = harness({
    deps: {
      complete: async () => {
        throw new Error('codex exec failed')
      },
    },
  })
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'call')
  assert.equal(h.delivered.length, 1)
  assert.ok(
    CALL_CANNED.some((c) => c.jp === h.delivered[0].jp),
    'delivered line should come from the canned list',
  )
  assert.equal(h.reports[0].level, 'warn')
})

test('an empty or unusable model reply also falls back', async () => {
  const h = harness({ deps: { complete: async () => '   ' } })
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  await h.scheduler.tick()
  assert.equal(h.delivered.length, 1)
  assert.ok(h.delivered[0].jp.length > 0)
})

test('a real persona reply is used verbatim, with tags stripped', async () => {
  const h = harness({
    deps: {
      // no parse override: exercise the real parser + mapping used in production
      parse: undefined,
      complete: async () => '【soft】\nJP: 【soft】ふぅん、生きてたのね。\nCN: 哼，你还活着啊。',
    },
  })
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  await h.scheduler.tick()

  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].jp, 'ふぅん、生きてたのね。')
  assert.equal(h.delivered[0].cn, '哼，你还活着啊。')
  assert.equal(h.delivered[0].emotion, 'soft')
  assert.ok(
    !CALL_CANNED.some((c) => c.jp === h.delivered[0].jp),
    'the generated line must win over the canned fallback',
  )
  assert.ok(!h.delivered[0].jp.includes('【'), 'emotion tags must not reach speech')
})

test('config changes are picked up on the next tick', async () => {
  const h = harness()
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  h.config.value.proactive.callEnabled = false
  h.config.value.proactive.idleEnabled = false
  assert.equal((await h.scheduler.tick()).reason, 'not-due')
  assert.equal(h.delivered.length, 0)

  h.config.value.proactive.idleEnabled = true
  assert.equal((await h.scheduler.tick()).action, 'idle')
})

test('a throwing tick is contained and reported', async () => {
  const h = harness()
  h.config.get = () => {
    throw new Error('config exploded')
  }
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'error')
  assert.equal(h.reports[0].level, 'error')
})

test('a throwing delivery is contained and reported', async () => {
  const h = harness({
    deps: {
      deliver: () => {
        throw new Error('hub exploded')
      },
    },
  })
  await h.scheduler.tick()
  h.advance(20 * HOUR)
  const decision = await h.scheduler.tick()
  assert.equal(decision.action, 'call')
  assert.ok(h.reports.some((r) => r.msg.includes('delivery failed')))
})

test('noteInteraction restarts the idle clock', async () => {
  const h = harness()
  h.config.value.proactive.callEnabled = false
  await h.scheduler.tick()
  h.advance(HOUR - 1000)
  h.scheduler.noteInteraction()
  h.advance(2000)
  assert.equal((await h.scheduler.tick()).reason, 'not-due')
  h.advance(HOUR)
  assert.equal((await h.scheduler.tick()).action, 'idle')
})

test('the minimum gap is respected between two different proactive lines', async () => {
  const h = harness()
  // a short call interval makes a second call "due" long before the gap allows it
  h.config.value.proactive.callEnabled = true
  h.config.value.proactive.callIntervalMs = 60 * 1000
  await h.scheduler.tick()
  h.advance(2 * 60 * 1000)
  assert.equal((await h.scheduler.tick()).action, 'call')
  h.advance(2 * 60 * 1000)
  const tooSoon = await h.scheduler.tick()
  assert.equal(tooSoon.reason, 'cooldown')
  h.advance(PROACTIVE_MIN_GAP_MS)
  assert.equal((await h.scheduler.tick()).action, 'call')
})
