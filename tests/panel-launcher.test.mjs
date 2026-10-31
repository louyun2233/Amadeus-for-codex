import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { panelAnswers, launchInFlight, nativeWindowArgs } from '../src/host/panel-launcher.mjs'
import { tempPaths, cleanup } from './helpers.mjs'

function server(handler) {
  const srv = http.createServer(handler)
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })))
}

test('native host receives the token over stdin instead of process arguments', () => {
  assert.deepEqual(nativeWindowArgs(), ['--panel-stdin'])
  const source = fs.readFileSync(new URL('../scripts/launcher.cs', import.meta.url), 'utf8')
  assert.match(source, /Console\.In\.ReadLine\(\)/)
  assert.match(source, /target\.Host != "127\.0\.0\.1"/)
  assert.doesNotMatch(source, /WebView|Edge|Chrome/)
})

test('native launcher checks the authenticated health endpoint', async () => {
  const { srv, port } = await server((req, res) => {
    if (req.url !== '/amadeus/health' || req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401).end()
      return
    }
    res.writeHead(200).end('{}')
  })
  try {
    assert.equal(await panelAnswers({ port, token: 'tok' }), true)
    assert.equal(await panelAnswers({ port, token: 'wrong' }), false)
  } finally {
    srv.close()
  }
})

test('a dead port is not opened as a panel', async () => {
  const { srv, port } = await server((_req, res) => res.end('x'))
  await new Promise((done) => srv.close(done))
  assert.equal(await panelAnswers({ port, token: 'tok' }), false)
})

test('concurrent launch attempts share a cooldown long enough for a cold native panel', () => {
  const paths = tempPaths()
  try {
    assert.equal(launchInFlight(paths), false)
    const lock = path.join(paths.runtimeDir, 'panel-launch.lock')
    fs.writeFileSync(lock, 'x')
    assert.equal(launchInFlight(paths), true)
    assert.equal(launchInFlight(paths, { now: Date.now() + 20_000 }), true)
    assert.equal(launchInFlight(paths, { now: Date.now() + 60_000 }), false)
  } finally {
    cleanup(paths)
  }
})
