import test from 'node:test'
import assert from 'node:assert/strict'
import { poseForEmotion, approachPose } from '../src/panel/affect.js'

test('emotion cues stay bounded and unknown labels are neutral', () => {
  assert.deepEqual(poseForEmotion('not-an-emotion'), poseForEmotion('neutral'))
  for (const label of ['happy', 'sad', 'angry', 'surprised', 'soft']) {
    const cue = poseForEmotion(label)
    assert.ok(Math.abs(cue.x) <= 7 && Math.abs(cue.y) <= 5 && Math.abs(cue.z) <= 4)
  }
})

test('facial pose approaches its target smoothly and reduced motion snaps directly', () => {
  const neutral = poseForEmotion('neutral')
  const target = poseForEmotion('happy')
  const partial = approachPose(neutral, target, 0.016)
  assert.ok(partial.x > 0 && partial.x < target.x)
  assert.deepEqual(approachPose(neutral, target, 0.016, true), target)
})
