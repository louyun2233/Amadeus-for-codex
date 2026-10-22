import test from 'node:test'
import assert from 'node:assert/strict'
import { EventHub } from '../src/host/events.mjs'

/**
 * Audio ownership.
 *
 * Before this existed, every connected tab received every utterance, so two
 * open panels spoke over each other and a newly opened tab replayed whatever
 * was queued. These tests pin the routing rules.
 */

function fakeClient() {
  const chunks = []
  return {
    res: {
      write: (s) => {
        chunks.push(String(s))
        return true
      },
      end: () => {},
    },
    events() {
      const out = []
      for (const block of chunks.join('').split('\n\n')) {
        const lines = block.split('\n').filter(Boolean)
        const evLine = lines.find((l) => l.startsWith('event: '))
        const dataLine = lines.find((l) => l.startsWith('data: '))
        if (!evLine || !dataLine) continue
        try {
          out.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
        } catch {
          /* keep-alive comments and partial writes are ignored */
        }
      }
      return out
    },
    of(event) {
      return this.events().filter((e) => e.event === event)
    },
  }
}

function setup() {
  const hub = new EventHub()
  const a = fakeClient()
  const b = fakeClient()
  const releaseA = hub.addClient(a.res, 'tab-a')
  const releaseB = hub.addClient(b.res, 'tab-b')
  return { hub, a, b, releaseA, releaseB }
}

test('the first client becomes the audio owner and gets the queue', () => {
  const hub = new EventHub()
  const a = fakeClient()
  hub.addClient(a.res, 'tab-a')
  const hello = a.of('hello')[0]
  assert.ok(hello, 'hello must be sent')
  assert.equal(hello.data.clientId, 'tab-a')
  assert.equal(hello.data.ownsAudio, true)
  assert.deepEqual(hello.data.pending, [])
})

test('a second client is not the owner and receives no pending queue', () => {
  const { a, b } = setup()
  assert.equal(a.of('hello')[0].data.ownsAudio, true)
  const helloB = b.of('hello')[0]
  assert.equal(helloB.data.ownsAudio, false)
  assert.deepEqual(helloB.data.pending, [])
})

test('utterances go to the owner only', () => {
  const { hub, a, b } = setup()
  hub.enqueueUtterance({ text: 'おはよう', emotion: 'happy' })
  assert.equal(a.of('utterance').length, 1)
  assert.equal(b.of('utterance').length, 0, 'the non-owner must stay silent')
})

test('claiming audio moves the queue to the newly focused tab', () => {
  const { hub, a, b } = setup()
  hub.enqueueUtterance({ text: 'テスト', emotion: 'neutral' })
  assert.equal(b.of('utterance').length, 0)

  const result = hub.claimAudio('tab-b')
  assert.equal(result.changed, true)

  // the old owner is told it lost audio, the new one is told it won and gets the queue
  assert.equal(a.of('audio-owner').length, 1)
  assert.equal(a.of('audio-owner')[0].data.owner, 'tab-b')
  assert.equal(b.of('audio-owner').length, 1)
  assert.equal(b.of('pending').length, 1)
  assert.equal(b.of('pending')[0].data.pending.length, 1)
  assert.equal(b.of('pending')[0].data.pending[0].text, 'テスト')
})

test('claiming from the current owner is a no-op', () => {
  const { hub, a } = setup()
  const result = hub.claimAudio('tab-a')
  assert.equal(result.changed, false)
  assert.equal(a.of('audio-owner').length, 0)
})

test('claiming from an unknown client is refused', () => {
  const { hub } = setup()
  const result = hub.claimAudio('tab-zzz')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-client')
})

