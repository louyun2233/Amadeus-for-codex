#!/usr/bin/env node
/** Check source-controlled character files, or apply their defaults to this installation. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDefaults, ConfigStore, applyPatch } from '../src/core/config.mjs'
import { loadPersona } from '../src/core/persona.mjs'
import { loadCharacterContent } from '../src/core/character.mjs'
import { resolvePaths } from '../src/shared/paths.mjs'
import { readDaemonInfo, ping } from '../src/host/daemon-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')
const defaults = loadDefaults()
const character = defaults.character
loadPersona(character)
loadCharacterContent(character)

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'assets.registry.json'), 'utf8'))
const model = registry.packs?.find((pack) => pack.kind === 'model' && pack.character === character)
const safeSegment = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const safeEntry = (value) => typeof value === 'string' && value.endsWith('.model.json') &&
  value.split('/').every((part) => safeSegment(part) && part !== '.' && part !== '..')
if (!model || model.engine !== 'cubism2' || !safeSegment(model.id) || !safeSegment(model.version) ||
    !safeSegment(model.stripRoot) || !safeEntry(model.entry) || !Number.isSafeInteger(model.sizeBytes) ||
    model.sizeBytes < 1 || !/^[a-f0-9]{64}$/i.test(model.sha256 || '') || !Array.isArray(model.sources)) {
  throw new Error('active character needs a Cubism 2 model pack and a .model.json entry')
}

const paths = resolvePaths()
const store = new ConfigStore(paths)
const sourceVoice = defaults.voice || {}
if (sourceVoice.provider === 'qwen-local' && (!sourceVoice.name || sourceVoice.name === 'Cherry')) {
  throw new Error('set voice.name to the registered local clone id in config/defaults.json')
}
if (sourceVoice.provider === 'system' && (!sourceVoice.name || sourceVoice.name === 'Cherry')) {
  throw new Error('set voice.name to an installed system voice in config/defaults.json')
}
const patch = {
  character,
  voice: Object.fromEntries(['enabled', 'provider', 'name', 'dashscopeModel', 'localModel', 'stability']
    .map((key) => [key, sourceVoice[key]])),
}
const preview = applyPatch(store.get(), patch)
if (preview.rejected.length > 0) {
  throw new Error(`invalid source defaults: ${preview.rejected.join(', ')}`)
}

if (!apply) {
  console.log('PASS  character source files and voice defaults are valid')
  console.log('Run node scripts/character-source.mjs --apply to activate them on this installation.')
} else {
  const info = readDaemonInfo(paths)
  if (info && await ping(info)) throw new Error('stop the Amadeus daemon before applying character source')
  fs.mkdirSync(paths.dataRoot, { recursive: true })
  if (fs.existsSync(paths.configFile)) {
    const backup = `${paths.configFile}.backup-character-${Date.now()}`
    fs.copyFileSync(paths.configFile, backup)
    fs.chmodSync(backup, 0o600)
  }
  store.update(patch)
  console.log('PASS  source character and voice defaults applied; restart Amadeus to use them')
}
