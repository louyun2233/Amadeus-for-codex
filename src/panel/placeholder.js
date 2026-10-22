/**
 * Canvas fallback avatar.
 *
 * Used when Live2D cannot run (no WebGL context, model missing, runtime error,
 * lost context). It has to look intentional, not broken.
 */

const TINT = {
  neutral: '#a3433b',
  happy: '#c4703f',
  excited: '#d0803a',
  elated: '#d0803a',
  sad: '#7a5a8a',
  angry: '#b03028',
  furious: '#c02020',
  blush: '#c05a5a',
  question: '#a3433b',
  soft: '#b07070',
}

export function createPlaceholder(canvas) {
  let ctx = null
  let blinkUntil = 0
  let nextBlinkAt = 1200

  function context() {
    if (!ctx) ctx = canvas.getContext('2d')
    return ctx
  }

  return {
    draw(now, { emotion = 'neutral', mouth = 0 } = {}) {
      const c = context()
      if (!c) return
      const w = canvas.width
      const h = canvas.height
      const scale = Math.max(0.6, Math.min(2, Math.min(w / 360, h / 320)))
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, w, h)
      c.translate(w / 2, h / 2 + Math.sin(now / 1400) * 3 * scale)
      c.scale(scale, scale)

      if (now > nextBlinkAt) {
        blinkUntil = now + 90
        nextBlinkAt = now + 2200 + Math.random() * 3200
      }
      const eyeOpen = now < blinkUntil ? 0.12 : 1
      const tint = TINT[emotion] || TINT.neutral

      c.fillStyle = tint
      c.beginPath()
      c.ellipse(0, -34, 74, 84, 0, 0, Math.PI * 2)
      c.fill()

      c.fillStyle = '#ffe6d8'
      c.beginPath()
      c.ellipse(0, 6, 56, 66, 0, 0, Math.PI * 2)
      c.fill()

      c.fillStyle = tint
      c.beginPath()
      c.moveTo(-58, -18)
      c.quadraticCurveTo(0, -78, 58, -18)
      c.quadraticCurveTo(20, -36, 0, -22)
      c.quadraticCurveTo(-24, -38, -58, -18)
      c.fill()

      c.fillStyle = '#3a5f95'
      c.beginPath()
      c.ellipse(-22, 2, 9, 7 * eyeOpen, 0, 0, Math.PI * 2)
      c.ellipse(22, 2, 9, 7 * eyeOpen, 0, 0, Math.PI * 2)
      c.fill()
      if (eyeOpen > 0.5) {
        c.fillStyle = '#12283f'
        c.beginPath()
        c.arc(-22, 2, 3.2, 0, Math.PI * 2)
        c.arc(22, 2, 3.2, 0, Math.PI * 2)
        c.fill()
      }

      if (emotion === 'blush' || emotion === 'excited' || emotion === 'happy') {
        c.fillStyle = 'rgba(240, 130, 120, .55)'
        c.beginPath()
        c.ellipse(-38, 18, 10, 5, 0, 0, Math.PI * 2)
        c.ellipse(38, 18, 10, 5, 0, 0, Math.PI * 2)
        c.fill()
      }

      const open = 2 + Math.max(0, Math.min(1, mouth)) * 11
      c.strokeStyle = '#b26a5a'
      c.lineWidth = 2
      c.beginPath()
      if (open < 4) {
        c.moveTo(-9, 34)
        c.quadraticCurveTo(0, 38, 9, 34)
      } else {
        c.ellipse(0, 34, 8, open / 2, 0, 0, Math.PI * 2)
      }
      c.stroke()
    },
  }
}
