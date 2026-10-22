import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { AssetManager, assertAllowedUrl, sha256File } from '../src/core/assets.mjs'
import { tempPaths, cleanup, makeTarGz } from './helpers.mjs'

const MODEL_JSON = JSON.stringify({
  type: 'Live2D Model Setting',
  name: 'kurisu',
  model: 'shizuku.moc',
  textures: ['shizuku.1024/texture_00.png'],
  expressions: [
    { name: 'f01', file: 'expressions/f01.exp.json' },
    { name: 'f02', file: 'expressions/f02.exp.json' },
    { name: 'f03', file: 'expressions/f03.exp.json' },
    { name: 'f04', file: 'expressions/f04.exp.json' },
  ],
  hit_areas: [
    { name: 'head', id: 'D_REF.HEAD' },
    { name: 'mouth', id: 'D_REF.MOUTH' },
    { name: 'body', id: 'D_REF.BODY' },
  ],
  motions: { idle: [{ file: 'motions/idle_00.mtn' }] },
})

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
}

/** Serves fixture files over loopback http and counts requests per path. */
async function startServer(files) {
  const hits = new Map()
  const server = http.createServer((req, res) => {
    const key = req.url.split('?')[0]
    hits.set(key, (hits.get(key) || 0) + 1)
    const body = files[key]
    if (!body) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, hits, close: () => new Promise((r) => server.close(r)) }
}

function writeRegistry(dir, packs) {
  const file = path.join(dir, 'registry.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, packs }, null, 2))
  return file
}

function tarFixture() {
  return makeTarGz([
    { name: 'kurisu/', type: 'dir' },
    { name: 'kurisu/kurisu.model.json', data: MODEL_JSON },
    { name: 'kurisu/shizuku.moc', data: 'MOCDATA' },
    { name: 'kurisu/shizuku.1024/texture_00.png', data: 'PNGDATA' },
    { name: 'kurisu/expressions/f01.exp.json', data: '{}' },
    { name: 'kurisu/motions/idle_00.mtn', data: 'MTN' },
  ])
}

function runtimeFixture() {
  return Buffer.from('/* fake cubism2 runtime */\n', 'utf8')
}

async function setup({ modelSources, runtimeSources, modelBody, runtimeBody, corruptModel = false } = {}) {
  const paths = tempPaths()
  const tarBuf = modelBody || tarFixture()
  const jsBuf = runtimeBody || runtimeFixture()
  const served = { '/kurisu.tar.gz': tarBuf, '/live2d.min.js': jsBuf }
  const srv = await startServer(served)
  const base = `http://127.0.0.1:${srv.port}`
  const packs = [
    {
      id: 'kurisu-model',
      kind: 'model',
      character: 'kurisu',
      version: 'test-1',
      engine: 'cubism2',
      format: 'tar.gz',
      sizeBytes: tarBuf.length,
      sha256: corruptModel ? sha256(Buffer.from('other')) : sha256(tarBuf),
      stripRoot: 'kurisu',
      entry: 'kurisu.model.json',
      sources: modelSources || [`${base}/kurisu.tar.gz`],
    },
    {
      id: 'cubism2-runtime',
      kind: 'runtime',
      engine: 'cubism2',
      version: 'test-1',
      format: 'js',
      sizeBytes: jsBuf.length,
      sha256: sha256(jsBuf),
      target: 'live2d.min.js',
      sources: runtimeSources || [`${base}/live2d.min.js`],
    },
  ]
  const registryFile = writeRegistry(paths.dataRoot, packs)
  const manager = new AssetManager({ paths, config: null, audit: null, hub: null, registryFile })
  return { paths, srv, manager, base, tarBuf, jsBuf }
}

test('assertAllowedUrl permits https and loopback http only', () => {
  assert.ok(assertAllowedUrl('https://example.com/a.tar.gz'))
  assert.ok(assertAllowedUrl('http://127.0.0.1:8080/a.tar.gz'))
  assert.ok(assertAllowedUrl('http://localhost:8080/a'))
  assert.throws(() => assertAllowedUrl('http://evil.example.com/a'), /refusing insecure/)
  assert.throws(() => assertAllowedUrl('file:///etc/passwd'), /refusing insecure/)
  assert.throws(() => assertAllowedUrl('not a url'), /invalid source url/)
})

test('installs a model pack: extraction, manifest, atomic switch', async () => {
  const { paths, srv, manager } = await setup()
  try {
    const result = await manager.install('kurisu-model')
    assert.equal(result.ok, true)
    assert.equal(result.installed, true)

    const manifest = JSON.parse(fs.readFileSync(path.join(paths.modelsDir, 'kurisu', 'manifest.json'), 'utf8'))
    assert.equal(manifest.current, 'test-1')
    assert.equal(manifest.entry, 'kurisu.model.json')

    const versionDir = path.join(paths.modelsDir, 'kurisu', 'versions', 'test-1')
    assert.ok(fs.existsSync(path.join(versionDir, 'kurisu.model.json')))
    assert.ok(fs.existsSync(path.join(versionDir, 'shizuku.moc')))
    assert.ok(fs.existsSync(path.join(versionDir, 'expressions', 'f01.exp.json')))

    const status = manager.status()
    assert.equal(status.packs.find((p) => p.kind === 'model').installed, true)
    assert.equal(status.degrade, 'missing-cubism2-runtime')
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('a source-defined character uses its own model entry and cache namespace', async () => {
  const modelJson = JSON.stringify({ model: 'avatar.moc', textures: ['avatar.png'] })
  const archive = makeTarGz([
    { name: 'example/', type: 'dir' },
    { name: 'example/avatar.model.json', data: modelJson },
    { name: 'example/avatar.moc', data: 'MOC' },
    { name: 'example/avatar.png', data: 'PNG' },
  ])
  const { paths, srv } = await setup({ modelBody: archive })
  try {
    const registryFile = path.join(paths.dataRoot, 'registry.json')
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    Object.assign(registry.packs[0], {
      id: 'example-model', character: 'example', stripRoot: 'example', entry: 'avatar.model.json',
    })
    fs.writeFileSync(registryFile, JSON.stringify(registry))
    const manager = new AssetManager({
      paths, config: { getPath: (key) => key === 'character' ? 'example' : null },
      audit: null, hub: null, registryFile,
    })
    await manager.install('example-model')
    assert.equal(manager.status().activeModel.entryName, 'avatar.model.json')
    assert.equal(manager.status().activeModel.character, 'example')
    assert.ok(manager.resolveCurrent('avatar.model.json')?.endsWith('avatar.model.json'))
    assert.equal(manager.verify().ok, false) // runtime is deliberately not installed
    manager.config = { getPath: () => 'another' }
    assert.equal(manager.status().activeModel, null)
    assert.equal(manager.resolveCurrent('avatar.model.json'), null)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('installs a runtime pack and verifies its hash', async () => {
  const { paths, srv, manager, jsBuf } = await setup()
  try {
    const result = await manager.install('cubism2-runtime')
    assert.equal(result.ok, true)
    assert.equal(result.matches, true)
    assert.equal(sha256File(path.join(paths.runtimeCacheDir, 'cubism2', 'live2d.min.js')), sha256(jsBuf))
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('a checksum mismatch aborts the install and leaves nothing behind', async () => {
  const { paths, srv, manager } = await setup({ corruptModel: true })
  try {
    await assert.rejects(() => manager.install('kurisu-model'), /all sources failed/)
    assert.equal(fs.existsSync(path.join(paths.modelsDir, 'kurisu', 'manifest.json')), false)
    assert.equal(fs.existsSync(path.join(paths.modelsDir, 'kurisu', 'versions', 'test-1')), false)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('falls back to the next source when the first one fails', async () => {
  const { paths, srv, manager } = await setup({
    modelSources: ['http://127.0.0.1:9/definitely-down.tar.gz', `${'http://127.0.0.1'}/x`],
  })
  // rebuild the second source with the live port
  const base = `http://127.0.0.1:${srv.port}`
  const packs = JSON.parse(fs.readFileSync(path.join(paths.dataRoot, 'registry.json'), 'utf8'))
  packs.packs[0].sources = ['http://127.0.0.1:9/definitely-down.tar.gz', `${base}/kurisu.tar.gz`]
  fs.writeFileSync(path.join(paths.dataRoot, 'registry.json'), JSON.stringify(packs))
  const fresh = new AssetManager({
    paths,
    config: null,
    audit: null,
    hub: null,
    registryFile: path.join(paths.dataRoot, 'registry.json'),
  })
  try {
    const result = await fresh.install('kurisu-model')
    assert.equal(result.ok, true)
    assert.equal(srv.hits.get('/kurisu.tar.gz'), 1)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('the download cache is reused across installs', async () => {
  const { paths, srv, manager } = await setup()
  try {
    await manager.install('cubism2-runtime')
    await manager.install('cubism2-runtime')
    assert.equal(srv.hits.get('/live2d.min.js'), 1)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('concurrent installs of the same pack are de-duplicated', async () => {
  const { paths, srv, manager } = await setup()
  try {
    const [a, b] = await Promise.all([
      manager.install('kurisu-model'),
      manager.install('kurisu-model'),
    ])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(srv.hits.get('/kurisu.tar.gz'), 1)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('resolveCurrent refuses traversal and unknown files', async () => {
  const { paths, srv, manager } = await setup()
  try {
    await manager.install('kurisu-model')
    assert.ok(manager.resolveCurrent('kurisu.model.json'))
    assert.equal(manager.resolveCurrent('../../package.json'), null)
    assert.equal(manager.resolveCurrent('nope.txt'), null)
    assert.equal(manager.resolveCurrent('shizuku.moc'), path.join(paths.modelsDir, 'kurisu', 'versions', 'test-1', 'shizuku.moc'))
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('installFromFile accepts a verified local archive and rejects a wrong one', async () => {
  const { paths, srv, manager, tarBuf } = await setup()
  const local = path.join(paths.dataRoot, 'local-kurisu.tar.gz')
  try {
    fs.writeFileSync(local, tarBuf)
    const result = await manager.installFromFile('kurisu-model', local)
    assert.equal(result.ok, true)
    assert.ok(manager.status().packs.find((p) => p.kind === 'model').installed)

    fs.writeFileSync(local, Buffer.from('not the archive'))
    await assert.rejects(() => manager.installFromFile('kurisu-model', local), /checksum mismatch/)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('verify reports problems when nothing is installed', async () => {
  const { paths, srv, manager } = await setup()
  try {
    const report = manager.verify()
    assert.equal(report.ok, false)
    assert.equal(report.problems.length, 2)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})

test('installAll installs both packs end to end', async () => {
  const { paths, srv, manager } = await setup()
  try {
    const result = await manager.installAll()
    assert.equal(result.ok, true)
    assert.equal(result.status.ready, true)
    assert.equal(manager.verify().ok, true)
  } finally {
    await srv.close()
    cleanup(paths)
  }
})