test('when the owner disconnects, audio moves to the survivor with the queue', () => {
  const { hub, b, releaseA } = setup()
  hub.enqueueUtterance({ text: 'ねぇ', emotion: 'soft' })
  releaseA() // the owner closes its tab

  assert.equal(hub.status().audioOwner, 'tab-b')
  assert.equal(b.of('audio-owner').length, 1)
  const pending = b.of('pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].data.pending[0].text, 'ねぇ')
})

test('with nobody connected the queue is kept, not dropped', () => {
  const hub = new EventHub()
  hub.enqueueUtterance({ text: 'まだ誰もいない', emotion: 'neutral' })
  assert.equal(hub.status().audioOwner, null)
  assert.equal(hub.status().pendingUtterances, 1)

  const late = fakeClient()
  hub.addClient(late.res, 'tab-late')
  const hello = late.of('hello')[0]
  assert.equal(hello.data.pending.length, 1)
  assert.equal(hello.data.pending[0].text, 'まだ誰もいない')
})

test('acknowledging removes the item so it is not replayed', () => {
  const { hub, a } = setup()
  const item = hub.enqueueUtterance({ text: 'はい', emotion: 'neutral' })
  assert.equal(hub.status().pendingUtterances, 1)
  hub.ack(item.id, 'ok')
  assert.equal(hub.status().pendingUtterances, 0)

  // a tab that joins later sees an empty queue
  const late = fakeClient()
  hub.addClient(late.res, 'tab-late')
  assert.deepEqual(late.of('hello')[0].data.pending, [])
  void a
})

test('a failing ack keeps the item and retries it to the owner', () => {
  const { hub, a } = setup()
  const item = hub.enqueueUtterance({ text: 'もう一度', emotion: 'neutral' })
  const before = a.of('utterance').length
  hub.ack(item.id, 'failed', 'autoplay blocked')
  assert.equal(a.of('utterance').length, before + 1, 'the owner should get a retry')
  assert.equal(hub.status().pendingUtterances, 1)
})

test('reconnecting with the same client id keeps ownership', () => {
  const hub = new EventHub()
  const first = fakeClient()
  const release = hub.addClient(first.res, 'tab-a')
  release()
  const again = fakeClient()
  hub.addClient(again.res, 'tab-a')
  assert.equal(hub.status().audioOwner, 'tab-a')
  assert.equal(again.of('hello')[0].data.ownsAudio, true)
})

test('a stale connection close cannot remove its replacement', () => {
  const hub = new EventHub()
  const first = fakeClient()
  const releaseFirst = hub.addClient(first.res, 'tab-a')
  const replacement = fakeClient()
  hub.addClient(replacement.res, 'tab-a')
  releaseFirst()

  assert.equal(hub.status().clients, 1)
  assert.equal(hub.status().audioOwner, 'tab-a')
  hub.enqueueUtterance({ text: '届く' })
  assert.equal(replacement.of('utterance').length, 1)
})

test('an undelivered line waits offline without using retry attempts', () => {
  const hub = new EventHub()
  const item = hub.enqueueUtterance({ text: 'あとで' })
  hub.sweep(Date.now() + 10 * 60 * 1000)
  assert.equal(hub.status().pendingUtterances, 1)
  assert.equal(hub.utterances[0].attempts, 0)

  const late = fakeClient()
  hub.addClient(late.res, 'tab-late')
  assert.equal(late.of('hello')[0].data.pending[0].id, item.id)
  assert.equal(hub.utterances[0].attempts, 1)
})

test('an interrupted delivery pauses its acknowledgement deadline offline', () => {
  const hub = new EventHub()
  const first = fakeClient()
  const release = hub.addClient(first.res, 'tab-a')
  const item = hub.enqueueUtterance({ text: 'またね' })
  release()
  hub.sweep(Date.now() + 10 * 60 * 1000)
  assert.equal(hub.status().pendingUtterances, 1)
  assert.equal(hub.utterances[0].attempts, 1)

  const late = fakeClient()
  hub.addClient(late.res, 'tab-b')
  assert.equal(late.of('hello')[0].data.pending[0].id, item.id)
  assert.equal(hub.utterances[0].attempts, 1)
})

test('a failed audio owner is removed and its queue moves to another tab', () => {
  const { hub, a, b } = setup()
  a.res.destroyed = true
  const item = hub.enqueueUtterance({ text: '交代して' })
  assert.equal(hub.status().audioOwner, 'tab-b')
  assert.equal(a.of('utterance').length, 0)
  assert.equal(b.of('pending')[0].data.pending[0].id, item.id)
  assert.equal(hub.utterances[0].attempts, 1)
})

test('sendTo reaches exactly one client', () => {
  const { hub, a, b } = setup()
  hub.sendTo('tab-b', 'chunk', { turnId: 't1', delta: 'x' })
  assert.equal(b.of('chunk').length, 1)
  assert.equal(a.of('chunk').length, 0)
  assert.equal(hub.sendTo('tab-zzz', 'chunk', {}), false)
})
