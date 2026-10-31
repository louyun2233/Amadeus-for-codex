import test from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, splitLocalSpeech, LOCAL_QWEN_CHUNK_MAX, SPEECH_CHUNK_MAX } from '../src/core/parse.mjs'
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
  assert.equal(out.length, sentences.length)
  assert.equal(out.join(''), text)
  assert.ok(out[out.length - 1].includes('第39文'), 'the last sentence must still be spoken')
  assert.ok(out.join('').includes('第0文'), 'and the first one too')
})

test('no chunk ever exceeds what the voice provider accepts', () => {
  const text = `${'あ'.repeat(1500)}。`
  const out = splitSentences(text, 3, 200)
  assert.ok(out.length > 3)
  assert.equal(out.join(''), text)
  for (const chunk of out) {
    assert.ok(chunk.length <= SPEECH_CHUNK_MAX, `chunk of ${chunk.length} chars`)
  }
})

test('local speech keeps short cached text exactly and cuts long text without losing Unicode', () => {
  const short = '少しだけなら。……調子に乗らないでよ。'
  assert.deepEqual(splitLocalSpeech(short), [short])
  assert.deepEqual(splitLocalSpeech(''), [])
  const text = '𠮷'.repeat(45) + '、' + 'まだ続く説明です。'.repeat(19) + ' 最後も残る。'
  const chunks = splitLocalSpeech(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 2)
  assert.ok(chunks[0].endsWith('。'), 'a sentence boundary takes priority over a comma')
  assert.ok(splitLocalSpeech('あ'.repeat(45) + '、' + 'い'.repeat(90))[0].endsWith('、'))
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk).length <= LOCAL_QWEN_CHUNK_MAX)
    assert.ok(chunk.isWellFormed(), 'a surrogate pair must not be cut')
  }
})

test('general speech chunks preserve supplementary characters within provider limits', () => {
  const text = '𠮷'.repeat(501) + '。'
  const chunks = splitSentences(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every(chunk => chunk.isWellFormed() && chunk.length <= SPEECH_CHUNK_MAX))
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
