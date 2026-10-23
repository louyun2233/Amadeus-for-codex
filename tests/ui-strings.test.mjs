import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Frozen, user-visible copy.
 *
 * The panel was reported once for a "typo" that was really a Japanese kanji
 * (応) sitting in an otherwise Chinese UI, next to a bold glyph whose 竹 radical
 * smeared into something that read like 艹. Freezing the exact strings makes
 * both failure modes loud: an accidental character substitution (荅 for 答) and
 * a stray Japanese word in a Chinese UI.
 *
 * When the UI copy changes on purpose, update these lists in the same commit.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const EXPECTED_TEXT = [
  'AMADEUS',
  '--:--',
  '连接中…',
  'Xp',
  'madeus',
  '牧濑红莉栖',
  'Call from Kurisu.',
  'CONNECT',
  'DECLINE',
  '对话',
  '记忆',
  '设置',
  '自检',
  '长期记忆',
  '能力自检',
  '首次使用 · 1 / 2',
  '先了解数据去向',
  '聊天文字经本机 Codex CLI 交给你配置的模型服务；会话记录保存在本机。',
  '启用语音后，合成文字可能发给 Edge TTS；配置阿里云密钥后会发给百炼。点击麦克风时，浏览器识别也可能使用在线服务。',
  '新安装默认关闭语音、任务播报、长期记忆和主动交互；下一步可按需开启。',
  '跳过',
  '下一步',
  '首次使用 · 2 / 2',
  '选择要开启的功能',
  '语音朗读',
  '任务开始 / 完成播报',
  '自动抽取长期事实',
  '空闲时主动开口',
  '主动来电',
  '语音与任务播报可能调用在线语音服务；所有选项都能在「设置」中更改。',
  '返回',
  '完成',
]

const EXPECTED_ATTRS = [
  '刷新状态',
  '语音输入',
  '和 Amadeus 说话…',
  '发送',
  '导出记忆',
  '清空面板记忆',
  '重新自检（含语音探测）',
]

const EXPECTED_SETTINGS_LABELS = [
  '语音朗读',
  '音色',
  '情绪强度',
  '保持音色一致',
  '来电铃声',
  '铃声音量',
  '语音输入',
  '对话模型通道',
  'API Key',
  '语音密钥',
  '对话模式',
  '允许模型主动发声',
  '允许模型触发来电',
  '任务完成播报',
  '任务开始互动',
  '系统播报',
  '长期记忆',
  '自动抽取记忆',
  '空闲主动开口',
  '主动来电',
  '空闲多久开口',
  '来电间隔',
  'Live2D 素材',
  '清空语音队列',
  '使用引导',
]

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function unique(list) {
  return [...new Set(list)]
}

function visibleText(html) {
  return unique(
    [...html.matchAll(/>([^<>{}]+)</g)]
      .map((m) => m[1].trim())
      .filter((t) => t.length > 0),
  )
}

function attributeCopy(html) {
  return unique(
    [...html.matchAll(/(?:title|placeholder|alt)="([^"]+)"/g)].map((m) => m[1]),
  )
}

function settingsLabels(source) {
  // Labels are mostly literals in `row('…')`; the credential rows build their
  // row through a helper, so their label is a `label: '…'` property of that
  // call. One pass keeps both in source order - the order is frozen too.
  const re = /row\('([^']+)'|credentialRow\(\{[^}]*?label:\s*'([^']+)'/gs
  const out = []
  for (const match of source.matchAll(re)) out.push(match[1] || match[2])
  return unique(out)
}

/**
 * Every panel source file we author, as one blob.
 *
 * Copy lives in more places than the markup: `main.js` builds the fallback
 * incoming-call line at runtime, and that is exactly where a Japanese string
 * survived the first round of this check because index.html alone looked clean.
 */
function authoredPanelText() {
  const dir = path.join(ROOT, 'src', 'panel')
  const walk = (rel) =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
      const next = path.join(rel, entry.name)
      if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walk(next)
      return /\.(html|js|css)$/.test(entry.name) ? [fs.readFileSync(path.join(dir, next), 'utf8')] : []
    })
  return walk('.').join('\n')
}

const html = read('src/panel/index.html')
const views = read('src/panel/views.js')
const panelText = authoredPanelText()

test('panel visible copy matches the frozen list', () => {
  assert.deepEqual(visibleText(html), EXPECTED_TEXT)
})

test('panel attribute copy matches the frozen list', () => {
  assert.deepEqual(attributeCopy(html), EXPECTED_ATTRS)
})

test('settings labels match the frozen list', () => {
  assert.deepEqual(settingsLabels(views), EXPECTED_SETTINGS_LABELS)
})

test('the Chinese UI contains no Japanese kana', () => {
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
  const offenders = [
    ...visibleText(html),
    ...attributeCopy(html),
    ...settingsLabels(views),
  ].filter((s) => kana.test(s))
  assert.deepEqual(offenders, [], `kana found in UI copy: ${offenders.join(', ')}`)

  // Kanji-only Japanese (着信中) has no kana to give it away, so scan the raw
  // sources too: any stray kana in the panel is a bug, even in a comment.
  const rawLines = panelText
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => kana.test(line))
  assert.deepEqual(rawLines, [], 'kana found in panel sources')
})

test('user-visible copy uses the single-character ellipsis consistently', () => {
  const all = [...visibleText(html), ...attributeCopy(html)]
  const offenders = all.filter((s) => s.includes('...'))
  assert.deepEqual(offenders, [], `use … instead of ... in: ${offenders.join(', ')}`)
})

test('retro call copy stays legible and the controls retain Chinese accessible labels', () => {
  // The screen follows the English reference, while the controls are still
  // announced in Chinese by assistive technology.
  const forbidden = ['応答', '拒否', '着信中']
  for (const word of forbidden) {
    assert.ok(!html.includes(word), `panel UI must not contain the Japanese string ${word}`)
    assert.ok(!panelText.includes(word), `${word} must not appear anywhere in the panel sources`)
  }
  assert.ok(html.includes('Call from Kurisu.'))
  assert.ok(html.includes('>CONNECT</button>'))
  assert.ok(html.includes('>DECLINE</button>'))
  assert.ok(html.includes('aria-label="接听红莉栖来电"'))
  assert.ok(html.includes('aria-label="拒接来电"'))
})
