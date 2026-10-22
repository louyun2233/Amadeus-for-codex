import { EventEmitter } from 'node:events'

const ACK_TIMEOUT_MS = 20000
const MAX_ATTEMPTS = 3

/**
 * How long a "task finished" line stays worth saying.
 *
 * Announcements are news, not history: if the panel was closed when the task
 * ended, replaying it on the next connection would report a completion at a
 * moment that has nothing to do with the task - reported as "she says it too
 * early". The window is generous so a notice that merely waited behind a long
 * spoken reply is still delivered.
 */
export const ANNOUNCEMENT_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Server->panel event stream over SSE, plus an utterance queue with explicit
 * acknowledgement.
 *
 * The DSH implementation deleted queue items as soon as any client polled, so
 * a browser that blocked audio (or a second window) silently lost speech. Here
 * an item stays pending until a client acknowledges playback, and is retried a
 * bounded number of times before being dropped with a recorded reason.
 */
export class EventHub extends EventEmitter {
  constructor() {
    super()
    this.clients = new Map()
    this.clientSeq = 0
    /**
     * Exactly one connected panel owns audio at a time.
     *
     * Without this, every connected tab plays the same utterance: broadcast
     * speech means double audio, and a newly opened tab replays whatever is
     * still queued. Speech is therefore addressed to the owner, everything
     * informational is still broadcast.
     */
    this.audioOwner = null
    this.utterances = []
    this.utteranceSeq = 0
    this.dropped = []
    this.timer = setInterval(() => this.sweep(), 5000)
    this.timer.unref?.()
  }

