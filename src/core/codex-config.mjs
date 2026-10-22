import fs from 'node:fs'
import path from 'node:path'

/**
 * Keep our `notify` hook installed in Codex's own `config.toml`.
 *
 * Codex allows exactly one notify command and **rewrites that key when it
 * updates itself**: after the 26.1013 update the line was back to the original
 * `codex-computer-use.exe turn-ended`, so the hook that announces finished
 * tasks simply stopped running. The installer wrote this once; keeping it
 * installed has to be a running job, which is what this module is for.
 *
 * Policy, same as the installer's:
 *   - the user's own command is preserved in `notify-chain.json` before we
 *     replace it, and `amadeus-notify.mjs` replays it on every event
 *   - an unrelated `notify` line is never silently dropped: it is chained first
 *   - a file we cannot parse is reported, not overwritten
 *
 * Formatting: Codex writes `notify = [ "a", "b" ]` as often as `["a","b"]`, so
 * the array is scanned across lines instead of matched with a strict regex.
 */

export const NOTIFY_ARG_MARKER = 'amadeus-notify.mjs'

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Mirror of install.ps1's Parse-TomlArray: only quoted strings are collected. */
export function parseTomlStringArray(body) {
  const parts = []
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g
  let match
  while ((match = pattern.exec(String(body || ''))) !== null) {
    if (match[1] !== undefined) parts.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    else parts.push(match[2])
  }
  return parts
}

/** Locate the top-level `notify = [...]` key, spanning lines if needed. */
export function findNotifyArray(text) {
  const source = String(text || '')
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*notify\s*=/.test(lines[i])) continue
    let depth = 0
    let started = false
    let body = ''
    let end = i
    for (let j = i; j < lines.length; j++) {
      const line = j === i ? lines[j].replace(/^\s*notify\s*=/, '') : lines[j]
      for (const ch of line) {
        if (ch === '[') {
          depth += 1
          started = true
          continue
        }
        if (ch === ']') {
          depth -= 1
          if (depth === 0) break
          continue
        }
        if (started) body += ch
      }
      end = j
      if (started && depth === 0) break
    }
    return { start: i, end, body, parts: parseTomlStringArray(body) }
  }
  return null
}

export function notifyCommand(hookPath) {
  return ['node', hookPath, 'turn-ended']
}

export function isOurNotifyCommand(parts, hookPath) {
  if (!Array.isArray(parts) || parts.length < 2) return false
  const normalize = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
  return normalize(parts[1]).endsWith(normalize(NOTIFY_ARG_MARKER)) || normalize(parts[1]) === normalize(hookPath)
}

/**
 * Codex's computer-use notifier can wrap the current notify command in a
 * `--previous-notify` argument. If that current command is us, chaining the
 * wrapper back from Amadeus creates an endless A -> B -> A process loop.
 * Keep the wrapper itself, but remove only its reference back to our hook.
 */
export function sanitizeChainedNotify(command, hookPath) {
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return []
  if (isOurNotifyCommand(command, hookPath)) return []
  const safe = []
  for (let i = 0; i < command.length; i++) {
    const part = command[i]
    if (part === '--previous-notify' && String(command[i + 1] || '').toLowerCase().includes(NOTIFY_ARG_MARKER)) {
      i += 1
      continue
    }
    if (part.startsWith('--previous-notify=') && part.toLowerCase().includes(NOTIFY_ARG_MARKER)) continue
    safe.push(part)
  }
  return safe
}

function chainedCommand(chainFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'))
    const command = Array.isArray(parsed?.command) ? parsed.command.filter((s) => typeof s === 'string') : []
    return command.length > 0 ? command : null
  } catch {
    return null
  }
}

function writeChainFile(chainFile, command) {
  fs.mkdirSync(path.dirname(chainFile), { recursive: true })
  const payload = JSON.stringify({ command, savedAt: Date.now() }, null, 0)
  fs.writeFileSync(chainFile, payload, { encoding: 'utf8', mode: 0o600 })
}

