import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'
import { APP_VERSION } from '../shared/version.mjs'
import { codexChildEnv } from './codex-proxy.mjs'

const logger = createChildLogger('[llm]')

export const CHAT_TIMEOUT_MS = 60000
export const MEMORY_TIMEOUT_MS = 15000
const MAX_CODEX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LLM_REPLY_CHARS = 100000

function stopProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) child.kill()
    })
  } else {
    child.kill('SIGTERM')
  }
}

function which(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFile(finder, [cmd], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      resolve(first || null)
    })
  })
}

/**
 * Where the Codex CLI can live, most trustworthy first.
 *
 * `where codex` is not enough: the daemon is started by the Startup watcher or
 * by Amadeus.exe, and those sessions do not always inherit the PATH that the
 * Codex app set for itself - the panel then answers "codex CLI not found on
 * PATH" while Codex is running right next to it. So we also look where the
 * desktop app keeps its CLI (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`).
 */
function codexCandidates(env = process.env) {
  const list = []
  if (env.AMADEUS_CODEX_BIN) list.push(env.AMADEUS_CODEX_BIN)
  if (env.LOCALAPPDATA) {
    const binRoot = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    try {
      const dirs = fs
        .readdirSync(binRoot)
        .map((name) => path.join(binRoot, name, 'codex.exe'))
        .filter((file) => fs.existsSync(file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      list.push(...dirs)
    } catch {
      /* the app may not manage a CLI on this machine */
    }
    list.push(path.join(env.LOCALAPPDATA, 'Programs', 'codex', 'codex.exe'))
  }
  if (env.ProgramFiles) list.push(path.join(env.ProgramFiles, 'Codex', 'codex.exe'))
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'npm', 'codex.cmd'))
  return list.filter(Boolean)
}

let codexPathCache
export async function resolveCodex() {
  if (codexPathCache !== undefined) return codexPathCache
  for (const candidate of codexCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        codexPathCache = candidate
        return codexPathCache
      }
    } catch {
      /* keep looking */
    }
  }
  codexPathCache = await which(process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (!codexPathCache) codexPathCache = await which('codex')
  return codexPathCache
}

/**
 * npm installs a `.cmd` shim, which Windows cannot exec directly. The prompt
 * travels on stdin and the argv is fixed, so going through cmd.exe is safe here.
 */
export function codexSpawnTarget(exe) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(exe || ''))) {
    return { cmd: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/c', exe] }
  }
  return { cmd: exe, argsPrefix: [] }
}

/** Per-call override leaves the user's coding sessions at their own effort. */
export function codexExecArgs({ cwd, outFile, model = '' }) {
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check',
    '--config', 'model_reasoning_effort="low"',
    '-s', 'read-only', '-C', cwd, '-o', outFile,
  ]
  if (model) args.push('-m', model)
  args.push('-')
  return args
}

/**
 * Chat adapter that reuses the user's Codex login and model through
 * `codex exec`. This is what makes the main path zero-API-key (Q29).
 *
 * Notes:
 * - `--ephemeral` keeps Amadeus conversation out of the user's Codex history.
 * - we do NOT pass `--ignore-user-config`: the user's model/provider setup is
 *   exactly what we want to reuse. An explicit -m only overrides the model.
 * - the run happens in a neutral empty directory so the companion cannot read
 *   the user's project just by being chatty.
 * - no flag can fully disable tool use, so the prompt contract forbids it and
 *   we run with a read-only sandbox.
 */
export class CodexExecAdapter {
  constructor({ paths, getConfig, spawnProcess = spawn, resolveExecutable = resolveCodex, childEnv = codexChildEnv }) {
    this.paths = paths
    this.getConfig = getConfig
    this.spawnProcess = spawnProcess
    this.resolveExecutable = resolveExecutable
    this.childEnv = childEnv
    this.cwd = path.join(paths.runtimeDir, 'chatcwd')
    fs.mkdirSync(this.cwd, { recursive: true })
  }

  get id() {
    return 'codex-exec'
  }

  async isAvailable() {
    return (await resolveCodex()) !== null
  }

