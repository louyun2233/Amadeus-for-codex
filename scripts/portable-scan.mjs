#!/usr/bin/env node
/**
 * Handing this project to someone else must not hand over your credentials.
 *
 * Two things are checked before anything is packaged:
 *   1. no file in the distribution looks like it carries a key, token or
 *      private key (a real key is what makes "her voice" work on *your*
 *      account - other people bring their own, or use the built-in voice)
 *   2. no runtime data file (secrets.json, config.json, audit.jsonl, logs)
 *      is part of the file list at all
 *
 * Conversation itself never needs a key: the default channel is `codex-exec`,
 * which reuses whatever Codex login the other person already has.
 *
 * Usage: node scripts/portable-scan.mjs [dir]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

export const SECRET_PATTERNS = [
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'bearer literal', re: /\bBearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: 'aliyun access key', re: /\bLTAI[A-Za-z0-9]{12,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws temporary key id', re: /\bASIA[0-9A-Z]{16}\b/ },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'github token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/ },
]

/** Files that only exist on a machine that has already been set up. */
export const RUNTIME_DATA_FILES = [
  'secrets.json',
  'config.json',
  'audit.jsonl',
  'notify.log',
  'watch.log',
  'notify-chain.json',
  'daemon.json',
  'qwen-service.json',
]

const TEXT_EXT = /\.(mjs|cjs|js|json|md|txt|ps1|cmd|vbs|cs|py|html|css|toml|yml|yaml|sha256)$/i
const PRIVATE_FILE = /(^|\/)(?:\.env(?:\.[^/]*)?|(?:config|secrets)\.json\.backup[^/]*|[^/]+\.(?:pem|key|p8|p12|pfx|sqlite3?|db|wav|mp3|flac|ogg|m4a|mp4|webm|zip|7z|rar))$/i
const USER_PROFILE = /\b[a-z]:[\\/]+users[\\/]+([a-z0-9._-]+)/gi
const EXAMPLE_USERS = new Set(['exampleuser', 'yourname', 'username', 'user', 'public', 'default'])
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi
const EXAMPLE_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.test'])
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/

export function scanText(text) {
  const hits = []
  for (const pattern of SECRET_PATTERNS) {
    const found = pattern.re.exec(text)
    if (found) hits.push(pattern.name)
  }
  for (const match of text.matchAll(USER_PROFILE)) {
    if (!EXAMPLE_USERS.has(match[1].toLowerCase())) {
      hits.push('personal Windows user path')
      break
    }
  }
  for (const match of text.matchAll(EMAIL_ADDRESS)) {
    if (!EXAMPLE_DOMAINS.has(match[1].toLowerCase())) {
      hits.push('personal email address')
      break
    }
  }
  if (CN_MOBILE.test(text)) hits.push('possible personal phone number')
  return hits
}

/** @param {{rel: string, abs?: string|null, inline?: Buffer}[]} files */
export function scanFiles(files, { strict = false } = {}) {
  const problems = []
  for (const file of files) {
    const rel = file.rel.replace(/\\/g, '/')
    const base = path.posix.basename(rel)
    if (RUNTIME_DATA_FILES.includes(base)) {
      problems.push({ rel, hits: ['runtime data file'] })
      continue
    }
    if (strict && PRIVATE_FILE.test(rel)) {
      problems.push({ rel, hits: ['private or opaque file type'] })
      continue
    }
    if (!TEXT_EXT.test(rel)) continue
    let text = ''
    try {
      text = file.inline ? file.inline.toString('utf8') : fs.readFileSync(file.abs, 'utf8')
    } catch {
      problems.push({ rel, hits: ['could not inspect text file'] })
      continue
    }
    const hits = scanText(text)
    if (hits.length > 0) problems.push({ rel, hits })
  }
  return problems
}

export function collect(dir, out = []) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).replace(/\\/g, '/')
      if (/(^|\/)(?:node_modules|\.native-venv|__pycache__|\.git|dist|work|panel-profile)(\/|$)/.test(rel)) continue
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push({ rel, abs: full })
    }
  }
  visit(dir)
  return out
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : ROOT
  const problems = scanFiles(collect(target))
  if (problems.length === 0) {
    console.log('PASS  no detected credentials or personal details in scanned files')
    process.exitCode = 0
  } else {
    console.log('FAIL  credential or personal material found:')
    for (const p of problems) console.log(`  ${p.rel}  ${p.hits.join('; ')}`)
    process.exitCode = 1
  }
}