/** temp file + rename, with the copy/direct fallback used for EFS directories. */
function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tmp, file)
    return
  } catch {
    /* encrypted directories refuse renames */
  }
  try {
    fs.copyFileSync(tmp, file)
  } catch {
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  }
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* harmless leftover */
  }
}

/**
 * @returns {{ok: boolean, changed: boolean, reason: string, command?: string[], chained?: string[]|null}}
 */
export function ensureNotifyHook({ configPath, hookPath, chainFile }) {
  let text
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, changed: false, reason: 'config-missing' }
    return { ok: false, changed: false, reason: e && e.message ? e.message : String(e) }
  }
  if (!fs.existsSync(hookPath)) return { ok: false, changed: false, reason: 'hook-missing' }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const ours = notifyCommand(hookPath)
  const oursLine = `notify = [${ours.map(tomlString).join(', ')}]`
  const existing = findNotifyArray(text)

  if (existing && isOurNotifyCommand(existing.parts, hookPath)) {
    const previous = chainedCommand(chainFile)
    if (previous) {
      const safe = sanitizeChainedNotify(previous, hookPath)
      if (safe.join('\u0000') !== previous.join('\u0000')) {
        try {
          writeChainFile(chainFile, safe)
        } catch (e) {
          return { ok: false, changed: false, reason: `chain-repair-failed: ${e && e.message ? e.message : e}` }
        }
        return { ok: true, changed: true, reason: 'chain-repaired', command: ours, chained: safe }
      }
    }
    return { ok: true, changed: false, reason: 'already-installed', command: ours }
  }

  let chained = null
  if (existing && existing.parts.length > 0) {
    const safe = sanitizeChainedNotify(existing.parts, hookPath)
    const previous = chainedCommand(chainFile)
    if (!previous || previous.join('\u0000') !== safe.join('\u0000')) {
      try {
        writeChainFile(chainFile, safe)
        chained = safe
      } catch (e) {
        // Losing the previous command is worse than leaving the file alone.
        return {
          ok: false,
          changed: false,
          reason: `chain-write-failed: ${e && e.message ? e.message : e}`,
        }
      }
    }
  }

  const lines = text.split(/\r?\n/)
  let next
  if (existing) {
    next = [...lines.slice(0, existing.start), oursLine, ...lines.slice(existing.end + 1)].join(eol)
  } else {
    // Top-level keys have to stay above the first table header.
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
    const at = firstTable === -1 ? lines.length : firstTable
    next = [...lines.slice(0, at), oursLine, ...lines.slice(at)].join(eol)
  }

  try {
    writeTextAtomic(configPath, next)
  } catch (e) {
    return { ok: false, changed: false, reason: e && e.message ? e.message : String(e) }
  }
  return { ok: true, changed: true, reason: 'installed', command: ours, chained }
}

/** Undo: put the chained command back, or drop the line when there was none. */
export function removeNotifyHook({ configPath, hookPath, chainFile }) {
  let text
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (e) {
    return { ok: false, changed: false, reason: e && e.code === 'ENOENT' ? 'config-missing' : String(e) }
  }
  const existing = findNotifyArray(text)
  if (!existing || !isOurNotifyCommand(existing.parts, hookPath)) {
    return { ok: true, changed: false, reason: 'not-installed' }
  }
  const storedPrevious = chainedCommand(chainFile)
  const previous = storedPrevious ? sanitizeChainedNotify(storedPrevious, hookPath) : null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const replacement = previous?.length
    ? `notify = [${previous.map(tomlString).join(', ')}]`
    : null
  const next = replacement
    ? [...lines.slice(0, existing.start), replacement, ...lines.slice(existing.end + 1)].join(eol)
    : [...lines.slice(0, existing.start), ...lines.slice(existing.end + 1)].join(eol)
  try {
    writeTextAtomic(configPath, next)
  } catch (e) {
    return { ok: false, changed: false, reason: e && e.message ? e.message : String(e) }
  }
  return { ok: true, changed: true, reason: previous ? 'restored' : 'removed' }
}
