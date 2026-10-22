import test from 'node:test'
import assert from 'node:assert/strict'
import { SecretStore, envNameFor } from '../src/core/secrets.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Credential handling rules the panel now depends on:
 * env wins, the value never comes back out, and unknown names are refused.
 * The panel's settings field is write-only precisely because `describe()` has
 * nothing to give it.
 */

test('envNameFor follows the documented pattern', () => {
  assert.equal(envNameFor('chatApiKey'), 'AMADEUS_CHAT_API_KEY')
  assert.equal(envNameFor('sttApiKey'), 'AMADEUS_STT_API_KEY')
  assert.equal(envNameFor('openaiBaseUrl'), 'AMADEUS_OPENAI_BASE_URL')
})

test('an environment variable wins and is reported as such', () => {
  const paths = tempPaths()
  const store = new SecretStore(paths)
  process.env.AMADEUS_CHAT_API_KEY = 'super-secret-value'
  try {
    assert.equal(store.get('chatApiKey'), 'super-secret-value')
    const info = store.describe('chatApiKey')
    assert.equal(info.configured, true)
    assert.equal(info.source, 'env')
    assert.equal(info.envVar, 'AMADEUS_CHAT_API_KEY')
  } finally {
    delete process.env.AMADEUS_CHAT_API_KEY
    cleanup(paths)
  }
})

test('describe never leaks the value, singly or in bulk', () => {
  const paths = tempPaths()
  const store = new SecretStore(paths)
  process.env.AMADEUS_TTS_API_KEY = 'another-secret-value'
  try {
    store.get('ttsApiKey')
    assert.ok(!JSON.stringify(store.describe('ttsApiKey')).includes('another-secret-value'))
    assert.ok(!JSON.stringify(store.describeAll()).includes('another-secret-value'))
  } finally {
    delete process.env.AMADEUS_TTS_API_KEY
    cleanup(paths)
  }
})

test('unknown secret names are refused', () => {
  const paths = tempPaths()
  try {
    const store = new SecretStore(paths)
    assert.throws(() => store.set('notASecret', 'x'), /unknown secret/)
    assert.equal(store.get('notASecret'), null)
    assert.deepEqual(store.describe('notASecret'), { configured: false, source: 'none' })
  } finally {
    cleanup(paths)
  }
})

test('an unconfigured secret reads as unconfigured', () => {
  const paths = tempPaths()
  try {
    const store = new SecretStore(paths)
    delete process.env.AMADEUS_OPENAI_BASE_URL
    assert.equal(store.get('openaiBaseUrl'), null)
    assert.equal(store.describe('openaiBaseUrl').configured, false)
  } finally {
    cleanup(paths)
  }
})
