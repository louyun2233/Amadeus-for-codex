import test from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, SPEECH_CHUNK_MAX } from '../src/core/parse.mjs'
import { sanitizeForSpeech } from '../src/core/speech-text.mjs'

/**
 * "Some replies stutter and then go quiet."
 *
 * Three ways the speech path lost or mangled text:
 *   - a sentence longer than the per-request cap was cut mid-word, which the
 *     synthesiser renders as a broken word,
 *   - text past `maxSentences` was dropped without a word,
 *   - markdown and emoji went to the provider verbatim.
 */

test('an over-long sentence is cut at punctuation, not mid-word', () => {
  const text = `${'あ'.repeat(180)}。${'い'.repeat(180)}。`
  const out = splitSentences(text, 10, 200)
  assert.ok(out.length >= 2)
  assert.ok(out[0].endsWith('。'), `first chunk should end at the punctuation: ${out[0].slice(-4)}`)
  assert.ok(!out[0].startsWith('い'))
  assert.equal(out.join(''), text, 'nothing is lost')
})

test('a reply longer than the sentence budget keeps its ending', () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `第${i}文です。`)
  const text = sentences.join('')
  const out = splitSentences(text, 6, 200)
  assert.equal(out.length, 6)
  assert.ok(out[out.length - 1].includes('第39文'), 'the last sentence must still be spoken')
  assert.ok(out.join('').includes('第0文'), 'and the first one too')
})

test('no chunk ever exceeds what the voice provider accepts', () => {
  const text = `${'あ'.repeat(1500)}。`
  const out = splitSentences(text, 3, 200)
  assert.ok(out.length <= 3)
  for (const chunk of out) {
    assert.ok(chunk.length <= SPEECH_CHUNK_MAX, `chunk of ${chunk.length} chars`)
  }
})

test('markdown, links and emoji are removed before synthesis', () => {
  assert.equal(sanitizeForSpeech('**強調**してる`コード`'), '強調してるコード')
  assert.equal(sanitizeForSpeech('see [docs](https://example.com/a) now'), 'see docs now')
  assert.equal(sanitizeForSpeech('やった🎉！'), 'やった！')
  assert.equal(sanitizeForSpeech('# 見出し\n- 項目'), '見出し\n項目')
  assert.equal(sanitizeForSpeech('  spaced   out  '), 'spaced out')
  assert.equal(sanitizeForSpeech('プレーンな文です。'), 'プレーンな文です。')
})

test('the sanitizer never invents characters', () => {
  assert.equal(sanitizeForSpeech(''), '')
  assert.equal(sanitizeForSpeech(null), '')
  assert.equal(sanitizeForSpeech('😀'), '')
})
