import test from 'node:test'
import assert from 'node:assert/strict'
import { modelAssetUrl, runtimeAssetUrl } from '../src/panel/asset-urls.js'

test('new daemon asset status uses source model entry and runtime target', () => {
  assert.equal(modelAssetUrl({ entryName: 'models/avatar.model.json' }), '/amadeus/assets/current/models/avatar.model.json')
  assert.equal(runtimeAssetUrl({ targetName: 'live2d.min.js' }), '/amadeus/assets/runtime/live2d.min.js')
})

test('old daemon asset status still resolves a model instead of requesting an empty URL', () => {
  assert.equal(modelAssetUrl({ entry: 'C:\\cache\\kurisu\\kurisu.model.json' }), '/amadeus/assets/current/kurisu.model.json')
  assert.equal(runtimeAssetUrl({ path: 'C:\\cache\\runtime\\live2d.min.js' }), '/amadeus/assets/runtime/live2d.min.js')
})

test('missing and unsafe model entries do not produce an invalid asset request', () => {
  assert.equal(modelAssetUrl({ installed: true }), null)
  assert.equal(modelAssetUrl({ entryName: '../other.model.json' }), null)
  assert.equal(runtimeAssetUrl({ installed: true }), null)
})
