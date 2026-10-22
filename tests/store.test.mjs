import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../src/core/store.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * A durable write has to survive environments that refuse renames.
 *
 * On this machine `%LOCALAPPDATA%` is EFS-encrypted and a rename *inside one
 * directory* fails with EXDEV, which used to make every session/memory/config
 * write return 500. The fallback and the read-side quarantine are what keep the
 * companion usable there, so both are pinned here.
 */

function tempDir() {
  const paths = tempPaths()
  return { paths, dir: paths.memoryDir }
}

test('a normal write is atomic and leaves no temp file behind', () => {
  const { paths, dir } = tempDir()
  try {
    const file = path.join(dir, 'one.json')
    writeJsonAtomic(file, { a: 1 })
    assert.deepEqual(readJson(file, null), { a: 1 })
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes('.tmp')),
      [],
    )
  } finally {
    cleanup(paths)
  }
})

test('a directory that refuses renames falls back to copy writes', () => {
  const { paths, dir } = tempDir()
  try {
    const file = path.join(dir, 'session.json')
    let attempts = 0
    const renameSync = () => {
      attempts += 1
      const err = new Error('EXDEV: cross-device link not permitted')
      err.code = 'EXDEV'
      throw err
    }

    writeJsonAtomic(file, { id: 'first' }, { renameSync })
    assert.equal(attempts, 1, 'the first write tries the atomic path')
    assert.deepEqual(readJson(file, null), { id: 'first' })

    writeJsonAtomic(file, { id: 'second' }, { renameSync })
    assert.equal(attempts, 1, 'the directory is remembered, no second attempt')
    assert.deepEqual(readJson(file, null), { id: 'second' })

    const leftovers = fs.readdirSync(dir).filter((f) => f !== 'session.json')
    assert.deepEqual(leftovers, [], `no temp files may survive: ${leftovers.join(', ')}`)
  } finally {
    cleanup(paths)
  }
})

test('other rename failures still surface instead of being papered over', () => {
  const { paths, dir } = tempDir()
  try {
    const file = path.join(dir, 'denied.json')
    const renameSync = () => {
      const err = new Error('EPERM: operation not permitted')
      err.code = 'EPERM'
      throw err
    }
    assert.throws(() => writeJsonAtomic(file, { a: 1 }, { renameSync }), /EPERM/)
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes('.tmp')),
      [],
      'the temp file is cleaned up when the write fails',
    )
  } finally {
    cleanup(paths)
  }
})

test('an unreadable JSON file is quarantined and treated as empty', () => {
  const { paths, dir } = tempDir()
  try {
    const file = path.join(dir, 'torn.json')
    fs.writeFileSync(file, '{"id":"half', 'utf8')

    assert.deepEqual(readJson(file, { entries: [] }), { entries: [] })
    assert.equal(fs.existsSync(file), false, 'the torn file is moved aside')
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('torn.json.corrupt-'))
    assert.equal(kept.length, 1, 'the broken file is kept for inspection')
  } finally {
    cleanup(paths)
  }
})
