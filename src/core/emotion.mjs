export const EMOTIONS = [
  'happy',
  'excited',
  'elated',
  'sad',
  'angry',
  'furious',
  'question',
  'soft',
  'blush',
  'annoyed',
  'thinking',
  'surprised',
  'disappointed',
  'eyes_closed',
  'indifferent',
  'side',
  'winking',
  'neutral',
]

/**
 * Compatibility expression hints for the bundled Kurisu model. Keep this in
 * agreement with the registry: f01 has no parameters, f02 is downcast, f03 is
 * angry, and f04 is surprised/blushing. Other emotions use native pose cues.
 */
export const EMOTION_EXPR = {
  happy: '',
  excited: '',
  elated: '',
  winking: '',
  sad: 'f02',
  soft: '',
  blush: 'f04',
  disappointed: 'f02',
  angry: 'f03',
  furious: 'f03',
  annoyed: 'f03',
  question: '',
  thinking: '',
  surprised: 'f04',
  eyes_closed: '',
  indifferent: '',
  side: '',
  neutral: '',
}

export function normalizeEmotion(value, fallback = 'neutral') {
  return EMOTIONS.includes(value) ? value : fallback
}

const RULES = [
  [/(ふざけるな|何言ってるの|馬鹿|バカ|闭嘴|烦死了|岂有此理)/, 'furious'],
  [/(腹が立|許せない|怒って|むかつく|ムカつく|生气|气死|恼火|最悪|ひどい|讨厌|糟糕)/, 'angry'],
  [/(大丈夫じゃない|大丈夫ではない|悲し|寂し|落ち込|难过|难受|失落|伤心)/, 'sad'],
  // Acknowledging a failure while comforting someone is not anger. Prefer
  // the reply's social intent over the mere presence of technical problems.
  [/(大丈夫|心配しない|無理しない|安心|ゆっくり|没事|别担心|不要担心|慢慢来|别自责|不要自责)/, 'soft'],
  [/(えっ|え？|まさか|不会吧|真的假的|惊|没想到|居然)/, 'surprised'],
  [/(脸红|害羞|照れ|恥ずかしい|喜欢你|心动)/, 'blush'],
  [/(抱歉|ごめん|对不起|すみません|残念)/, 'sad'],
  [/(考え|思う|ふむ|なるほど|让我想想|嗯…)/, 'thinking'],
  [/(もう[、…！!。]|うるさい|真是的|啧|烦人)/, 'annoyed'],
  [/(随便|どうでも|无所谓|知らない|随你)/, 'indifferent'],
  [/(太好了|やった|よかった|恭喜|厉害|修好了|解决了)/, 'happy'],
  // Neutral troubleshooting language must not make the character glare at
  // the user. This also keeps "无法完成" from matching the happy "完成" cue.
  [/(エラー|失敗|できない|错误|失败|无法|不能)/, 'thinking'],
  [/(完成|成功|好了|搞定|できた|よかった|やった|恭喜|厉害|太好了)/, 'happy'],
  [/(…|⋯)/, 'soft'],
]

/**
 * Keyword fallback for replies without explicit tags. Strong expressed
 * feelings and reassurance precede generic task/failure vocabulary. Explicit
 * tags remain authoritative in parseReply and never use this heuristic.
 */
export function inferEmotion(text) {
  const t = String(text || '')
  for (const [re, emotion] of RULES) if (re.test(t)) return emotion
  if (/[？?]/.test(t)) return 'question'
  if (/[！!]/.test(t)) return 'excited'
  return 'neutral'
}
