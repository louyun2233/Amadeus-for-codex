import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { synthesize } from '../src/core/edge-tts.mjs'
import {
  adjustClockSkew,
  getClockSkew,
  MAX_SKEW_SECONDS,
  parseHttpDate,
  resetClockSkew,
  secMsGecV2,
  skewSecondsFromDate,
  skewedNowMs,
} from '../src/core/edge-tts-drm.mjs'

/**
 * A wrong system clock used to look exactly like "the voice service is down":
 * the handshake is answered with 403 and nothing in the message says why. These
 * tests pin the recovery path - read the server's own Date, correct the offset
 * once, retry - and the guards that keep a nonsense header from moving us.
 */

const FIVE_MINUTES = 300
const fixedNow = 1_792_070_000_000

function withCleanSkew(fn) {
  resetClockSkew()
  try {
    return fn()
  } finally {
    resetClockSkew()
  }
}

test('a date header turns into a usable skew', () => {
  const serverAhead = new Date(fixedNow + FIVE_MINUTES * 1000).toUTCString()
  assert.equal(parseHttpDate(serverAhead), Math.floor((fixedNow + 300_000) / 1000))
  assert.equal(Math.round(skewSecondsFromDate(serverAhead, fixedNow)), FIVE_MINUTES)
  assert.equal(Math.round(skewSecondsFromDate(new Date(fixedNow).toUTCString(), fixedNow)), 0)
})

test('unusable or absurd dates are refused rather than trusted', () => {
  assert.equal(parseHttpDate('not a date'), null)
  assert.equal(parseHttpDate(''), null)
  assert.equal(skewSecondsFromDate(undefined, fixedNow), null)
  assert.equal(skewSecondsFromDate('Sun, 01 Jan 3000 00:00:00 GMT', fixedNow), null)
  assert.equal(skewSecondsFromDate('Sun, 01 Jan 1970 00:00:00 GMT', fixedNow), null)
})

test('the stored skew is clamped and applies to later tokens', () => {
  withCleanSkew(() => {
    adjustClockSkew(FIVE_MINUTES)
    assert.equal(getClockSkew(), FIVE_MINUTES)
    assert.equal(skewedNowMs(fixedNow), fixedNow + FIVE_MINUTES * 1000)
    // the token must be the one we would have produced with a correct clock
    assert.equal(secMsGecV2(skewedNowMs(fixedNow)), secMsGecV2(fixedNow + FIVE_MINUTES * 1000))
    assert.notEqual(secMsGecV2(skewedNowMs(fixedNow)), secMsGecV2(fixedNow))

    adjustClockSkew(MAX_SKEW_SECONDS * 10)
    assert.equal(getClockSkew(), MAX_SKEW_SECONDS)
    adjustClockSkew(-MAX_SKEW_SECONDS * 10)
    assert.equal(getClockSkew(), -MAX_SKEW_SECONDS)
    resetClockSkew()
    assert.equal(getClockSkew(), 0)
  })
})

/** Minimal stand-in for WsClient: fails once with 403, then speaks. */
function fakeWs({ script }) {
  let call = 0
  const urls = []
  const factory = (url) => {
    urls.push(url)
    const step = script[Math.min(call, script.length - 1)]
    call += 1
    const ws = new EventEmitter()
    ws.sent = []
    ws.send = (data) => ws.sent.push(data)
    ws.close = () => {}
    ws.connect = () => {
      queueMicrotask(() => {
        if (step.kind === 'reject') {
          const err = Object.assign(new Error(`websocket upgrade rejected: HTTP/1.1 ${step.status}`), {
            status: step.status,
            headers: step.headers,
          })
          ws.emit('error', err)
          ws.emit('close', { code: 1006, reason: 'handshake failed' })
          return
        }
        ws.emit('open')
        const header = Buffer.from('Path:audio\r\n', 'utf8')
        const frame = Buffer.concat([
          Buffer.from([header.length >> 8, header.length & 0xff]),
          header,
          Buffer.from([1, 2, 3, 4]),
        ])
        ws.emit('message', frame, true)
        ws.emit('message', Buffer.from('Path:turn.end\r\n', 'utf8'), false)
      })
    }
    return ws
  }
  return { factory, urls }
}

test('a 403 with a server date corrects the clock once and retries', async () => {
  await withCleanSkew(async () => {
    const date = new Date(Date.now() + FIVE_MINUTES * 1000).toUTCString()
    const { factory, urls } = fakeWs({
      script: [
        { kind: 'reject', status: 403, headers: { date } },
        { kind: 'ok' },
      ],
    })

    const out = await synthesize({ text: '测试', wsFactory: factory, timeoutMs: 5000 })
    assert.equal(out.audio.length, 4)
    assert.equal(urls.length, 2, 'exactly one retry')
    assert.notEqual(urls[0], urls[1], 'the retry must carry a fresh token')
    assert.ok(Math.abs(getClockSkew() - FIVE_MINUTES) < 5, `skew was ${getClockSkew()}`)
  })
})

test('a 403 without a usable date is reported, not retried', async () => {
  await withCleanSkew(async () => {
    const { factory, urls } = fakeWs({ script: [{ kind: 'reject', status: 403, headers: {} }] })
    await assert.rejects(
      () => synthesize({ text: '测试', wsFactory: factory, timeoutMs: 5000 }),
      /403/,
    )
    assert.equal(urls.length, 1)
    assert.equal(getClockSkew(), 0)
  })
})

test('other handshake failures are not retried either', async () => {
  await withCleanSkew(async () => {
    const date = new Date(Date.now() + FIVE_MINUTES * 1000).toUTCString()
    const { factory, urls } = fakeWs({
      script: [{ kind: 'reject', status: 401, headers: { date } }],
    })
    await assert.rejects(
      () => synthesize({ text: '测试', wsFactory: factory, timeoutMs: 5000 }),
      /401/,
    )
    assert.equal(urls.length, 1, 'only a 403 is treated as a clock problem')
  })
})

test('the skew survives into the next call', async () => {
  await withCleanSkew(async () => {
    const date = new Date(Date.now() + 90 * 1000).toUTCString()
    const first = fakeWs({
      script: [
        { kind: 'reject', status: 403, headers: { date } },
        { kind: 'ok' },
      ],
    })
    await synthesize({ text: '测试', wsFactory: first.factory, timeoutMs: 5000 })
    const corrected = getClockSkew()

    const second = fakeWs({ script: [{ kind: 'ok' }] })
    const out = await synthesize({ text: '测试', wsFactory: second.factory, timeoutMs: 5000 })
    assert.equal(out.audio.length, 4)
    assert.equal(second.urls.length, 1, 'a corrected clock should not need a retry')
    assert.equal(getClockSkew(), corrected)
  })
})
