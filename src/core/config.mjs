import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJsonAtomic } from './store.mjs'
import { log } from '../shared/log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULTS_FILE = path.resolve(HERE, '..', '..', 'config', 'defaults.json')

export function loadDefaults() {
  return readJson(DEFAULTS_FILE, {})
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Deep clone through a JSON round-trip; config is plain data by contract. */
function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

const NUM = (min, max) => (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : undefined

/**
 * Whitelist validator. Every accepted path declares its own type check so a
 * bad PATCH can never poison the config file.
 */
const SCHEMA = {
  character: (v) => (typeof v === 'string' && /^[a-z][a-z0-9_-]{1,39}$/.test(v) ? v : undefined),
  'panel.theme': (v) => (typeof v === 'string' && v.length <= 40 ? v : undefined),
  'panel.openOnStart': (v) => (typeof v === 'boolean' ? v : undefined),
  'panel.onboardingSeen': (v) => (typeof v === 'boolean' ? v : undefined),
  'chat.provider': (v) => (['codex-exec', 'openai-compat'].includes(v) ? v : undefined),
  'chat.model': (v) => (typeof v === 'string' && v.length <= 120 ? v : undefined),
  'chat.oneshot': (v) => (typeof v === 'boolean' ? v : undefined),
  'chat.maxTurnsKept': NUM(2, 200),
  'chat.compressThreshold': NUM(10, 500),
  'chat.keepRecent': NUM(2, 200),
  'voice.enabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'voice.provider': (v) => (['dashscope', 'qwen-local', 'edge', 'system', 'openai', 'none'].includes(v) ? v : undefined),
  'voice.name': (v) => (typeof v === 'string' && v.length <= 80 ? v : undefined),
  'voice.dashscopeModel': (v) => (typeof v === 'string' && v.length <= 60 ? v : undefined),
  'voice.localModel': (v) => (typeof v === 'string' && v.length > 0 && v.length <= 120 ? v : undefined),
  'voice.rate': (v) => (typeof v === 'string' && /^[+-]\d{1,3}%$/.test(v) ? v : undefined),
  'voice.pitch': (v) => (typeof v === 'string' && /^[+-]\d{1,3}Hz$/.test(v) ? v : undefined),
  'voice.emotionIntensity': (v) =>
    typeof v === 'number' && v >= 0.2 && v <= 2 ? v : undefined,
  'voice.sfxVolume': (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined),
  'voice.ringEnabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'voice.ringVolume': (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined),
  'voice.motionSfx': (v) => (typeof v === 'boolean' ? v : undefined),
  'voice.stability': (v) => (typeof v === 'boolean' ? v : undefined),
  'speechInput.provider': (v) => (['windows-native', 'browser', 'api', 'none'].includes(v) ? v : undefined),
  'speechInput.lang': (v) => (typeof v === 'string' && v.length <= 16 ? v : undefined),
  'speechInput.apiModel': (v) => (typeof v === 'string' && v.length <= 60 ? v : undefined),
  'memory.enabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'memory.autoExtract': (v) => (typeof v === 'boolean' ? v : undefined),
  'memory.maxPerNamespace': NUM(10, 5000),
  'proactive.callEnabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'proactive.callIntervalMs': NUM(600000, 86400000),
  'proactive.idleEnabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'proactive.idleMs': NUM(60000, 86400000),
  'broadcast.enabled': (v) => (typeof v === 'boolean' ? v : undefined),
  'broadcast.onTaskStart': (v) => (typeof v === 'boolean' ? v : undefined),
  'broadcast.onTaskComplete': (v) => (typeof v === 'boolean' ? v : undefined),
  'broadcast.onTaskFailed': (v) => (typeof v === 'boolean' ? v : undefined),
  'broadcast.systemTts': (v) => (typeof v === 'boolean' ? v : undefined),
  'permissions.preauthorizeSay': (v) => (typeof v === 'boolean' ? v : undefined),
  'permissions.preauthorizeCall': (v) => (typeof v === 'boolean' ? v : undefined),
  'assets.autoDownload': (v) => (typeof v === 'boolean' ? v : undefined),
}

export function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

export function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (isPlainObject(acc) ? acc[k] : undefined), obj)
}

/**
 * Apply a whitelisted patch. Returns the new config plus the list of rejected
 * paths so the UI can explain what was ignored instead of silently dropping it.
 */
export function applyPatch(config, patch) {
  if (!isPlainObject(patch)) return { config, rejected: ['<root>'] }
  const next = clone(config)
  const rejected = []
  for (const [dotted, rawValue] of Object.entries(flatten(patch))) {
    const check = SCHEMA[dotted]
    if (!check) {
      rejected.push(dotted)
      continue
    }
    const value = check(rawValue)
    if (value === undefined) {
      rejected.push(dotted)
      continue
    }
    setPath(next, dotted, value)
  }
  const threshold = getPath(next, 'chat.compressThreshold')
  const keepRecent = getPath(next, 'chat.keepRecent')
  if (keepRecent >= threshold) {
    for (const dotted of ['chat.compressThreshold', 'chat.keepRecent']) {
      if (getPath(next, dotted) !== getPath(config, dotted)) {
        setPath(next, dotted, getPath(config, dotted))
        rejected.push(dotted)
      }
    }
  }
  return { config: next, rejected }
}

function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v) && !Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
      Object.assign(out, flatten(v, key))
    } else {
      out[key] = v
    }
  }
  return out
}

export class ConfigStore {
  constructor(paths) {
    this.paths = paths
    this.defaults = loadDefaults()
    this.config = this.#read()
  }

  #read() {
    const saved = readJson(this.paths.configFile, null)
    if (!saved) return clone(this.defaults)
    const { config, rejected } = applyPatch(this.defaults, saved)
    if (rejected.length > 0) {
      log.warn(`[config] ignored invalid saved settings: ${rejected.join(', ')}`)
    }
    return config
  }

  get() {
    return this.config
  }

  getPath(dotted) {
    return getPath(this.config, dotted)
  }

  save() {
    writeJsonAtomic(this.paths.configFile, this.config)
  }

  update(patch) {
    const { config, rejected } = applyPatch(this.config, patch)
    this.config = config
    this.save()
    return { config: this.config, rejected }
  }
}

/**
 * Config is documented as secret-free, but we defensively strip anything that
 * looks like a credential before it can reach a client.
 */
export function maskConfig(config) {
  const SENSITIVE = /(key|token|secret|password|authorization|credential)/i
  const walk = (value, key = '') => {
    if (SENSITIVE.test(key)) return value ? '***' : ''
    if (Array.isArray(value)) return value.map((v) => walk(v, ''))
    if (isPlainObject(value)) {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k)
      return out
    }
    return value
  }
  return walk(config)
}
