import test from 'node:test'
import assert from 'node:assert/strict'
import { SttService } from '../src/core/stt.mjs'

test('only native recognition is advertised, without a recording upload service', () => {
  for (const configured of [undefined, 'windows-native', 'browser', 'api']) {
    const service = new SttService({ config: { getPath: () => configured }, secretStore: { get() { throw new Error('unused secret access') } } })
    assert.equal(service.providerId(), 'windows-native')
    assert.equal(service.isReady(), true)
    assert.equal(service.describe().keyConfigured, false)
    assert.equal(service.transcribe, undefined)
  }
})

test('disabling the microphone is reflected in diagnostics', () => {
  const service = new SttService({ config: { getPath: () => 'none' } })
  assert.equal(service.isReady(), false)
  assert.equal(service.describe().degrade, 'mic-disabled')
})
