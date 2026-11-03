import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
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

test('local model projects stay out of source collection and are refused if explicitly packaged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-local-model-scan-'))
  const cleanupRoot = fs.realpathSync(tmp)
  try {
    const privateDir = path.join(tmp, 'local-models', 'maintenance')
    fs.mkdirSync(privateDir, { recursive: true })
    const file = path.join(privateDir, 'private.json')
    const fakeKey = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-')
    fs.writeFileSync(file, JSON.stringify({ sample: fakeKey }))
    fs.writeFileSync(path.join(tmp, 'README.md'), 'public source')
    assert.deepEqual(collect(tmp).map((entry) => entry.rel), ['README.md'])
    const explicit = [{ rel: 'pkg/local-models/maintenance/private.json', abs: file }]
    assert.match(scanFiles(explicit)[0].hits.join(' '), /openai-style key/)
    assert.match(scanFiles(explicit, { strict: true })[0].hits.join(' '), /local-only/)
  } finally {
    assert.equal(fs.realpathSync(tmp), cleanupRoot)
    fs.rmSync(cleanupRoot, { recursive: true, force: true })
  }
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

test('only catalogued and hash-matched shared media pass the release gate', () => {
  const content = Buffer.from('approved background music fixture')
  const entry = { path: 'music/bgm10.ogg', size: content.length,
    sha256: createHash('sha256').update(content).digest('hex') }
  const catalog = { rel: 'pkg/assets/media/catalog.json', inline: Buffer.from(JSON.stringify({
    id: 'amadeus-default-media', version: '1.0.0', files: [entry],
  })) }
  const media = { rel: 'pkg/assets/media/music/bgm10.ogg', inline: content }
  assert.deepEqual(scanFiles([catalog, media], { strict: true }), [])
  const modified = { ...media, inline: Buffer.from('different music') }
  assert.match(scanFiles([catalog, modified], { strict: true })[0].hits.join(' '), /modified bundled media/)
  assert.match(scanFiles([media], { strict: true })[0].hits.join(' '), /unapproved/)
  const privateVoice = { rel: 'pkg/assets/media/music/clone.wav', inline: content }
  assert.match(scanFiles([catalog, privateVoice], { strict: true })[0].hits.join(' '), /unapproved/)
})

test('checksum digits do not hide real contact details or authorize traversal', () => {
  const digits = ['138', '0013', '8000'].join('')
  const checksum = 'a'.repeat(20) + digits + 'b'.repeat(33)
  assert.deepEqual(scanText(JSON.stringify({ sha256: checksum })), [])
  assert.ok(scanText('phone=' + digits).includes('possible personal phone number'))
  const data = Buffer.from('fixture')
  const invalid = { rel: 'pkg/assets/media/catalog.json', inline: Buffer.from(JSON.stringify({
    id: 'amadeus-default-media', version: '1.0.0', files: [{path: '../clone.mp3',
      size: data.length, sha256: createHash('sha256').update(data).digest('hex')}],
  })) }
  assert.equal(scanFiles([invalid, { rel: 'pkg/clone.mp3', inline: data }], { strict: true }).length, 1)
})

test('ordinary prose is not mistaken for a secret', () => {
  assert.deepEqual(scanText('the key is configured in the panel, never echoed'), [])
  assert.deepEqual(scanText('Authorization: Bearer <token>'), [])
})
