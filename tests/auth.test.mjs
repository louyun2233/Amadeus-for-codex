import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, isLoopback } from '../src/host/auth.mjs'

function req({ address = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: address, localPort: 1 }, headers: {host:'127.0.0.1:1', ...headers} }
}

const url = (u) => new URL(u, 'http://127.0.0.1:1')

test('loopback detection', () => {
  assert.equal(isLoopback(req()), true)
  assert.equal(isLoopback(req({ address: '192.168.1.20' })), false)
})

test('bearer token authenticates', () => {
  const auth = createAuth('secret-token')
  const result = auth.check(req({ headers: { authorization: 'Bearer secret-token' } }), url('/x'))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'bearer')
})

test('wrong or missing token is rejected', () => {
  const auth = createAuth('secret-token')
  assert.equal(auth.check(req(), url('/x')).ok, false)
  assert.equal(auth.check(req({ headers: { authorization: 'Bearer nope' } }), url('/x')).status, 401)
})

test('non-loopback is forbidden even with a token', () => {
  const auth = createAuth('secret-token')
  const result = auth.check(
    req({ address: '10.0.0.5', headers: { authorization: 'Bearer secret-token' } }),
    url('/x'),
  )
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
})

test('query token cannot authenticate or exchange a cookie', () => {
  const auth = createAuth('secret-token')
  const exchanged = auth.check(req(), url('/amadeus/panel/index.html?token=secret-token'))
  assert.equal(exchanged.status, 401)
  assert.equal(exchanged.sessionId, undefined)
})

test('browser origins and rebinding hosts fail even with the bearer', () => {
  const auth=createAuth('secret-token')
  for(const headers of [
    {host:'attacker.example:1'}, {host:'127.0.0.1:2'}, {host:['127.0.0.1:1', 'attacker.example'].join('@')},
    {origin:'https://attacker.example'}, {origin:'null'}, {'sec-fetch-site':'cross-site'},
  ]) {
    assert.equal(auth.check(req({headers:{authorization:'Bearer secret-token',...headers}}),url('/x')).status,403)
  }
  assert.equal(isLoopback(req({address:''})),false)
  assert.equal(auth.check(req({headers:{authorization:'Bearer secret-token'}}),url('/x?token=secret-token')).ok,false)
})

test('unknown cookie session is rejected', () => {
  const auth = createAuth('secret-token')
  const result = auth.check(req({ headers: { cookie: 'amadeus_session=deadbeef' } }), url('/x'))
  assert.equal(result.ok, false)
})
