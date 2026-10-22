/**
 * Motion sound effects.
 *
 * Deliberately a *separate* channel from speech, on a separate <audio> element:
 *  - the lip-sync analyser is attached to the speech element, so routing effects
 *    through it would make her mouth move to a door slam;
 *  - effects must never enter the speech queue, never delay a line and never
 *    cancel one. They are fire-and-forget.
 *
 * The decision logic is pure and injected so it can be tested without a DOM.
 */

export const SFX_COOLDOWN_MS = 400
export const SFX_DEFAULT_VOLUME = 0.5

/** Rotate through a group's motion variants without repeating the last one. */
export function createMotionSequence({ variants = 3, random = Math.random } = {}) {
  const last = new Map()
  return {
    next(group, variantCount = variants) {
      if (!group) return 0
      const count = Math.max(1, Math.floor(variantCount))
      const previous = last.get(group)
      const index = previous === undefined
        ? Math.floor(random() * count)
        : count === 1 ? 0 : (previous + 1 + Math.floor(random() * (count - 1))) % count
      last.set(group, index)
      return index
    },
  }
}

/** A tap is decorative and cannot add speech while a real reply is active. */
export function maySpeakTap({ voiceEnabled, turnPending, speechBusy, callPending }) {
  return voiceEnabled && !turnPending && !speechBusy && !callPending
}

export function createSfxPlayer({
  play,
  now = () => Date.now(),
  cooldownMs = SFX_COOLDOWN_MS,
  volume = SFX_DEFAULT_VOLUME,
  enabled = () => true,
  onSkip = () => {},
} = {}) {
  let lastAt = -Infinity

  return {
    /**
     * @returns {'played'|'cooldown'|'disabled'}
     */
    trigger(name) {
      if (!enabled()) return 'disabled'
      const at = now()
      if (at - lastAt < cooldownMs) {
        onSkip('cooldown', name)
        return 'cooldown'
      }
      lastAt = at
      // volume may be a getter, because the setting can change while the panel is open
      const level = typeof volume === 'function' ? volume() : volume
      try {
        play(name, level)
      } catch (e) {
        // an effect is decoration: a failure must never reach the caller
        onSkip('error', e && e.message ? e.message : String(e))
      }
      return 'played'
    },
    reset() {
      lastAt = -Infinity
    },
    get lastTriggeredAt() {
      return lastAt === -Infinity ? null : lastAt
    },
  }
}

/**
 * Map a motion group to the sound basename shipped with the model.
 * The registry carries the mapping because it is model-specific data, not code:
 * the files are `sounds/<base>_00.mp3 .. _02.mp3`.
 */
export function resolveSfxName(motionSounds, group, index = 0) {
  if (!motionSounds || typeof motionSounds !== 'object') return null
  const base = motionSounds[group]
  return typeof base === 'string' && base.length > 0 && Number.isInteger(index) && index >= 0 && index <= 2
    ? `${base}_${String(index).padStart(2, '0')}`
    : null
}
