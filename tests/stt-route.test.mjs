import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The seam the unit tests cannot see: the real daemon, the real binary upload
 * path, and a real multipart request to the configured endpoint.
 *
 * Everything here stays on loopback: the "speech API" is a fixture server, so
 * this test proves the wiring without needing a key or network access.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DAEMON = path.join(ROOT, 'bin', 'amadeus-daemon.mjs')

function fixtureServer() {
  const state = { calls: 0, headers: null, body: '' }
  const server = http.createServer((req, res) => {
    state.calls += 1
    state.headers = req.headers
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      state.body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '集成测试转写' }))
    })
  })
  return { server, state }
}

async function waitFor(cond, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await cond()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

test('the daemon forwards recorded audio and returns the transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-stt-'))
  const { server, state } = fixtureServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const child = spawn(process.execPath, [DAEMON], {
    cwd: ROOT,
    env: {
      ...process.env,
      AMADEUS_DATA_DIR: path.join(dir, 'data'),
      AMADEUS_CACHE_DIR: path.join(dir, 'cache'),
      // A self-hosted endpoint: this is also how a local whisper server is used.
      AMADEUS_OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AMADEUS_LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  })

  try {
    const daemonFile = path.join(dir, 'data', 'runtime', 'daemon.json')
    const info = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(daemonFile, 'utf8'))
      } catch {
        return null
      }
    })
    const base = `http://127.0.0.1:${info.port}`
    const auth = { Authorization: `Bearer ${info.token}` }
    const json = { ...auth, 'Content-Type': 'application/json' }

    // The route must be behind the same guard as everything else.
    const unauthenticated = await fetch(`${base}/amadeus/stt`, { method: 'POST', body: 'x' })
    assert.equal(unauthenticated.status, 401)

    // The native Windows recognizer runs in the panel, not in this HTTP route.
    const asNative = await fetch(`${base}/amadeus/stt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'audio/webm' },
      body: Buffer.alloc(1024, 3),
    })
    assert.equal(asNative.status, 409)
    assert.equal((await asNative.json()).degrade, 'use-native-panel')
    assert.equal(state.calls, 0, 'the native channel must not reach upstream')

    const patched = await (
      await fetch(`${base}/amadeus/config`, {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ patch: { speechInput: { provider: 'api' } } }),
      })
    ).json()
    assert.deepEqual(patched.rejected, [])
    assert.equal(patched.config.speechInput.provider, 'api')

    const status = await (await fetch(`${base}/amadeus/status`, { headers: auth })).json()
    assert.equal(status.speechInput.provider, 'api')
    assert.equal(status.speechInput.ready, true, 'a self-hosted endpoint needs no key')

    const audio = Buffer.from('录音字节-audio-bytes')
    const res = await fetch(`${base}/amadeus/stt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'audio/webm;codecs=opus' },
      body: audio,
    })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.text, '集成测试转写')
    assert.equal(out.bytes, audio.length)

    assert.equal(state.calls, 1)
    assert.match(state.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.equal(state.headers.authorization, undefined)
    assert.ok(state.body.includes('name="file"'))
    assert.ok(state.body.includes('filename="audio.webm"'), 'mime must pick the extension')
    assert.ok(state.body.includes('whisper-1'))
    assert.ok(state.body.includes('name="language"'))
    assert.ok(state.body.includes('录音字节-audio-bytes'), 'the recording must arrive intact')

    // Oversized uploads get a readable status, not a dropped connection.
    const tooBig = await fetch(`${base}/amadeus/stt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'audio/webm' },
      body: Buffer.alloc(9 * 1024 * 1024, 1),
    }).catch((e) => ({ status: 0, error: e.message }))
    assert.equal(tooBig.status, 413, `expected 413, got ${tooBig.status} ${tooBig.error || ''}`)

    // ...and the daemon is still serving afterwards.
    const health = await (await fetch(`${base}/amadeus/health`, { headers: auth })).json()
    assert.equal(health.ok, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await exited
    }
    await new Promise((r) => server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
