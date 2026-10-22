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

/** emotion -> Live2D expression id (Cubism 2 model expression files) */
export const EMOTION_EXPR = {
  happy: 'f01',
  excited: 'f01',
  elated: 'f01',
  winking: 'f01',
  sad: 'f02',
  soft: 'f02',
  blush: 'f02',
  disappointed: 'f02',
  angry: 'f03',
  furious: 'f03',
  annoyed: 'f03',
  question: 'f04',
  thinking: 'f04',
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
  [/(エラー|失敗|できない|错误|失败|无法|不能|ダメ|最悪|ひどい|讨厌|糟糕)/, 'angry'],
  [/(ふざけるな|何言ってるの|馬鹿|バカ|闭嘴|烦死了|岂有此理)/, 'furious'],
  [/(えっ|え？|まさか|不会吧|真的假的|惊|没想到|居然)/, 'surprised'],
  [/(脸红|害羞|照れ|恥ずかしい|喜欢你|心动)/, 'blush'],
  [/(考え|思う|ふむ|なるほど|让我想想|嗯…)/, 'thinking'],
  [/(もう|うるさい|真是的|啧|烦人)/, 'annoyed'],
  [/(随便|どうでも|无所谓|知らない|随你)/, 'indifferent'],
  [/(抱歉|ごめん|对不起|すみません|残念)/, 'sad'],
  [/(完成|成功|好了|搞定|できた|よかった|やった|恭喜|厉害|太好了)/, 'happy'],
  [/(…|⋯|大丈夫|没事|安心|ゆっくり)/, 'soft'],
]

/**
 * Keyword fallback for when the model ignores the format contract. Order is
 * intentional: negative and surprise signals win over positive ones.
 */
export function inferEmotion(text) {
  const t = String(text || '')
  for (const [re, emotion] of RULES) if (re.test(t)) return emotion
  if (/[？?]/.test(t)) return 'question'
  if (/[！!]/.test(t)) return 'excited'
  return 'neutral'
}
