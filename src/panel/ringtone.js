/**
 * The incoming-call ring.
 *
 * A call used to announce itself with nothing but her spoken line, so a muted
 * or slow synthesis made the call completely silent. The ring is a separate
 * channel on its own element:
 *
 *  - it never enters the speech queue and never delays a line
 *  - it stops the moment the call is answered or declined
 *  - it gives up by itself after `maxDurationMs`, so a forgotten overlay cannot
 *    ring forever
 *  - a rejected autoplay (no user gesture yet) retries on the first click
 *    instead of failing silently
 *
 * The element, timers and clock are injected so the behaviour can be tested
 * without a browser.
 */

export const RING_MAX_MS = 20000
export const RING_VOLUME_FALLBACK = 0.6

function isAutoplayBlock(error) {
  return error?.name === 'NotAllowedError' || /NotAllowedError|autoplay|user.*interact/i.test(String(error?.message || ''))
}

export function createRingtone({
  element,
  now = () => Date.now(),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (id) => clearTimeout(id),
  maxDurationMs = RING_MAX_MS,
  onStatus = () => {},
  armGestureRetry = null,
} = {}) {
  let activeUrl = null
  let deadline = 0
  let timer = null
  let waitingForGesture = false
  let attempt = 0

  function releaseTimer() {
    if (timer !== null) {
      try {
        clearTimeoutImpl(timer)
      } catch {
        /* ignore */
      }
      timer = null
    }
  }

  function stop(reason = 'stopped') {
    if (!activeUrl && !waitingForGesture) return 'idle'
    activeUrl = null
    deadline = 0
    waitingForGesture = false
    attempt += 1
    releaseTimer()
    try {
      if (element) {
        element.onerror = null
        element.pause?.()
        element.currentTime = 0
      }
    } catch {
      /* an element that refuses to rewind is still stopped */
    }
    onStatus('stopped', reason)
    return 'stopped'
  }

  function expire() {
    if (!activeUrl) return
    const left = deadline - now()
    if (left > 0) {
      timer = setTimeoutImpl(expire, left)
      return
    }
    activeUrl = null
    timer = null
    try {
      element?.pause?.()
    } catch {
      /* ignore */
    }
    onStatus('timeout', 'max-duration')
  }

  /**
   * @returns {'playing'|'blocked'|'unavailable'}
   */
  function start(url, volume = RING_VOLUME_FALLBACK) {
    stop('replaced')
    if (!element || !url) {
      onStatus('unavailable', 'no-element-or-url')
      return 'unavailable'
    }
    activeUrl = url
    deadline = now() + maxDurationMs
    const currentAttempt = ++attempt
    const fail = (detail) => {
      if (currentAttempt !== attempt || !activeUrl) return
      releaseTimer()
      activeUrl = null
      waitingForGesture = false
      onStatus('unavailable', detail)
    }
    try {
      element.loop = true
      element.volume = Math.max(0, Math.min(1, Number(volume)))
      element.onerror = () => fail(`media-error-${element.error?.code || 'unknown'}`)
      element.src = url
      const started = element.play?.()
      if (started && typeof started.catch === 'function') {
        started.catch((error) => {
          if (currentAttempt !== attempt || !activeUrl) return
          if (!isAutoplayBlock(error)) {
            fail(error?.message || String(error))
            return
          }
          // Autoplay policy: keep the call on screen, ring on the next gesture.
          waitingForGesture = true
          onStatus('blocked', 'autoplay')
          if (typeof armGestureRetry === 'function') {
            armGestureRetry(() => {
              if (!activeUrl || !waitingForGesture) return
              waitingForGesture = false
              start(activeUrl, element.volume)
            })
          }
        })
      }
    } catch (e) {
      fail(e && e.message ? e.message : String(e))
      return 'unavailable'
    }
    releaseTimer()
    timer = setTimeoutImpl(expire, maxDurationMs)
    onStatus('playing', url)
    return 'playing'
  }

  return {
    start,
    stop,
    get ringing() {
      return activeUrl !== null
    },
  }
}
