import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, splitSentences } from '../src/core/parse.mjs'
import { EMOTIONS, inferEmotion } from '../src/core/emotion.mjs'

test('splitSentences works without lookbehind', () => {
  const out = splitSentences('ふふっ、やるじゃない。それで、次はどうするの？')
  assert.equal(out.length, 2)
  assert.match(out[0], /やるじゃない/)
  assert.match(out[1], /次はどうするの/)
})

test('splitSentences caps sentence count and length', () => {
  const out = splitSentences('あ'.repeat(10) + '。', 12, 4)
  assert.ok(out.length <= 12)
  for (const s of out) assert.ok(s.length <= 4)
})

test('parseReply extracts emotion, japanese and chinese', () => {
  const raw = '【soft】\nJP: 【soft】ふふっ、やるじゃない。\nCN: 呵呵，干得不错嘛。'
  const parsed = parseReply(raw)
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.emotion, 'soft')
  assert.equal(parsed.zh, '呵呵，干得不错嘛。')
  assert.match(parsed.ja, /やるじゃない/)
  assert.equal(parsed.segments.length, 1)
  assert.equal(parsed.segments[0].emotion, 'soft')
})

test('parseReply supports per-sentence emotion tags', () => {
  const raw = '【soft】\nJP: 【soft】そうね。【question】それで、次はどうするの？\nCN: 是啊。那接下来你打算怎么办？'
  const parsed = parseReply(raw)
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[0].emotion, 'soft')
  assert.equal(parsed.segments[1].emotion, 'question')
  assert.ok(!parsed.segments[1].text.includes('【'))
})

test('parseReply degrades when the model ignores the format', () => {
  const parsed = parseReply('嗯，怎么了？')
  assert.equal(parsed.parsed, false)
  assert.equal(parsed.zh, '嗯，怎么了？')
  assert.equal(parsed.ja, '') // no kana → nothing to speak
  assert.ok(EMOTIONS.includes(parsed.emotion))
})

test('inferEmotion is biased toward negative and surprise signals', () => {
  assert.equal(inferEmotion('エラーが出たわ'), 'angry')
  assert.equal(inferEmotion('えっ、まさか'), 'surprised')
  assert.equal(inferEmotion('できた！やった'), 'happy')
  assert.equal(inferEmotion('ふつうの文です'), 'neutral')
})
