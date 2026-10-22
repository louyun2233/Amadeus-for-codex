import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDirs } from '../src/shared/paths.mjs'
import {
  layoutDirectories,
  ensureOwnership,
  readOwnership,
  ownershipPath,
  PRODUCT,
  LAYOUT_SCHEMA,
} from '../src/shared/layout.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

/**
 * Learned from Code-Codex's storage contract: one declaration of the layout,
 * plus an ownership marker, so a future cleanup step can prove the directory is
 * ours instead of trusting a path. No deletion lives here on purpose.
 */

test('ensureDirs creates exactly the layout and claims ownership', () => {
  const paths = tempPaths()
  try {
    ensureDirs(paths)
    for (const dir of layoutDirectories(paths)) {
      assert.ok(fs.existsSync(dir), `missing directory: ${dir}`)
    }
    const marker = readOwnership(paths)
    assert.equal(marker.product, PRODUCT)
    assert.equal(marker.schema, LAYOUT_SCHEMA)
    assert.equal(marker.dataRoot, paths.dataRoot)
    assert.ok(fs.existsSync(ownershipPath(paths)))
  } finally {
    cleanup(paths)
  }
})

test('a marker from another product or schema is not accepted', () => {
  const paths = tempPaths()
  try {
    fs.mkdirSync(paths.dataRoot, { recursive: true })
    fs.writeFileSync(ownershipPath(paths), JSON.stringify({ product: 'Somebody Else', schema: 1 }))
    assert.equal(readOwnership(paths), null)
    fs.writeFileSync(ownershipPath(paths), JSON.stringify({ product: PRODUCT, schema: 99 }))
    assert.equal(readOwnership(paths), null)
    const rewritten = ensureOwnership(paths)
    assert.equal(rewritten.schema, LAYOUT_SCHEMA)
    assert.equal(readOwnership(paths).product, PRODUCT)
  } finally {
    cleanup(paths)
  }
})

test('a corrupt marker is replaced instead of throwing', () => {
  const paths = tempPaths()
  try {
    fs.mkdirSync(paths.dataRoot, { recursive: true })
    fs.writeFileSync(ownershipPath(paths), '{ not json')
    assert.equal(readOwnership(paths), null)
    assert.doesNotThrow(() => ensureOwnership(paths))
    assert.equal(readOwnership(paths).schema, LAYOUT_SCHEMA)
  } finally {
    cleanup(paths)
  }
})

test('the layout covers the cache as well as the data directory', () => {
  const paths = tempPaths()
  try {
    const dirs = layoutDirectories(paths)
    assert.ok(dirs.includes(paths.voiceCacheDir))
    assert.ok(dirs.includes(paths.modelsDir))
    assert.ok(dirs.includes(path.join(paths.dataRoot, 'sounds')))
    assert.ok(dirs.includes(path.join(paths.dataRoot, 'diagnostics')))
  } finally {
    cleanup(paths)
  }
})
