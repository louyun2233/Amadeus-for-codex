import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFiles, scanText, collect } from '../scripts/portable-scan.mjs'

/**
 * Handing the project to somebody else must not hand over the author's keys.
 *
 * Conversation never needs one: the default chat channel is `codex-exec`, which
 * runs on whatever Codex login the other person already has. The cloud voice is
 * optional as well - with no key configured the built-in Edge voice is used.
 * What must never ship is a real key, and that is checked before packaging.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('conversation runs on the other person Codex login, not on a key', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'defaults.json'), 'utf8'))
  assert.equal(defaults.chat.provider, 'codex-exec')
  assert.ok(!/sk-/.test(JSON.stringify(defaults)), 'no key material in the defaults')
  assert.deepEqual(Object.keys(defaults.secrets || {}), [], 'defaults do not seed any secret')
})

test('the repository carries no credential material', () => {
  const problems = scanFiles(collect(ROOT))
  assert.deepEqual(problems, [], problems.map((p) => `${p.rel}: ${p.hits.join('; ')}`).join(' | '))
})

test('collection keeps relative paths and also works inside a dist directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-scan-'))
  try {
    const release = path.join(tmp, 'dist', 'marketplace')
    fs.mkdirSync(path.join(release, 'config'), { recursive: true })
    fs.writeFileSync(path.join(release, 'config', 'defaults.json'), '{}')
    assert.deepEqual(collect(release).map((file) => file.rel), ['config/defaults.json'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a key inside a packaged file is refused', () => {
  // Built at run time so this test file is not itself a false positive.
  const fakeKey = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-')
  const problems = scanFiles([
    { rel: 'pkg/notes.md', inline: Buffer.from(`token = ${fakeKey}`) },
  ])
  assert.equal(problems.length, 1)
  assert.match(problems[0].hits.join(' '), /openai-style key/)
  assert.ok(!JSON.stringify(problems).includes(fakeKey), 'diagnostics must not print key fragments')
})

test('personal Windows profile paths are refused without echoing the username', () => {
  const profile = ['C:', 'Users', 'RealPerson', 'AppData'].join('\\')
  const hits = scanText(`dataDir = ${profile}`)
  assert.deepEqual(hits, ['personal Windows user path'])
  assert.ok(!JSON.stringify(hits).includes('RealPerson'))
  assert.deepEqual(scanText(['C:', 'Users', 'ExampleUser'].join('\\')), [])
})

test('personal contact details are refused without echoing their values', () => {
  const email = ['private.name', 'mail', 'com'].join('@').replace('@com', '.com')
  const phone = ['138', '0013', '8000'].join('')
  const hits = scanText(`contact=${email} phone=${phone}`)
  assert.ok(hits.includes('personal email address'))
  assert.ok(hits.includes('possible personal phone number'))
  assert.ok(!JSON.stringify(hits).includes(email))
  assert.ok(!JSON.stringify(hits).includes(phone))
})

test('the release rejects private media, nested archives and environment files', () => {
  const files = ['sample.wav', 'backup.zip', '.env.local'].map((rel) => ({
    rel: `pkg/${rel}`,
    inline: Buffer.from(''),
  }))
  const problems = scanFiles(files, { strict: true })
  assert.equal(problems.length, files.length)
  assert.ok(problems.every((p) => p.hits.includes('private or opaque file type')))
})

test('runtime data files are refused by name', () => {
  const problems = scanFiles([{ rel: 'pkg/secrets.json', inline: Buffer.from('{}') }])
  assert.deepEqual(problems, [{ rel: 'pkg/secrets.json', hits: ['runtime data file'] }])
})

test('ordinary prose is not mistaken for a secret', () => {
  assert.deepEqual(scanText('the key is configured in the panel, never echoed'), [])
  assert.deepEqual(scanText('Authorization: Bearer <token>'), [])
})
