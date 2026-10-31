import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempPaths, cleanup } from './helpers.mjs'

test('MCP opens native panels without exposing credentials and preserves memory namespaces', async () => {
  const paths = tempPaths()
  const requests = []
  const token = 'local-test-session'
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    requests.push(req.url)
    const url = new URL(req.url, 'http://127.0.0.1')
    let body = { ok: true }
    if (url.pathname === '/amadeus/status') body.events = { nativeClients: 1 }
    if (url.pathname === '/amadeus/diag') body.checks = { panelNative: { ok: true }, live2dModel: { ok: true } }
    if (url.pathname === '/amadeus/memory') body.namespace = url.searchParams.get('namespace')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fs.writeFileSync(paths.daemonFile, JSON.stringify({ port: server.address().port, token, pid: process.pid }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/amadeus-mcp.mjs', import.meta.url))], {
    env: { ...process.env, AMADEUS_DATA_DIR: paths.dataRoot, AMADEUS_CACHE_DIR: paths.cacheRoot,
      XDG_CACHE_HOME: path.join(paths.cacheRoot, 'legacy') },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const pending = new Map()
  let seq = 0
  const output = readline.createInterface({ input: child.stdout })
  output.on('line', (line) => {
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
  })
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timeout = setTimeout(() => reject(new Error('MCP response timed out')), 10_000)
    pending.set(id, (msg) => {
      clearTimeout(timeout)
      pending.delete(id)
      if (msg.result?.isError) return reject(new Error(msg.result.content[0].text))
      resolve(JSON.parse(msg.result.content[0].text))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: args } })}\n`)
  })
  try {
    const opened = await call('amadeus_open_panel')
    assert.equal(opened.status, 'already-open')
    assert.equal(opened.ok, true)
    assert.ok(!JSON.stringify(opened).includes(token))
    assert.ok(!('url' in opened))
    const capabilities = await call('amadeus_capabilities')
    assert.equal(capabilities.checks.panelNative.ok, true)
    assert.equal((await call('amadeus_recall', { query: 'preference' })).namespace, 'panel')
    assert.equal((await call('amadeus_recall', { query: 'preference', namespace: 'codex' })).namespace, 'codex')
    assert.ok(requests.includes('/amadeus/diag'))
    assert.ok(requests.every((value) => !value.includes('/panel/')))
  } finally {
    output.close()
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    await new Promise((resolve) => server.close(resolve))
    cleanup(paths)
  }
})
