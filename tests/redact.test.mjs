import test from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactValue, redactJson, redactLogLine, MAX_LOG_TEXT } from '../src/core/redact.mjs'

/**
 * Learned from Code-Codex's runtime-redaction suite: a support artefact must be
 * provably free of the user's content, and a sentinel is the only way to prove
 * it. Diagnostics have to survive the same pass, otherwise the report is
 * useless and the redaction gets disabled by hand - the worst outcome.
 */

const SENTINEL = 'SENTINEL'

test('paths, urls, credentials and mail addresses never survive', () => {
  const samples = [
    `C:\\Users\\${SENTINEL}USER\\private\\file.txt`,
    `\\\\server\\${SENTINEL}SHARE\\file`,
    `/home/${SENTINEL}UNIX/file`,
    `~/${SENTINEL}HOME/file`,
    'https://user:pass@example.test/SENTINEL?token=SENTINEL',
    `sk-${SENTINEL}_1234567890`,
    `Bearer ${SENTINEL}_AUTH_TOKEN_VALUE`,
    `access_token=${SENTINEL}_QUERY`,
    `${SENTINEL}@example.com`,
  ]
  for (const sample of samples) {
    assert.ok(!redactText(sample).includes(SENTINEL), `leaked: ${sample} -> ${redactText(sample)}`)
  }
})

test('our own panel URL keeps its origin and path but loses the session token', () => {
  assert.equal(
    redactText('http://127.0.0.1:12183/amadeus/panel/index.html?token=SENTINEL#app-300x520'),
    'http://127.0.0.1:12183/amadeus/panel/index.html',
  )
})

test('diagnostics survive: codes, ports, timings, kinds', () => {
  const line = 'AM-1203 port=12183 elapsedMs=134185 kind=task-complete origin=panel broadcasted=true'
  assert.equal(redactText(line), line)
})

test('the fields Codex fills with conversation are dropped', () => {
  const payload = {
    type: 'agent-turn-complete',
    'thread-id': '01a1-SENTINEL',
    cwd: ['C:', 'Users', SENTINEL, 'project'].join('\\'),
    client: 'codex_exec',
    'input-messages': ['my SENTINEL secret question'],
    'last-assistant-message': 'SENTINEL answer',
    token: 'SENTINEL_TOKEN',
    port: 12183,
  }
  const redacted = redactValue(payload)
  assert.ok(!JSON.stringify(redacted).includes(SENTINEL), JSON.stringify(redacted))
  assert.equal(redacted.type, 'agent-turn-complete')
  assert.equal(redacted.client, 'codex_exec')
  assert.equal(redacted.port, 12183)
  assert.equal(redacted.cwd, '[redacted]')
  assert.equal(redacted['input-messages'], '[redacted]')
})

test('exotic input cannot break or bypass the redactor', () => {
  const cycle = { name: 'SENTINEL' }
  cycle.self = cycle
  assert.doesNotThrow(() => redactJson(cycle))
  assert.doesNotThrow(() => redactValue({ big: 3n }))
  const getter = {
    get boom() {
      throw new Error('SENTINEL')
    },
  }
  assert.doesNotThrow(() => redactJson(getter))
  assert.equal(redactText(undefined), '')
  assert.equal(redactText(null), '')
})

test('output is bounded', () => {
  const huge = 'あ'.repeat(50000)
  const out = redactText(huge)
  assert.ok(out.length <= MAX_LOG_TEXT + ' [truncated]'.length)
})

test('a nested structure is bounded in width and depth', () => {
  let deep = 'SENTINEL'
  for (let i = 0; i < 30; i += 1) deep = { child: deep }
  const wide = Array.from({ length: 5000 }, (_, i) => i)
  const out = redactValue({ deep, wide })
  assert.ok(JSON.stringify(out).length < 20000)
})

/**
 * Log lines written before redaction existed wrapped Codex's payload in a JSON
 * *string*, so plain text redaction walked right past the prompt. The support
 * report has to be safe even against yesterday's file.
 */
test('a legacy log line with the payload inside a string is redacted too', () => {
  const payload = {
    type: 'agent-turn-complete',
    'thread-id': 'SENTINEL-THREAD',
    cwd: ['C:', 'Users', SENTINEL, 'runtime', 'chatcwd'].join('\\'),
    client: 'codex_exec',
    'input-messages': ['my SENTINEL prompt'],
    'last-assistant-message': 'SENTINEL reply',
  }
  const legacy = `[2026-10-16T15:52:40.502Z] argv=${JSON.stringify(['turn-ended', JSON.stringify(payload)])} kind=task-complete type=agent-turn-complete origin=panel`
  const out = redactLogLine(legacy)
  assert.ok(!out.includes('SENTINEL'), out)
  assert.ok(out.includes('kind=task-complete'))
  assert.ok(out.includes('type=agent-turn-complete'))
  assert.ok(out.includes('origin=panel'))
  assert.ok(out.includes('codex_exec'), 'the client name is diagnostic, not private')
})

test('a line that is not an argv payload still gets text redaction', () => {
  assert.equal(
    redactLogLine(`[watch] opened ${['C:', 'Users', SENTINEL, 'panel-profile'].join('\\')}`),
    '[watch] opened [path]',
  )
})

