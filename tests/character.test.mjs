import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { characterSourceFile, loadCharacterContent } from '../src/core/character.mjs'
import { loadPersona } from '../src/core/persona.mjs'

test('the source-only character module loads the complete default character', () => {
  const content = loadCharacterContent('kurisu')
  assert.equal(content.displayName, '牧濑红莉栖')
  assert.ok(content.welcome.text)
  assert.ok(content.tapReactions.length > 1)
  for (const kind of ['start', 'complete', 'failed']) assert.ok(content.taskLines[kind].length > 1)
  assert.ok(content.callCanned.length > 0)
  assert.ok(content.idleCanned.length > 0)
  assert.ok(fs.existsSync(characterSourceFile('kurisu', 'md')))
  assert.ok(loadPersona('kurisu').text.includes('JP:'))
})

test('unsafe or incomplete character sources fail instead of silently using Kurisu', () => {
  assert.throws(() => characterSourceFile('../kurisu', 'md'), /invalid character id/)
  assert.throws(() => loadPersona('missing-character'), /cannot load persona/)
  assert.throws(() => loadCharacterContent('missing-character'), /cannot load persona/)
})

test('source activation backs up saved config and preserves unrelated settings', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-character-test-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const saved = { character: 'other', voice: { provider: 'qwen-local', name: 'old-clone' }, memory: { enabled: true } }
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(saved))
  const result = spawnSync(process.execPath, ['scripts/character-source.mjs', '--apply'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, AMADEUS_DATA_DIR: dataDir, AMADEUS_CACHE_DIR: path.join(dataDir, 'cache') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const applied = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  assert.equal(applied.character, 'kurisu')
  assert.equal(applied.voice.provider, 'dashscope')
  assert.equal(applied.memory.enabled, true)
  const backup = fs.readdirSync(dataDir).find((name) => name.startsWith('config.json.backup-character-'))
  assert.ok(backup)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, backup), 'utf8')), saved)
})
