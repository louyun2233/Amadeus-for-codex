/**
 * HTTP + server-sent-events transport for the panel.
 *
 * Owns three things the old single-file panel got wrong:
 *  1. lifecycle: EventSource reconnects are detected and replayed utterances
 *     are de-duplicated, so a dropped connection does not replay speech
 *  2. error reporting: this is the only place that talks to /amadeus/report,
 *     so anything that fails is visible in the daemon's diagnostics
 *  3. a single `api()` used by every caller, so error shapes stay uniform
 */

const SEEN_LIMIT = 300
const CLIENT_KEY = 'amadeus.clientId'

/**
 * A stable id for this browser tab.
 *
 * sessionStorage is deliberately per-tab: two tabs are two clients, and audio
 * ownership can move between them. A reload of the same tab keeps its id, so it
 * keeps whatever it owned.
 */
function clientId() {
  const existing = sessionStorage.getItem(CLIENT_KEY)
  if (existing && /^[A-Za-z0-9_-]{4,64}$/.test(existing)) return existing
  const random =
    typeof crypto !== 'undefined' && crypto.getRandomValues
      ? [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
      : Math.random().toString(36).slice(2, 12)
  const id = `tab-${random}`
  try {
    sessionStorage.setItem(CLIENT_KEY, id)
  } catch {
    /* private mode: the id is then per-load, which is still correct */
  }
  return id
}

export function createTransport() {
  const handlers = new Map()
  const seenIds = new Set()
  const seenOrder = []
  let source = null
  let connected = false
  let failures = 0

  async function api(path, options = {}) {
    // A Blob body goes out as-is (the audio upload sets its own Content-Type);
    // everything else is JSON.
    const blob = typeof Blob !== 'undefined' && options.body instanceof Blob
    const headers = { 'X-Amadeus-Client': clientId(), ...(options.headers || {}) }
    if (!blob) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(path, {
        method: options.method || 'GET',
        cache: 'no-store',
        headers,
        body:
          options.body === undefined ? undefined : blob ? options.body : JSON.stringify(options.body),
      })
    } catch (e) {
      const err = new Error(`网络不可达：${e.message}`)
      err.network = true
      throw err
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.reason)) || `http ${res.status}`)
      err.status = res.status
      err.degrade = (data && data.degrade) || null
      err.code = (data && data.code) || null
      throw err
    }
    return data
  }

  function report(level, message, detail = '', where = '') {
    api('/amadeus/report', {
      method: 'POST',
      body: {
        level,
        message: String(message ?? '').slice(0, 300),
        detail: String(detail ?? '').slice(0, 1000),
        where: String(where ?? '').slice(0, 120),
      },
    }).catch(() => {
      /* reporting must never throw into the caller */
    })
  }

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
    return () => {
      const list = handlers.get(event) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }

  function emit(event, payload) {
    for (const fn of handlers.get(event) || []) {
      try {
        fn(payload)
      } catch (e) {
        report('error', `handler failed: ${event}`, e && e.message, 'transport')
      }
    }
  }

  function alreadySeen(id) {
    return id !== undefined && id !== null && seenIds.has(id)
  }

  function markSeen(id) {
    if (id === undefined || id === null || seenIds.has(id)) return
    seenIds.add(id)
    seenOrder.push(id)
    while (seenOrder.length > SEEN_LIMIT) seenIds.delete(seenOrder.shift())
  }

  const EVENTS = [
    'hello',
    'pending',
    'audio-owner',
    'utterance',
    'chunk',
    'turn:status',
    'turn:done',
    'turn:error',
    'session:append',
    'degraded',
    'config',
    'memory',
    'assets:progress',
    'cleared',
    'shutdown',
  ]

  function connect() {
    if (source) return
    // EventSource cannot set headers, so the id travels as a query parameter.
    source = new EventSource(`/amadeus/events?client=${encodeURIComponent(clientId())}`)

    source.onopen = () => {
      const wasDown = failures > 0
      connected = true
      failures = 0
      emit('open', { resumed: wasDown })
    }
    source.onerror = () => {
      connected = false
      failures += 1
      emit('offline', { failures })
    }

    for (const name of EVENTS) {
      source.addEventListener(name, (ev) => {
        let data
        try {
          data = JSON.parse(ev.data)
        } catch {
          return
        }
        if (name === 'utterance') {
          if (data && alreadySeen(data.id)) return
          if (data) markSeen(data.id)
        }
        if (name === 'hello' && data && Array.isArray(data.pending)) {
          // the server replays everything still un-acked; drop what this tab
          // has already handled so a reconnect does not double-speak
          data = {
            ...data,
            pending: data.pending.filter((u) => {
              if (!u || u.id === undefined) return true
              if (alreadySeen(u.id)) return false
              markSeen(u.id)
              return true
            }),
          }
        }
        emit(name, data)
      })
    }
  }

  return {
    api,
    report,
    on,
    connect,
    clientId,
    isConnected: () => connected,
    failures: () => failures,
    close() {
      try {
        source?.close()
      } catch {
        /* ignore */
      }
      source = null
    },
  }
}
