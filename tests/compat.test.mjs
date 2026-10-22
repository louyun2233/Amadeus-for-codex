import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Inter-module contract checks.
 *
 * Two of the bugs found in this project were pure interface mismatches that no
 * single module could catch on its own:
 *   - parseReply() returns {ja, zh} while the scheduler read {jp, cn}
 *   - the installer read UTF-8 files as ANSI on Windows PowerShell 5.1
 *
 * These tests walk the actual seams between modules: config keys, MCP tool
 * names vs skill docs, panel HTTP paths vs daemon routes, SSE event names,
 * enums, secret names and memory namespaces.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function walk(dir, filter = /\.(mjs|js)$/, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (/node_modules|vendor|\.git/.test(rel)) continue
      walk(rel, filter, out)
    } else if (filter.test(entry.name)) out.push(rel)
  }
  return out
}

const CODE = [...walk('src'), ...walk('bin'), ...walk('scripts')]
const SKILLS = walk('skills', /\.md$/)

function flattenKeys(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out)
    else out[key] = v
  }
  return out
}

const defaults = new Set(Object.keys(flattenKeys(JSON.parse(read('config/defaults.json')))))
const schemaKeys = new Set(
  [...read('src/core/config.mjs').matchAll(/^\s*(?:'([a-zA-Z][\w.]*)'|([a-zA-Z][\w.]*)):\s*(?:NUM|\(|\(v\))/gm)].map(
    (m) => m[1] || m[2],
  ),
)

test('every config key the code reads has a default and is settable', () => {
  const reads = new Set()
  for (const file of CODE) {
    for (const m of read(file).matchAll(/getPath\(\s*['"]([^'"]+)['"]/g)) reads.add(m[1])
  }
  assert.ok(reads.size > 5, 'expected the code to read several config keys')
  const noDefault = [...reads].filter((k) => !defaults.has(k)).sort()
  const notSettable = [...reads].filter((k) => !schemaKeys.has(k)).sort()
  assert.deepEqual(noDefault, [], `read but never defaulted: ${noDefault.join(', ')}`)
  assert.deepEqual(notSettable, [], `read but rejected by the config whitelist: ${notSettable.join(', ')}`)
})

test('every default config key is settable (no dead config)', () => {
  const dead = [...defaults].filter((k) => !schemaKeys.has(k)).sort()
  assert.deepEqual(dead, [], `defaults advertise keys nobody can set: ${dead.join(', ')}`)
})

test('every panel write path exists in the config whitelist', () => {
  const views = read('src/panel/views.js')
  const paths = new Set(
    [...views.matchAll(/patch\(\{\s*([a-zA-Z]+):\s*\{\s*([a-zA-Z]+):/g)].map((m) => `${m[1]}.${m[2]}`),
  )
  assert.ok(paths.size >= 8, 'expected the settings page to patch several keys')
  const bad = [...paths].filter((k) => !schemaKeys.has(k)).sort()
  assert.deepEqual(bad, [], `the panel would get these rejected: ${bad.join(', ')}`)
})

const mcpSource = read('bin/amadeus-mcp.mjs')
const toolNames = new Set([...mcpSource.matchAll(/name:\s*'(amadeus_[a-z_]+)'/g)].map((m) => m[1]))

test('every MCP tool referenced by a skill actually exists', () => {
  const referenced = new Set()
  for (const file of SKILLS) {
    for (const m of read(file).matchAll(/\b(amadeus_[a-z_]+)\b/g)) referenced.add(m[1])
  }
  assert.ok(referenced.size > 5, 'expected the skills to reference the tool surface')
  const undefinedTools = [...referenced].filter((t) => !toolNames.has(t)).sort()
  assert.deepEqual(undefinedTools, [], `skills point at tools that do not exist: ${undefinedTools.join(', ')}`)
})

test('every MCP tool is discoverable from at least one skill', () => {
  const referenced = new Set()
  for (const file of SKILLS) {
    for (const m of read(file).matchAll(/\b(amadeus_[a-z_]+)\b/g)) referenced.add(m[1])
  }
  const undocumented = [...toolNames].filter((t) => !referenced.has(t)).sort()
  assert.deepEqual(undocumented, [], `tools the model has no guidance for: ${undocumented.join(', ')}`)
})

const daemonSource = [
  read('src/host/daemon.mjs'),
  ...walk('src/host', /-routes\.mjs$/).map(read),
].join('\n')
const routePaths = new Set(
  [...daemonSource.matchAll(/'[A-Z]+ (\/(?:amadeus|internal)\/[^']*)'/g)].map((m) => m[1]),
)

test('every panel API path maps to a daemon route', () => {
  const panelPaths = new Set()
  for (const file of walk('src/panel')) {
    for (const m of read(file).matchAll(/['"`](\/amadeus\/[A-Za-z0-9/_${}.:-]*)['"`]/g)) {
      panelPaths.add(m[1])
    }
  }
  assert.ok(panelPaths.size > 8, 'expected the panel to call several endpoints')
  const orphan = [...panelPaths]
    .filter((p) => {
      const clean = p.split('?')[0]
      if (clean === '/amadeus/events') return false // SSE, handled inline
      if (clean.endsWith('/')) return false // dynamic session prefix
      if (/^\/amadeus\/(panel|assets)\//.test(clean)) return false // static
      return !routePaths.has(clean)
    })
    .sort()
  assert.deepEqual(orphan, [], `panel calls endpoints the daemon does not serve: ${orphan.join(', ')}`)
})

test('SSE event names are identical on both sides', () => {
  const emitted = new Set()
  // Every way the daemon can address a client. If a new helper appears, this
  // test fails loudly as "listened but never emitted" - which is the prompt to
  // add the pattern here rather than let the contract silently rot.
  const emitPatterns = [
    /broadcast\(\s*'([^']+)'/g,
    /sendToOrigin\([^,]+,\s*'([^']+)'/g,
    /(?<!Origin)sendTo\([^,]+,\s*'([^']+)'/g,
    /#send\([^,]+,\s*'([^']+)'/g,
  ]
  for (const file of CODE) {
    const src = read(file)
    for (const pattern of emitPatterns) {
      for (const m of src.matchAll(pattern)) emitted.add(m[1])
    }
  }

  const transport = read('src/panel/transport.js')
  const block = transport.match(/const EVENTS = \[([\s\S]*?)\]/)
  assert.ok(block, 'transport.js must declare the event list')
  const listened = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))

  assert.deepEqual(
    [...listened].filter((e) => !emitted.has(e)).sort(),
    [],
    'the panel listens for events nothing emits',
  )
  assert.deepEqual(
    [...emitted].filter((e) => !listened.has(e)).sort(),
    [],
    'the daemon emits events the panel ignores',
  )
})

test('emotion names agree across core, registry and the placeholder', () => {
  const emotions = new Set(
    [...read('src/core/emotion.mjs').matchAll(/^\s*'([a-z_]+)',?$/gm)].map((m) => m[1]),
  )
  assert.ok(emotions.size >= 15)

  const registry = JSON.parse(read('config/assets.registry.json'))
  const pack = registry.packs.find((p) => p.kind === 'model')
  const mapped = new Set(Object.values(pack.expressionMap).flat())
  const tinted = new Set(
    [...read('src/panel/placeholder.js').matchAll(/^\s*([a-z_]+):\s*'#/gm)].map((m) => m[1]),
  )

  assert.deepEqual([...mapped].filter((e) => !emotions.has(e)).sort(), [], 'registry maps unknown emotions')
  assert.deepEqual([...tinted].filter((e) => !emotions.has(e)).sort(), [], 'placeholder tints unknown emotions')
})

test('every secret name used is a known secret', () => {
  const known = new Set(
    [...read('src/core/secrets.mjs').matchAll(/^\s*'([a-zA-Z_]+)',?$/gm)].map((m) => m[1]),
  )
  const used = new Set()
  for (const file of CODE) {
    // scope to the secret store: a bare get('text') is a URL param, not a secret
    for (const m of read(file).matchAll(/(?:secrets|secretStore)\??\.get\(\s*'([a-zA-Z_]+)'/g)) {
      used.add(m[1])
    }
    for (const m of read(file).matchAll(/secretName\s*=\s*'([a-zA-Z_]+)'/g)) used.add(m[1])
  }
  const unknown = [...used].filter((s) => !known.has(s)).sort()
  assert.deepEqual(unknown, [], `code asks for secrets the store rejects: ${unknown.join(', ')}`)
})

test('memory namespaces used are declared', () => {
  const declared = new Set(
    [...read('src/core/memory.mjs').matchAll(/NAMESPACES = \[([^\]]+)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    ),
  )
  const used = new Set()
  for (const file of CODE) {
    for (const m of read(file).matchAll(/memory\.(?:add|clear|list|search)\('([a-z]+)'/g)) used.add(m[1])
  }
  const unknown = [...used].filter((n) => !declared.has(n)).sort()
  assert.deepEqual(unknown, [], `unknown memory namespaces: ${unknown.join(', ')}`)
})

test('the TTS word-timing header name matches on both sides', () => {
  assert.ok(daemonSource.includes("'X-Amadeus-Words'"), 'daemon must set the header')
  assert.ok(
    read('src/panel/audio-queue.js').includes("get('X-Amadeus-Words')"),
    'panel must read the same header',
  )
})

test('every CLI command is documented in its own help text', () => {
  const cli = read('bin/amadeus.mjs')
  const commands = new Set([...cli.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))
  assert.ok(commands.size >= 8, 'expected several CLI commands')
  for (const cmd of commands) {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') continue
    assert.ok(cli.includes(`  ${cmd}`), `help text does not mention "${cmd}"`)
  }
})
