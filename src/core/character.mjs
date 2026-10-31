import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMOTIONS } from './emotion.mjs'

const PERSONA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'persona')
const CHARACTER_ID = /^[a-z][a-z0-9_-]{1,39}$/
const VALID_EMOTIONS = new Set(EMOTIONS)

export function characterSourceFile(name, extension) {
  if (!CHARACTER_ID.test(String(name)) || !['md', 'json'].includes(extension)) {
    throw new Error('invalid character id; use 2-40 lowercase letters, numbers, _ or -')
  }
  return path.join(PERSONA_DIR, `${name}.${extension}`)
}

function line(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new Error(`${label}.${field} must be non-empty text`)
    }
  }
  if (!VALID_EMOTIONS.has(value.emotion)) throw new Error(`${label}.emotion is not supported`)
  return value
}

function lines(value, fields, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must have at least one line`)
  value.forEach((item, index) => line(item, fields, `${label}[${index}]`))
  return value
}

/** Source-only copy for welcome, tap, task and proactive lines. No UI editor. */
export function loadCharacterContent(name = 'kurisu') {
  const file = characterSourceFile(name, 'json')
  let content
  try {
    content = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot load persona/${name}.json: ${error.message}`)
  }
  if (typeof content.displayName !== 'string' || !content.displayName.trim() || content.displayName.length > 80) {
    throw new Error('displayName must be 1-80 characters')
  }
  if (content.callName !== undefined &&
      (typeof content.callName !== 'string' || !content.callName.trim() || content.callName.length > 80)) {
    throw new Error('callName must be 1-80 characters when provided')
  }
  line(content.welcome, ['text', 'emotion'], 'welcome')
  lines(content.tapReactions, ['text', 'emotion'], 'tapReactions')
  for (const item of content.tapReactions) {
    if (item.cn !== undefined && (typeof item.cn !== 'string' || !item.cn.trim() || item.cn.length > 120)) {
      throw new Error('tapReactions.cn must be 1-120 characters when provided')
    }
    if (item.gestures !== undefined && (!Array.isArray(item.gestures) || item.gestures.length === 0 ||
        item.gestures.some((gesture) => !['head', 'body', 'swipe', 'pat'].includes(gesture)))) {
      throw new Error('tapReactions.gestures must use head, body, swipe or pat')
    }
  }
  for (const kind of ['start', 'complete', 'failed']) {
    lines(content.taskLines?.[kind], ['text', 'cn', 'emotion'], `taskLines.${kind}`)
  }
  lines(content.callCanned, ['jp', 'cn', 'emotion'], 'callCanned')
  lines(content.idleCanned, ['jp', 'cn', 'emotion'], 'idleCanned')
  return content
}
