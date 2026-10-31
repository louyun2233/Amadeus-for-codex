import test from 'node:test'
import assert from 'node:assert/strict'
import { inferEmotion } from '../src/core/emotion.mjs'
import { parseReply } from '../src/core/parse.mjs'

test('plain failure reports express thought instead of hostility', () => {
  for (const reply of ['エラーが出たわ。', '接続できないみたい。', '连接失败，需要检查地址。', '暂时无法完成。']) {
    assert.equal(inferEmotion(reply), 'thinking', reply)
  }
})

test('comfort remains gentle even when it acknowledges failure', () => {
  for (const reply of ['大丈夫。失敗しても、ゆっくりやり直せばいい。',
    '没事，失败了也可以慢慢重来。', '别担心，暂时不能完成也别自责。']) {
    assert.equal(inferEmotion(reply), 'soft', reply)
  }
  const parsed = parseReply('JP: 大丈夫。失敗しても、ゆっくりやり直せばいい。\nCN: 没事，失败也可以再来。')
  assert.equal(parsed.emotion, 'soft')
  assert.deepEqual(parsed.segments.map((segment) => segment.emotion), ['soft', 'soft'])
})

test('expressed sadness or apology is retained in failure replies', () => {
  assert.equal(inferEmotion('失敗して、少し悲しい。'), 'sad')
  assert.equal(inferEmotion('抱歉，我没能完成。'), 'sad')
  assert.equal(inferEmotion('今は大丈夫じゃない。'), 'sad')
})

test('anger and annoyance need an actual emotional cue', () => {
  assert.equal(inferEmotion('本当に腹が立つわ。'), 'angry')
  assert.equal(inferEmotion('ふざけるな。'), 'furious')
  assert.equal(inferEmotion('もう、からかわないで。'), 'annoyed')
  assert.equal(inferEmotion('もう準備してあるわ。'), 'neutral')
  assert.equal(inferEmotion('太好了，错误已经解决了。'), 'happy')
})

test('fallback changes never replace explicit model emotion tags', () => {
  const reply = parseReply('【neutral】\nJP: 【neutral】大丈夫、失敗してもやり直せる。\nCN: 没事，失败了可以再来。')
  assert.equal(reply.emotion, 'neutral')
  assert.equal(reply.segments[0].emotion, 'neutral')
})