  async chat({ system, history = [], user, model, onDelta, onStatus, signal, timeoutMs = CHAT_TIMEOUT_MS }) {
    signal?.throwIfAborted()
    const exe = await this.resolveExecutable()
    if (!exe) {
      throw new AmadeusError(ErrorCode.UNAVAILABLE, 'codex CLI not found (PATH and the usual install locations)', {
        degrade: 'configure-independent-llm-key',
      })
    }
    const spawnTarget = codexSpawnTarget(exe)
    const env = await this.childEnv()
    signal?.throwIfAborted()

    const prompt = renderPrompt({ system, history, user })
    const outFile = path.join(
      os.tmpdir(),
      `amadeus-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )

    const cfgModel = model || this.getConfig?.()?.chat?.model
    const args = codexExecArgs({ cwd: this.cwd, outFile, model: cfgModel })

    const reportStatus = (phase) => { try { onStatus?.(phase) } catch { /* UI progress is best-effort */ } }
    let streamedText = ''
    let exitCode = null
    let text
    try {
      text = await new Promise((resolve, reject) => {
      const child = this.spawnProcess(spawnTarget.cmd, [...spawnTarget.argsPrefix, ...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
      let stdout = ''
      let stdoutBytes = 0
      let stderr = ''
      let settled = false
      let sawEvent = false
      let sawReply = false
      let upstreamTimedOut = false

      reportStatus('connecting')

      const settle = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(result)
      }

      const onAbort = () => {
        stopProcessTree(child)
        settle(new AmadeusError(ErrorCode.UNAVAILABLE, 'codex exec cancelled'))
      }

      const timer = setTimeout(() => {
        stopProcessTree(child)
        const message = upstreamTimedOut
          ? 'Codex 模型服务请求超时，请检查连接或稍后重试。'
          : '对话模型响应超时，请重试。'
        settle(new AmadeusError(ErrorCode.UNAVAILABLE, message, {
          degrade: upstreamTimedOut ? 'chat-upstream-timeout' : 'chat-timeout',
        }))
      }, timeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      child.stdin.on('error', () => {}) // a cancelled CLI may close stdin before the prompt is written
      child.stdin.end(prompt, 'utf8')
      child.stdout.on('data', (c) => {
        if (settled) return
        stdoutBytes += c.length
        if (stdoutBytes > MAX_CODEX_OUTPUT_BYTES) {
          stopProcessTree(child)
          settle(new AmadeusError(ErrorCode.UNAVAILABLE, 'codex exec output too large'))
          return
        }
        stdout += String(c)
        // A completed message can arrive before the CLI exits. Show it now;
        // the final output file remains authoritative for the saved reply.
        const lines = stdout.split(/\r?\n/)
        const tail = lines.pop() || ''
        for (const line of lines) {
          if (!sawEvent && line.trim().startsWith('{')) {
            try { JSON.parse(line); sawEvent = true; reportStatus('generating') } catch { /* partial line */ }
          }
          const message = agentMessageFromLine(line)
          if (!message) continue
          if (!sawReply) { sawReply = true; reportStatus('reply') }
          const delta = streamedText ? `\n${message}` : message
          streamedText += delta
          onDelta?.(delta)
        }
        stdout = tail
      })
      child.stderr.on('data', (c) => {
        if (stderr.length < 16000) stderr += String(c).slice(0, 16000 - stderr.length)
        if (!upstreamTimedOut && /responses_retry[\s\S]*sampling_error=request timed out/i.test(stderr)) {
          upstreamTimedOut = true
          reportStatus('retrying')
        }
      })
      child.on('error', (e) => {
        settle(new AmadeusError(ErrorCode.UNAVAILABLE, `codex exec failed: ${e.message}`))
      })
      child.on('close', (code) => {
        exitCode = code
        if (settled) {
          try { fs.unlinkSync(outFile) } catch { /* already removed */ }
          return
        }
        if (code !== 0 && stderr.trim().length > 0) {
          logger.warn('codex exec exited', code, stderr.slice(0, 300))
        }
        settle(null, stdout)
      })
      })

      let finalText = ''
      try {
        finalText = fs.readFileSync(outFile, 'utf8').trim()
      } catch {
        /* the CLI did not write an output file */
      }
      if (!finalText) finalText = streamedText || scrapeAgentMessages(text)
      if (!finalText) {
        const reason = exitCode !== 0 ? `codex exec exited with code ${exitCode}` : 'codex exec returned no assistant message'
        throw new AmadeusError(ErrorCode.UNAVAILABLE, reason, { degrade: 'chat-no-reply' })
      }
      if (finalText.length > MAX_LLM_REPLY_CHARS) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, 'codex exec reply too large')
      }
      if (!streamedText) onDelta?.(finalText)
      else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        onDelta?.(finalText.slice(streamedText.length))
      }
      return { text: finalText, provider: this.id }
    } finally {
      try {
        fs.unlinkSync(outFile)
      } catch {
        /* ignore */
      }
    }
  }
}

function agentMessageFromLine(line) {
  try {
    const event = JSON.parse(line)
    if (event.type !== 'item.completed') return ''
    const item = event.item || event.data?.item
    return item?.type === 'agent_message' && typeof item.text === 'string' ? item.text : ''
  } catch {
    return ''
  }
}

function renderPrompt({ system, history, user }) {
  const lines = [system, '']
  if (history.length > 0) {
    lines.push('【最近对话】')
    for (const m of history) {
      const speaker = m.role === 'user' ? '用户' : 'Amadeus'
      const body = m.zh && m.ja && m.zh !== m.ja ? `${m.ja}` : m.zh || m.ja || ''
      lines.push(`${speaker}: ${body}`)
    }
    lines.push('')
  }
  lines.push('【用户最新发言】')
  lines.push(user)
  return lines.join('\n')
}

/** Extract `item.completed` agent_message text from a codex --json stream. */
function scrapeAgentMessages(stdout) {
  const out = []
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    const message = agentMessageFromLine(trimmed)
    if (message) out.push(message)
  }
  return out.join('\n').trim()
}

/**
 * Optional adapter for users who prefer a dedicated API key over Codex.
 * Uses the Responses-free Chat Completions shape, which every major
 * OpenAI-compatible endpoint speaks.
 */
export class OpenAiCompatAdapter {
  constructor({ getConfig, secretStore, secretName = 'chatApiKey' }) {
    this.getConfig = getConfig
    this.secretStore = secretStore
    this.secretName = secretName
  }

  get id() {
    return 'openai-compat'
  }

  async isAvailable() {
    return Boolean(this.secretStore?.get(this.secretName))
  }

  async chat({ system, history = [], user, onDelta, onStatus, signal, timeoutMs = CHAT_TIMEOUT_MS }) {
    signal?.throwIfAborted()
    const apiKey = this.secretStore?.get(this.secretName)
    if (!apiKey) {
      throw new AmadeusError(ErrorCode.UNAVAILABLE, 'no API key configured', {
        degrade: 'set-chat-api-key-or-use-codex',
      })
    }
    const baseUrl = this.secretStore?.get('openaiBaseUrl') || 'https://api.deepseek.com/v1'
    const model = this.getConfig?.()?.chat?.model || 'deepseek-chat'
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'

    const messages = [{ role: 'system', content: system }]
    for (const m of history) {
      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.ja && m.ja !== m.zh ? m.ja : m.zh || m.ja || '',
      })
    }
    messages.push({ role: 'user', content: user })

    const reportStatus = (phase) => { try { onStatus?.(phase) } catch { /* UI progress is best-effort */ } }
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    reportStatus('connecting')
    try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': `Amadeus-Codex/${APP_VERSION}`,
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.9, max_tokens: 600 }),
      signal: requestSignal,
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new AmadeusError(
        ErrorCode.UNAVAILABLE,
        `llm http ${res.status} ${detail.slice(0, 200)}`,
      )
    }
    reportStatus('generating')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_LLM_REPLY_CHARS) {
        await reader.cancel()
        throw new AmadeusError(ErrorCode.UNAVAILABLE, 'llm stream line too large')
      }
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let json
        try { json = JSON.parse(payload) } catch { continue }
        const delta = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          if (!full) reportStatus('reply')
          full += delta
          if (full.length > MAX_LLM_REPLY_CHARS) {
            await reader.cancel()
            throw new AmadeusError(ErrorCode.UNAVAILABLE, 'llm reply too large')
          }
          onDelta?.(delta)
        }
      }
    }
    return { text: full, provider: this.id }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, '对话模型响应超时，请重试。', { degrade: 'chat-timeout' })
      }
      throw error
    }
  }
}

export function createLlmRouter({ paths, getConfig, secretStore }) {
  const adapters = {
    'codex-exec': new CodexExecAdapter({ paths, getConfig }),
    'openai-compat': new OpenAiCompatAdapter({ getConfig, secretStore }),
  }

  return {
    adapters,
    async describe() {
      const out = {}
      for (const [key, adapter] of Object.entries(adapters)) {
        try {
          out[key] = { available: await adapter.isAvailable() }
        } catch {
          out[key] = { available: false }
        }
      }
      return out
    },
    pick(preferred) {
      return adapters[preferred] || adapters['codex-exec']
    },
  }
}
