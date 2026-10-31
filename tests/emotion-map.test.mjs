import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMOTIONS, EMOTION_EXPR } from '../src/core/emotion.mjs'

test('default expression hints agree with actual Kurisu expression resources', () => {
  const registry = JSON.parse(fs.readFileSync(new URL('../config/assets.registry.json', import.meta.url), 'utf8'))
  const model = registry.packs.find((pack) => pack.id === 'kurisu-model')
  for (const emotion of EMOTIONS) {
    const expected = Object.entries(model.expressionMap).find(([, names]) => names.includes(emotion))?.[0] || ''
    assert.equal(EMOTION_EXPR[emotion], expected, emotion)
  }
  assert.equal(EMOTION_EXPR.blush, 'f04')
  assert.equal(EMOTION_EXPR.thinking, '', 'thinking must not force the surprised/blushing expression')
  assert.equal(EMOTION_EXPR.happy, '', 'the empty f01 resource cannot implement happiness')
})