  addClient(res, clientId = null) {
    // A tab that reconnects keeps its id, so it also keeps (or re-claims) audio.
    // Replacing the entry is safe: the previous response for that id is stale.
    const id = clientId || `client-${++this.clientSeq}`
    // Never replay a stale announcement to a panel that just opened.
    this.#pruneStaleAnnouncements()
    const previous = this.clients.get(id)
    const client = { id, res, connectedAt: Date.now() }
    this.clients.set(id, client)
    if (previous && previous.res !== res) previous.res.end?.()
    if (this.audioOwner === null) this.audioOwner = id
    const owns = this.audioOwner === id
    const pending = owns ? this.utterances.map((u) => u.payload) : []
    if (this.#send(res, 'hello', {
      clientId: id,
      audioOwner: this.audioOwner,
      ownsAudio: owns,
      // only the owner receives the queue: replaying it anywhere else means the
      // same line is spoken twice
      pending,
      serverTime: Date.now(),
    })) {
      if (owns) for (const item of this.utterances) this.#markDelivered(item)
    }
    return () => {
      // A stale EventSource close must not remove its replacement connection.
      if (this.clients.get(id) === client) {
        this.clients.delete(id)
        this.#reassignAudio()
      }
    }
  }

  #send(res, event, data) {
    try {
      if (res.writableEnded || res.destroyed) return false
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
      return true
    } catch {
      /* client went away; the close handler removes it */
      return false
    }
  }

  broadcast(event, data) {
    for (const client of this.clients.values()) this.#send(client.res, event, data)
  }

  /** Send an event to one client only (things it owns, like its own turn). */
  sendTo(clientId, event, data) {
    const client = this.clients.get(clientId)
    if (!client) return false
    return this.#send(client.res, event, data)
  }

  /**
   * Hand audio to a client, e.g. when a tab is focused. Pending lines are
   * handed over with it, so speech follows the user's attention instead of
   * staying with whichever tab happened to open first.
   */
  claimAudio(clientId) {
    if (!this.clients.has(clientId)) return { ok: false, reason: 'unknown-client' }
    if (this.audioOwner === clientId) return { ok: true, owner: clientId, changed: false }
    this.audioOwner = clientId
    this.broadcast('audio-owner', { owner: clientId })
    const client = this.clients.get(clientId)
    this.#sendPending(client.res)
    return { ok: true, owner: clientId, changed: true }
  }

  /** Called when a client disconnects; audio moves to the newest survivor. */
  #reassignAudio() {
    if (this.audioOwner !== null && this.clients.has(this.audioOwner)) return
    const remaining = [...this.clients.values()].sort((a, b) => b.connectedAt - a.connectedAt)
    this.audioOwner = remaining.length > 0 ? remaining[0].id : null
    if (this.audioOwner === null) return
    this.broadcast('audio-owner', { owner: this.audioOwner })
    const client = this.clients.get(this.audioOwner)
    this.#sendPending(client.res)
  }

  #sendPending(res) {
    if (this.#send(res, 'pending', { pending: this.utterances.map((u) => u.payload) })) {
      for (const item of this.utterances) this.#markDelivered(item)
    }
  }

  #markDelivered(item, retry = false) {
    if (item.attempts === 0 || retry) item.attempts += 1
    item.lastSentAt = Date.now()
  }

  /** Queue a line of speech and deliver it to every connected panel. */
  enqueueUtterance({ text, cn = '', emotion = 'neutral', expr = '', kind = 'say', force = true }) {
    const clean = String(text ?? '').trim()
    if (clean.length === 0) return null
    const item = {
      id: ++this.utteranceSeq,
      payload: { id: this.utteranceSeq, kind, text: clean, cn, emotion, expr, force, ts: Date.now() },
      attempts: 0,
      lastSentAt: null,
    }
    this.utterances.push(item)
    if (this.utterances.length > 60) this.#drop(this.utterances.shift(), 'queue overflow')
    this.#deliverUtterance(item)
    return item.payload
  }

  /** Speech goes to the audio owner only. No owner means it stays queued. */
  #deliverUtterance(item, retry = false) {
    if (this.audioOwner === null) return
    if (!this.sendTo(this.audioOwner, 'utterance', item.payload)) {
      // A failed response may still be in the client map until its close event.
      // Remove it now so re-election can hand the pending queue to a live tab.
      this.clients.delete(this.audioOwner)
      this.audioOwner = null
      this.#reassignAudio()
      return
    }
    this.#markDelivered(item, retry)
  }

  ack(id, status = 'ok', detail = '') {
    const idx = this.utterances.findIndex((u) => u.id === Number(id))
    if (idx < 0) return { ok: true, already: true }
    const item = this.utterances[idx]
    /**
     * `accepted` means "the panel has it and will play it".
     *
     * A multi-sentence reply is queued as several utterances and only the one
     * being spoken can be acknowledged as finished. The others used to sit
     * unacknowledged, get re-sent at the 20s sweep, be de-duplicated by the
     * panel (so they were never played *and* never acknowledged) and finally be
     * dropped as "no acknowledgement from panel" - the last sentence of a long
     * reply simply vanished. Receipt is now enough to stop the retries; the
     * panel still reports playback failures through /amadeus/report.
     */
    if (status === 'ok' || status === 'accepted') {
      this.utterances.splice(idx, 1)
      return { ok: true, remaining: this.utterances.length }
    }
    item.lastError = String(detail).slice(0, 200)
    if (item.attempts >= MAX_ATTEMPTS) {
      this.utterances.splice(idx, 1)
      this.#drop(item, `playback failed: ${item.lastError}`)
      return { ok: true, dropped: true }
    }
    this.#deliverUtterance(item, true)
    return { ok: true, retry: item.attempts }
  }

  sweep(now = Date.now()) {
    this.#pruneStaleAnnouncements(now)
    for (const item of [...this.utterances]) {
      // An offline queue has not been delivered and has no ACK deadline.
      if (item.lastSentAt === null) continue
      if (this.audioOwner === null) continue
      if (now - item.lastSentAt < ACK_TIMEOUT_MS) continue
      if (item.attempts >= MAX_ATTEMPTS) {
        const idx = this.utterances.indexOf(item)
        if (idx >= 0) this.utterances.splice(idx, 1)
        this.#drop(item, 'no acknowledgement from panel')
        continue
      }
      this.#deliverUtterance(item, true)
    }
  }

  /**
   * Announcements expire; conversation and calls do not.
   *
   * `kind: 'broadcast'` is the "task finished / task started" notice - news
   * that is worthless once it is old. A reply the user asked for stays queued
   * however long it takes to speak it.
   */
  #pruneStaleAnnouncements(now = Date.now()) {
    if (this.utterances.length === 0) return
    const keep = []
    for (const item of this.utterances) {
      const isAnnouncement = item.payload?.kind === 'broadcast'
      const age = now - (Number(item.payload?.ts) || now)
      if (isAnnouncement && age > ANNOUNCEMENT_MAX_AGE_MS) {
        this.#drop(item, `stale announcement (${Math.round(age / 1000)}s old)`)
        continue
      }
      keep.push(item)
    }
    this.utterances = keep
  }

  #drop(item, reason) {
    if (!item) return
    this.dropped.push({ id: item.id, reason, ts: Date.now() })
    if (this.dropped.length > 50) this.dropped.shift()
    this.broadcast('degraded', { kind: 'utterance-dropped', id: item.id, reason })
  }

  status() {
    return {
      clients: this.clients.size,
      audioOwner: this.audioOwner,
      pendingUtterances: this.utterances.length,
      dropped: this.dropped.slice(-10),
    }
  }

  clear() {
    const count = this.utterances.length
    this.utterances = []
    this.broadcast('cleared', { count })
    return { cleared: count }
  }
}
