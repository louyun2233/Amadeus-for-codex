import test from 'node:test'
import assert from 'node:assert/strict'
import { EventHub, ANNOUNCEMENT_MAX_AGE_MS } from '../src/host/events.mjs'

/**
 * A multi-sentence reply is queued as several utterances, but only the one
 * being spoken can be acknowledged as *finished*. The rest used to sit
 * unacknowledged, be re-sent at the 20 second sweep, be dropped by the panel's
 * own de-duplication (so never played, never acknowledged) and finally be
 * dropped as "no acknowledgement from panel" - the last sentence of a long
 * reply simply vanished.
 */

function client() {
  const seen = []
  return {
    res: {
      write: (chunk) => {
        seen.push(String(chunk))
        return true
      },
      end: () => {},
    },
    seen,
  }
}

test('receipt is enough to settle a queued line', () => {
  const hub = new EventHub()
  hub.addClient(client().res, 'tab-a')
  const item = hub.enqueueUtterance({ text: 'ひとつめ', kind: 'say' })
  assert.equal(hub.status().pendingUtterances, 1)

  const result = hub.ack(item.id, 'accepted')
  assert.equal(result.ok, true)
  assert.equal(hub.status().pendingUtterances, 0, 'it must not wait for playback to end')
  assert.equal(hub.status().dropped.length, 0)

  // a repeat of the same ack is harmless
  assert.equal(hub.ack(item.id, 'accepted').already, true)
})

test('a failed playback still retries instead of settling', () => {
  const hub = new EventHub()
  hub.addClient(client().res, 'tab-a')
  const item = hub.enqueueUtterance({ text: 'ひとつめ', kind: 'say' })
  const result = hub.ack(item.id, 'failed', 'decode error')
  assert.equal(result.retry, 2)
  assert.equal(hub.status().pendingUtterances, 1, 'a failure keeps it queued for a retry')
})

test('later sentences are not re-sent while the first one is still playing', () => {
  const hub = new EventHub()
  const tab = client()
  hub.addClient(tab.res, 'tab-a')
  const first = hub.enqueueUtterance({ text: 'ひとつめ', kind: 'say' })
  const second = hub.enqueueUtterance({ text: 'ふたつめ', kind: 'say' })
  hub.ack(first.id, 'accepted')
  hub.ack(second.id, 'accepted')
  assert.equal(hub.status().pendingUtterances, 0)

  const delivered = tab.seen.join('')
  assert.equal(delivered.split('ふたつめ').length - 1, 1, 'the second line is delivered exactly once')
})

/**
 * "目标达成" also appeared at moments that had nothing to do with the task: if
 * the panel was closed when the task ended, the notice waited in the queue and
 * was replayed the next time a panel connected. Announcements are news; they
 * expire. A reply the user asked for does not.
 */
test('a stale announcement is dropped instead of replayed later', () => {
  const hub = new EventHub()
  const announcement = hub.enqueueUtterance({ text: '目標、達成。', kind: 'broadcast' })
  const reply = hub.enqueueUtterance({ text: 'おかえり。', kind: 'say' })
  assert.equal(hub.status().pendingUtterances, 2)

  // travel forward in time past the announcement window
  for (const item of hub.utterances) {
    if (item.payload.kind === 'broadcast') item.payload.ts -= ANNOUNCEMENT_MAX_AGE_MS + 1000
  }
  const tab = client()
  hub.addClient(tab.res, 'tab-late')

  assert.equal(hub.status().pendingUtterances, 1, 'only the reply is left to play')
  assert.deepEqual(
    hub.status().dropped.map((entry) => entry.id),
    [announcement.id],
  )
  assert.ok(hub.status().dropped[0].reason.includes('stale announcement'))
  assert.ok(!tab.seen.join('').includes('目標、達成'), 'it is never handed to the new panel')
  assert.ok(tab.seen.join('').includes('おかえり'), 'the reply still is')
  assert.equal(reply.id !== announcement.id, true)
})
