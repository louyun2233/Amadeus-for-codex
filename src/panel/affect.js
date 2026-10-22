// Conservative pose cues for the installed Cubism 2 model. Expression files
// remain the source of facial detail; these small offsets only add continuity.
const CUES = {
  happy: [5, -2, 2], excited: [7, -3, 3], elated: [7, -3, 3],
  sad: [-3, 5, -2], disappointed: [-3, 4, -2], soft: [2, 2, 0],
  angry: [-5, -2, -3], furious: [-7, -3, -4], annoyed: [-3, 0, -2],
  surprised: [0, -5, 3], question: [4, -2, 3], thinking: [3, 2, 2],
  blush: [4, 3, 2], indifferent: [-2, 1, 0], side: [5, 0, 2],
  winking: [4, -1, 2], eyes_closed: [0, 2, 0], neutral: [0, 0, 0],
}

export function poseForEmotion(emotion) {
  const [x, y, z] = CUES[emotion] || CUES.neutral
  return { x, y, z }
}

export function approachPose(current, target, dt, reducedMotion = false) {
  if (reducedMotion) return { ...target }
  const alpha = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * 7)
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    z: current.z + (target.z - current.z) * alpha,
  }
}
