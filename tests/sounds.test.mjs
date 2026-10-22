import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureIncomingRing, mediaEffectPath, contentTypeFor, ringCandidates } from '../src/core/sounds.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * The call ring is imported from the OS once and then served from our own data
 * directory, so the panel keeps working when the sound pack changes - and never
 * serves a path the caller picked.
 */

function fakeWindir(bytes = 8192) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-windir-'))
  const media = path.join(root, 'Media')
  fs.mkdirSync(media, { recursive: true })
  fs.writeFileSync(path.join(media, 'Windows Notify Email.wav'), Buffer.alloc(bytes, 7))
  return root
}

test('the mail notification sound is imported once and reused', () => {
  const paths = tempPaths()
  const windir = fakeWindir()
  try {
    let copies = 0
    const first = ensureIncomingRing(paths, {
      env: { WINDIR: windir },
      copyFile: (from, to) => {
        copies += 1
        fs.copyFileSync(from, to)
      },
    })
    assert.equal(first.ok, true)
    assert.equal(first.source, 'system')
    assert.equal(first.bytes, 8192)
    assert.equal(copies, 1)
    assert.ok(first.path.endsWith(path.join('sounds', 'system-incoming.wav')))

    const second = ensureIncomingRing(paths, {
      env: { WINDIR: windir },
      copyFile: () => {
        throw new Error('must not copy twice')
      },
    })
    assert.equal(second.ok, true)
    assert.equal(second.bytes, 8192)
  } finally {
    cleanup(paths)
    fs.rmSync(windir, { recursive: true, force: true })
  }
})

test('a sound the user drops in wins over the system one', () => {
  const paths = tempPaths()
  const windir = fakeWindir()
  try {
    const dir = path.join(paths.dataRoot, 'sounds')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'incoming.mp3'), Buffer.alloc(5000, 1))
    const ring = ensureIncomingRing(paths, { env: { WINDIR: windir } })
    assert.equal(ring.source, 'user')
    assert.ok(ring.path.endsWith('incoming.mp3'))
    assert.equal(ring.bytes, 5000)
  } finally {
    cleanup(paths)
    fs.rmSync(windir, { recursive: true, force: true })
  }
})

test('a missing or unusable source degrades to "no ring" instead of throwing', () => {
  const paths = tempPaths()
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-empty-'))
  try {
    const missing = ensureIncomingRing(paths, { env: { WINDIR: empty } })
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'no-ring-source')
    assert.equal(missing.path, null)

    // A stub file is refused: a 200-byte "sound" would ring as a click.
    const tiny = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-tiny-'))
    fs.mkdirSync(path.join(tiny, 'Media'), { recursive: true })
    fs.writeFileSync(path.join(tiny, 'Media', 'Windows Notify Email.wav'), Buffer.alloc(200, 1))
    try {
      assert.equal(ensureIncomingRing(paths, { env: { WINDIR: tiny } }).ok, false)
    } finally {
      fs.rmSync(tiny, { recursive: true, force: true })
    }
  } finally {
    cleanup(paths)
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('the content type follows the file, and the candidates are absolute', () => {
  assert.equal(contentTypeFor('C:\\x\\incoming.wav'), 'audio/wav')
  assert.equal(contentTypeFor('/x/incoming.mp3'), 'audio/mpeg')
  assert.equal(contentTypeFor('/x/incoming.ogg'), 'audio/ogg')
  assert.equal(contentTypeFor('/x/incoming.m4a'), 'audio/mp4')
  const candidates = ringCandidates({ WINDIR: 'D:\\Win' })
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((c) => path.isAbsolute(c)))
  assert.ok(candidates[0].includes(path.join('Media', 'Windows Notify Email.wav')))
})

test('legacy media effects cannot play an un-cloned voice clip', () => {
  const paths = tempPaths()
  try {
    const dir = path.join(paths.dataRoot, 'sounds', 'kurisu-media')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '默认响声.WAV')
    fs.writeFileSync(file, Buffer.alloc(5000, 7))
    assert.equal(mediaEffectPath(paths, 'tap_body_0'), null)
    assert.equal(mediaEffectPath(paths, 'tap_body_1'), null)
    assert.equal(mediaEffectPath(paths, 'broadcast'), null)
    assert.equal(mediaEffectPath(paths, '../config.json'), null)
    assert.equal(mediaEffectPath(paths, 'constructor'), null)
  } finally {
    cleanup(paths)
  }
})
