/**
 * Live2D (Cubism 2) renderer.
 *
 * Runtime chain: pixi 7 -> live2d.min.js (Cubism 2 core) -> pixi-live2d-display
 * cubism2 build. pixi and the display layer are MIT and ship with the repo; the
 * Cubism 2 core is fetched on demand (or supplied by the user) because it is
 * not ours to redistribute.
 *
 * Design notes learned the hard way:
 *  - the canvas must never be handed out as a 2D context, or pixi can never get
 *    WebGL on it (the placeholder therefore draws on its own canvas)
 *  - the model must be created with `autoUpdate:false`, otherwise its own ticker
 *    competes with this render loop and the parameters we write are ignored
 *  - parameters are written *after* `model.update()`, or motion/physics
 *    overwrite them every frame and lip-sync silently does nothing
 */

import { poseForEmotion, approachPose } from './affect.js'

const P = {
  mouthOpenY: 'PARAM_MOUTH_OPEN_Y',
  eyeBallX: 'PARAM_EYE_BALL_X',
  eyeBallY: 'PARAM_EYE_BALL_Y',
  angleX: 'PARAM_ANGLE_X',
  angleY: 'PARAM_ANGLE_Y',
  angleZ: 'PARAM_ANGLE_Z',
  bodyAngleX: 'PARAM_BODY_ANGLE_X',
}

const DEFAULT_LAYOUT = { scale: 1, x: 0, y: 0, yRatio: 0.52 }
const DEFAULT_MOTIONS = {
  idle: { group: 'idle', variants: 1 },
  head: { group: 'flick_head', variants: 3 },
  body: { group: 'tap_body', variants: 3 },
  other: { group: 'pinch_in', variants: 3 },
}

// The registry's layout values were tuned while the panel canvas was 392px
// wide; a manual nudge is scaled against that so it survives resizing.
const REFERENCE_WIDTH = 392

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-amadeus-src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`脚本加载失败：${src}`)))
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.async = false
    el.dataset.amadeusSrc = src
    el.onload = () => {
      el.dataset.loaded = '1'
      resolve()
    }
    el.onerror = () => reject(new Error(`脚本加载失败：${src}`))
    document.head.appendChild(el)
  })
}

