import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readJson, writeJsonAtomic } from './store.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { log } from '../shared/log.mjs'

/**
 * Secret handling: env first, OS-encrypted store second, never plaintext.
 *
 * - `AMADEUS_<NAME>` environment variables always win and are never persisted.
 * - On Windows we persist through DPAPI (user-scoped) via PowerShell, so the
 *   file on disk is only decryptable by the same Windows user.
 * - On other platforms, or when DPAPI is unavailable, we refuse to persist and
 *   tell the caller to use an environment variable. We fail closed.
 */

const KNOWN = new Set([
  'chatApiKey',
  'ttsApiKey',
  'sttApiKey',
  'openaiBaseUrl',
])

export function envNameFor(name) {
  const snake = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
  return `AMADEUS_${snake}`
}

function dpapiAvailable() {
  return process.platform === 'win32'
}

/**
 * PowerShell helper.
 *
 * Everything goes through `ProtectedData` from System.Security, NOT through
 * `ConvertTo-SecureString`: that cmdlet lives in a PowerShell *module*, and a
 * daemon started by the Startup watcher (or by Amadeus.exe) does not always
 * have PSModulePath set - module autoloading then fails and every stored key
 * silently reads as "not configured". Loading an assembly has no such
 * dependency.
 */
function powershell(script, extraEnv = {}) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      timeout: 15000,
    },
  ).trim()
}

function encryptDpapi(plain) {
  return powershell(
    'Add-Type -AssemblyName System.Security; ' +
      '$bytes = [Text.Encoding]::UTF8.GetBytes($env:AMADEUS_SECRET_PLAIN); ' +
      '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, ' +
      '[Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[Console]::Out.Write([Convert]::ToBase64String($protected))',
    { AMADEUS_SECRET_PLAIN: plain },
  )
}

function decryptDpapi(cipher) {
  return powershell(
    'Add-Type -AssemblyName System.Security; ' +
      '$bytes = [Convert]::FromBase64String($env:AMADEUS_SECRET_CIPHER); ' +
      '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, ' +
      '[Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
    { AMADEUS_SECRET_CIPHER: cipher },
  )
}

/** Blobs written before the switch: `ConvertFrom-SecureString` hex output. */
function decryptLegacySecureString(cipher) {
  return powershell(
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ' +
      '$s = ConvertTo-SecureString $env:AMADEUS_SECRET_CIPHER; ' +
      '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
      '[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))',
    { AMADEUS_SECRET_CIPHER: cipher },
  )
}

export class SecretStore {
  constructor(paths) {
    this.paths = paths
    this.cache = new Map()
  }

  #readFile() {
    const data = readJson(this.paths.secretsFile, {})
    return data && typeof data === 'object' ? data : {}
  }

  /** Resolve a secret value, or null when not configured. */
  get(name) {
    if (!KNOWN.has(name)) return null
    if (this.cache.has(name)) return this.cache.get(name)

    const fromEnv = process.env[envNameFor(name)]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      this.cache.set(name, fromEnv)
      return fromEnv
    }

    const stored = this.#readFile()[name]
    if (typeof stored === 'string' && stored.length > 0) {
      if (!dpapiAvailable()) {
        log.warn('[secrets] stored secret found but DPAPI is unavailable; ignoring')
        return null
      }
      try {
        const plain = decryptDpapi(stored)
        this.cache.set(name, plain)
        return plain
      } catch (e) {
        // Older builds used ConvertFrom-SecureString; keep reading those.
        try {
          const plain = decryptLegacySecureString(stored)
          this.cache.set(name, plain)
          return plain
        } catch {
          log.warn(`[secrets] failed to decrypt ${name}:`, e && e.message ? e.message : e)
          return null
        }
      }
    }
    return null
  }

  set(name, value) {
    if (!KNOWN.has(name)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `unknown secret: ${name}`)
    }
    const plain = String(value ?? '')
    if (plain.length === 0) {
      const data = this.#readFile()
      delete data[name]
      writeJsonAtomic(this.paths.secretsFile, data)
      this.cache.delete(name)
      return { configured: false }
    }
    if (!dpapiAvailable()) {
      throw new AmadeusError(
        ErrorCode.DEGRADED,
        `不能在本平台持久化密钥；请改用环境变量 ${envNameFor(name)}`,
        { degrade: 'use-env-var' },
      )
    }
    const cipher = encryptDpapi(plain)
    const data = this.#readFile()
    data[name] = cipher
    writeJsonAtomic(this.paths.secretsFile, data)
    this.cache.set(name, plain)
    return { configured: true }
  }

  /** Never returns the value: only whether it exists and where it came from. */
  describe(name) {
    const fromEnv = process.env[envNameFor(name)]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      return { configured: true, source: 'env', envVar: envNameFor(name) }
    }
    const stored = this.#readFile()[name]
    if (typeof stored === 'string' && stored.length > 0) {
      return { configured: true, source: dpapiAvailable() ? 'dpapi' : 'unreadable' }
    }
    return { configured: false, source: 'none' }
  }

  describeAll() {
    const out = {}
    for (const name of KNOWN) out[name] = this.describe(name)
    return out
  }
}

export function assertSecretsFileNotPlaintext(paths) {
  if (!fs.existsSync(paths.secretsFile)) return
  const data = readJson(paths.secretsFile, {})
  for (const [k, v] of Object.entries(data || {})) {
    // Hex (legacy ConvertFrom-SecureString) or base64 (ProtectedData).
    if (typeof v === 'string' && !/^[0-9A-Fa-f]{16,}$/.test(v) && !/^[A-Za-z0-9+/=]{16,}$/.test(v)) {
      log.warn(`[secrets] ${k} does not look like a DPAPI blob; refusing to use it`)
    }
  }
}
