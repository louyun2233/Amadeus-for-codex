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

test('splitSentences caps each chunk length', () => {
  const out = splitSentences('あ'.repeat(10) + '。', 12, 4)
  assert.ok(out.length <= 12)
  for (const s of out) assert.ok(s.length <= 4)
})

test('long tagged paragraphs keep every character and inherit emotion after splitting', () => {
  const first = 'あ'.repeat(198)
  const second = 'い'.repeat(620)
  const parsed = parseReply(`JP: 【soft】${first}【annoyed】${second}\nCN: 长回复。`)
  assert.equal(parsed.segments.map(segment => segment.text).join(''), first + second)
  assert.equal(parsed.segments[0].emotion, 'soft')
  assert.ok(parsed.segments.slice(1).every(segment => segment.emotion === 'annoyed'))
  assert.ok(parsed.segments.every(segment => !/[【】]/.test(segment.text)))
})

test('more than 24 sentences retain the complete end of a reply', () => {
  const text = Array.from({ length: 80 }, (_, index) => `これは第${index}番目の説明です。`).join('')
  const parsed = parseReply(`JP: 【thinking】${text}\nCN: 完整说明。`)
  assert.equal(parsed.segments.length, 80)
  assert.equal(parsed.segments.map(segment => segment.text).join(''), text)
  assert.ok(parsed.segments.every(segment => segment.emotion === 'thinking'))
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

test('explicit emotions survive replies without JP/CN wrappers', () => {
  const parsed = parseReply('【blush】\n別にあなたのためじゃないわ。【annoyed】もう、からかわないで。')
  assert.equal(parsed.parsed, false)
  assert.equal(parsed.emotion, 'blush')
  assert.deepEqual(parsed.segments.map((segment) => segment.emotion), ['blush', 'annoyed'])
  assert.ok(parsed.segments.every((segment) => segment.text && !segment.text.includes('【')))
})

test('formatted replies without emotion tags infer expression instead of staying neutral', () => {
  const parsed = parseReply('JP: やった、できた！\nCN: 太好了，成功了！')
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.emotion, 'happy')
  assert.equal(parsed.segments[0].emotion, 'happy')
})

test('explicit neutral remains authoritative over keyword inference', () => {
  const parsed = parseReply('【neutral】\nJP: エラーが出たわ。\nCN: 出现错误了。')
  assert.equal(parsed.emotion, 'neutral')
  assert.equal(parsed.segments[0].emotion, 'neutral')
})

test('Chinese-only formatting provides emotional feedback and removes control tags from display', () => {
  const parsed = parseReply('CN: 【soft】没事，慢慢来。')
  assert.equal(parsed.emotion, 'soft')
  assert.equal(parsed.zh, '没事，慢慢来。')
  assert.equal(parsed.segments[0].emotion, 'soft')
})

test('inferEmotion distinguishes troubleshooting from surprise and delight', () => {
  assert.equal(inferEmotion('エラーが出たわ'), 'thinking')
  assert.equal(inferEmotion('えっ、まさか'), 'surprised')
  assert.equal(inferEmotion('できた！やった'), 'happy')
  assert.equal(inferEmotion('ふつうの文です'), 'neutral')
})