export function createLive2D({
  canvas,
  vendorBase,
  runtimeUrl,
  modelUrl,
  layout,
  expressionMap = {},
  motionMap = {},
  parameterMap = {},
  onContextLost = () => {},
}) {
  const cfg = { ...DEFAULT_LAYOUT, ...(layout || {}) }
  const motions = { ...DEFAULT_MOTIONS, ...motionMap }
  const params = { ...P, ...parameterMap }
  let app = null
  let model = null
  let core = null
  let mouth = 0
  let angleT = 0
  let pose = poseForEmotion('neutral')
  let targetPose = pose
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let currentExpression = null
  let disposed = false
  let lastLayout = null

  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault()
    if (disposed) return
    onContextLost()
  })

  function setFloat(id, value) {
    if (!core) return
    try {
      if (typeof core.setParamFloat === 'function') core.setParamFloat(id, value)
      else if (typeof core.setParameterValueById === 'function') core.setParameterValueById(id, value, 1)
    } catch {
      /* a missing parameter must never break the frame */
    }
  }

  function expressionFor(emotion) {
    for (const [name, list] of Object.entries(expressionMap)) {
      if (Array.isArray(list) && list.includes(emotion)) return name
    }
    return null
  }

  /**
   * Bounds of what is actually *drawn*.
   *
   * `model.getBounds()` unions every child, including the hidden parts this
   * model carries, which drags the measured centre to the right. Centring on
   * that number needed a hand-tuned pixel nudge (the registry used to carry
   * `x: -80`), and any nudge in absolute pixels is wrong the moment the canvas
   * changes size - in the small phone window the character sat 80px left of
   * centre. Walking only the visible leaves removes the guesswork.
   */
  function visibleBounds(root) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const add = (b) => {
      if (!b || !(b.width > 0) || !(b.height > 0)) return
      box.minX = Math.min(box.minX, b.x)
      box.minY = Math.min(box.minY, b.y)
      box.maxX = Math.max(box.maxX, b.x + b.width)
      box.maxY = Math.max(box.maxY, b.y + b.height)
    }
    const visit = (node) => {
      if (!node || node.visible === false || node.renderable === false) return
      const children = node.children || []
      if (children.length === 0) {
        try {
          add(node.getBounds())
        } catch {
          /* a leaf without bounds simply does not contribute */
        }
        return
      }
      for (const child of children) visit(child)
    }
    visit(root)
    if (!Number.isFinite(box.minX)) return null
    return { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY }
  }

  /**
   * Fit the drawn content to the canvas.
   *
   * This model's internal canvas is far larger than the panel and its bounds
   * include hidden parts, so anchoring to a fixed ratio parks the character off
   * screen. Measure what is actually drawn, scale to fit, then align the drawn
   * centre to the requested point.
   */
  function relayout() {
    if (!model) return
    const w = canvas.width
    const h = canvas.height
    if (model.anchor && model.anchor.set) model.anchor.set(0, 0)
    model.scale.set(1)
    model.position.set(0, 0)

    let bounds = null
    try {
      bounds = visibleBounds(model) || model.getBounds()
    } catch {
      bounds = null
    }
    let mw = bounds && bounds.width > 50 && bounds.width < 5000 ? bounds.width : 0
    let mh = bounds && bounds.height > 50 && bounds.height < 5000 ? bounds.height : 0
    if (mw === 0) mw = Number(model.width) || Number(model.internalModel?.width) || 600
    if (mh === 0) mh = Number(model.height) || Number(model.internalModel?.height) || 900

    const fit = Math.min((w * 0.92) / mw, (h * 0.96) / mh)
    const scale = Math.max(0.05, Math.min(4, fit * (cfg.scale || 1)))
    model.scale.set(scale)

    let scaled = null
    try {
      scaled = visibleBounds(model) || model.getBounds()
    } catch {
      scaled = null
    }
    const centerX = scaled ? scaled.x + scaled.width / 2 : w / 2
    const centerY = scaled ? scaled.y + scaled.height / 2 : h * 0.52
    // Any manual nudge is expressed for the reference canvas and scaled with
    // it, so a tuned value cannot wreck a differently sized window.
    const nudgeX = (cfg.x || 0) * (w / REFERENCE_WIDTH)
    model.position.set(w / 2 + nudgeX - centerX, h * (cfg.yRatio ?? 0.52) + (cfg.y || 0) - centerY)
    lastLayout = {
      canvas: { w, h },
      measured: { mw: Math.round(mw), mh: Math.round(mh) },
      fit: Number(fit.toFixed(4)),
      scale: Number(scale.toFixed(4)),
      center: { x: Math.round(centerX), y: Math.round(centerY) },
      boundsAtMeasure: scaled
        ? { x: Math.round(scaled.x), y: Math.round(scaled.y), w: Math.round(scaled.width), h: Math.round(scaled.height) }
        : null,
      position: { x: Math.round(model.position.x), y: Math.round(model.position.y) },
    }
  }

  return {
    get ready() {
      return Boolean(model && !disposed)
    },

    /**
     * Where the model actually ended up. Used by the layout assertions in
     * scripts/ui/verify-ui.mjs - "the character is not centred" is impossible to
     * assert on from outside otherwise, because a WebGL canvas cannot be read
     * back reliably.
     */
    debugInfo() {
      if (!model) return null
      let bounds = null
      try {
        const b = model.getBounds()
        bounds = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
      } catch {
        bounds = null
      }
      return {
        canvas: { w: canvas.width, h: canvas.height },
        scale: Number(model.scale.x.toFixed(3)),
        position: { x: Math.round(model.position.x), y: Math.round(model.position.y) },
        bounds,
        internal: {
          w: Math.round(Number(model.internalModel?.width) || 0),
          h: Math.round(Number(model.internalModel?.height) || 0),
        },
        lastLayout,
      }
    },

    async init() {
      await loadScript(`${vendorBase}pixi-7.4.2.min.js`)
      await loadScript(runtimeUrl)
      await loadScript(`${vendorBase}pixi-live2d-display-0.4.0-cubism2.min.js`)

      const PIXI = window.PIXI
      if (!PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
        throw new Error('Live2D 运行时不完整（PIXI.live2d 缺失）')
      }

      // The model embeds its original MP3 lines in motion metadata. The
      // imported media pack or selected TTS voice owns audio instead.
      PIXI.live2d.config.sound = false

      app = new PIXI.Application({
        view: canvas,
        width: canvas.width,
        height: canvas.height,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        resolution: 1,
        autoDensity: false,
      })

      model = await PIXI.live2d.Live2DModel.from(modelUrl, {
        autoInteract: false,
        autoUpdate: false,
      })
      relayout()
      app.stage.addChild(model)
      core = model.internalModel?.coreModel || null
      try {
        if (motions.idle?.group) model.motion(motions.idle.group)
      } catch {
        /* no idle group is acceptable */
      }
      return true
    },

    /** Resize the renderer to the given backing size and re-fit the model. */
    setCanvasSize(w, h) {
      if (w < 10 || h < 10) return
      canvas.width = w
      canvas.height = h
      if (app) {
        app.renderer.resize(w, h)
        relayout()
      }
    },

    relayout,
    setMouth(value) {
      mouth = Math.max(0, Math.min(1, value))
    },

    setEmotion(emotion) {
      targetPose = poseForEmotion(emotion)
      const name = expressionFor(emotion)
      // null is a real target: this model's f01 has no parameters, so leaving
      // the previous expression applied makes a new emotion inherit the old
      // face. Reset explicitly when nothing is mapped.
      const key = name || '__reset__'
      if (key === currentExpression) return
      currentExpression = key
      try {
        if (name) model.expression(name)
        else model.expression()
      } catch {
        /* unknown expression names are model-specific; ignore */
      }
    },

    playMotion(action, index) {
      try {
        const group = motions[action]?.group
        if (!group) return false
        model.motion(group, index, 3)
        return true
      } catch {
        return false
      }
    },

    hitTest(x, y) {
      try {
        const hits = model.hitTest(x, y)
        if (Array.isArray(hits) && hits.length > 0) return hits[0]
      } catch {
        /* fall through to the geometric fallback */
      }
      const h = canvas.height
      if (y < h * 0.42) return 'head'
      if (y < h * 0.62) return 'mouth'
      return 'body'
    },

    update(dtSeconds) {
      if (!model || disposed) return
      angleT += dtSeconds
      pose = approachPose(pose, targetPose, dtSeconds, Boolean(reducedMotion?.matches))

      // motion + physics first, then our parameters, otherwise the motion
      // manager overwrites them and lip-sync does nothing
      model.update(dtSeconds)

      const motion = reducedMotion?.matches ? 0 : 1
      const driftX = Math.sin(angleT * 0.45) * 6 * motion
      const driftY = Math.sin(angleT * 0.31 + 1.2) * 3 * motion
      setFloat(params.angleX, driftX + pose.x)
      setFloat(params.angleY, driftY + pose.y)
      setFloat(params.angleZ, Math.sin(angleT * 0.23) * 4 * motion + pose.z)
      setFloat(params.bodyAngleX, driftX * 0.35 + pose.x * 0.2)
      setFloat(params.eyeBallX, driftX / 6 + pose.x / 8)
      setFloat(params.eyeBallY, driftY / 3 - pose.y / 8)
      setFloat(params.mouthOpenY, Math.max(0, Math.min(1, mouth * 2.2)))
      // eyes are deliberately not driven here: this model's own motions blink,
      // and fighting them every frame latched the eyes shut

      app.renderer.render(app.stage)
    },

    dispose() {
      disposed = true
      try {
        app?.destroy(false, { children: true })
      } catch {
        /* ignore */
      }
      app = null
      model = null
      core = null
    },
  }
}
