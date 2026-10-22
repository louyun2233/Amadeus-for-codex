import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/core/sessions.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

test('session lifecycle', () => {
  const paths = tempPaths()
  try {
    const sessions = new SessionStore(paths)
    const s = sessions.create({ name: '测试会话' })
    assert.equal(sessions.list().length, 1)
    sessions.append(s.id, { role: 'user', zh: '你好', ja: 'こんにちは' })
    sessions.append(s.id, { role: 'assistant', zh: '嗯', ja: 'うん', emotion: 'soft' })
    const reloaded = sessions.get(s.id)
    assert.equal(reloaded.messages.length, 2)
    assert.equal(reloaded.messages[1].emotion, 'soft')
    assert.equal(sessions.recentMessages(s.id, 1).length, 1)
    sessions.rename(s.id, '改名了')
    assert.equal(sessions.get(s.id).name, '改名了')
    assert.equal(sessions.list()[0].messageCount, 2)
  } finally {
    cleanup(paths)
  }
})

test('cannot delete the last session', () => {
  const paths = tempPaths()
  try {
    const sessions = new SessionStore(paths)
    const s = sessions.create()
    assert.throws(() => sessions.remove(s.id))
  } finally {
    cleanup(paths)
  }
})

test('invalid session ids are rejected', () => {
  const paths = tempPaths()
  try {
    const sessions = new SessionStore(paths)
    assert.throws(() => sessions.get('../../etc/passwd'))
    assert.throws(() => sessions.get('a'))
  } finally {
    cleanup(paths)
  }
})
