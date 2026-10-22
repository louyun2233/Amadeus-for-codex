import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'

const logger = createChildLogger('[system-tts]')

/**
 * Speak a short line through the operating system, for the case where the
 * panel is not open at all: a task finished while the user was in another
 * window, and a queued line in a closed panel helps nobody.
 *
 * Rules that matter more than the feature itself:
 *   - never overlap: one process at a time, later lines queue (bounded), and
 *     the newest is dropped rather than the one already being spoken
 *   - never block a caller: `speak()` resolves when the line is done, and the
 *     daemon does not have to wait for it
 *   - never throw: a missing backend degrades to "no system voice" so the
 *     caller can fall back to the panel channel
 *   - never log or inline the text: on Windows it travels through the
 *     environment, and the log records only the character count
 */

export const SYSTEM_TTS_MAX_CHARS = 160
export const SYSTEM_TTS_TIMEOUT_MS = 30000
export const SYSTEM_TTS_MAX_QUEUE = 2

/** Drop markup the speech engine would read out loud, collapse whitespace. */
export function sanitize(text) {
  const flat = String(text ?? '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length === 0) return null
  return flat.length > SYSTEM_TTS_MAX_CHARS ? flat.slice(0, SYSTEM_TTS_MAX_CHARS) : flat
}

/** The text may never travel as an argv token: keep it out of the command line. */
export function backendFor(platform) {
  if (platform === 'win32') {
    return {
      id: 'windows-sapi',
      cmd: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Speech; ' +
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
          '$s.Speak($env:AMADEUS_SPEAK_TEXT)',
      ],
      viaEnv: true,
    }
  }
  if (platform === 'darwin') return { id: 'macos-say', cmd: 'say', args: [], viaEnv: false }
  return null
}

/** Linux has no single answer: try the two that are usually installed. */
const LINUX_CANDIDATES = [
  { id: 'linux-spd-say', cmd: 'spd-say', args: [], viaEnv: false },
  { id: 'linux-espeak', cmd: 'espeak-ng', args: [], viaEnv: false },
  { id: 'linux-espeak-legacy', cmd: 'espeak', args: [], viaEnv: false },
]

export class SystemTts {
  /** Resolved lazily and cached: constructing the daemon must not shell out. */
  #backend = undefined

  #which

  constructor({
    platform = process.platform,
    spawnImpl = nodeSpawn,
    whichImpl,
    env = process.env,
    timeoutMs = SYSTEM_TTS_TIMEOUT_MS,
    maxQueue = SYSTEM_TTS_MAX_QUEUE,
  } = {}) {
    this.platform = platform
    this.spawnImpl = spawnImpl
    this.env = env
    this.timeoutMs = timeoutMs
    this.maxQueue = maxQueue
    this.queue = []
    this.active = null
    this.lastDegrade = null
    this.#which =
      whichImpl ||
      ((cmd) => {
        try {
          const probe = spawnSync(platform === 'win32' ? 'where' : 'which', [cmd], {
            stdio: 'ignore',
            windowsHide: true,
          })
          return probe.status === 0
        } catch {
          return false
        }
      })
  }

  #resolve() {
    if (this.#backend !== undefined) return this.#backend
    const fixed = backendFor(this.platform)
    if (fixed) {
      this.#backend = this.platform === 'win32' || this.#which(fixed.cmd) ? fixed : null
      return this.#backend
    }
    if (this.platform === 'linux') {
      this.#backend = LINUX_CANDIDATES.find((b) => this.#which(b.cmd)) || null
      return this.#backend
    }
    this.#backend = null
    return this.#backend
  }

  available() {
    return Boolean(this.#resolve())
  }

  /** What the self-check reports: backend id or the reason there is none. */
  describe() {
    const backend = this.#resolve()
    return {
      available: Boolean(backend),
      backend: backend ? backend.id : null,
      reason: backend ? '' : `no system speech command for platform ${this.platform}`,
      queue: this.queue.length,
      speaking: Boolean(this.active),
      lastDegrade: this.lastDegrade,
    }
  }

  /** Run a PowerShell snippet and collect its stdout. */
  #run(script, env, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnImpl(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...this.env, ...env } },
        )
      } catch (e) {
        reject(e)
        return
      }
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk) => {
        out += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk) => {
        err += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        reject(new Error('system voice command timed out'))
      }, timeoutMs)
      timer.unref?.()
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(err.trim() || `system voice command exited ${code}`))
      })
    })
  }

  /**
   * Voices installed in Windows. This is the "导入" source that needs no
   * account and no network: whatever the user installed shows up here.
   */
  async listVoices() {
    if (!this.available()) return []
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$s.GetInstalledVoices() | ForEach-Object { ' +
      '$v = $_.VoiceInfo; Write-Output ($v.Name + "|" + $v.Culture + "|" + $v.Gender) }'
    try {
      const out = await this.#run(script, {})
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, culture = '', gender = ''] = line.split('|')
          return { id: id.trim(), label: id.trim(), culture: culture.trim(), gender: gender.trim() }
        })
    } catch (e) {
      logger.warn('listing system voices failed:', e && e.message ? e.message : e)
      return []
    }
  }

  /**
   * Render one line with a Windows voice into a WAV buffer. Offline, no key,
   * and the only path that can speak a voice the user installed themselves.
   */
  async synthesize({ text, voice = '', ratePercent = 0 } = {}) {
    const clean = sanitize(text)
    if (!clean) throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'empty text')
    if (!this.available()) {
      throw new AmadeusError(ErrorCode.DEGRADED, 'no system speech command on this platform', {
        degrade: 'no-system-voice',
      })
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-sapi-'))
    const wav = path.join(dir, 'out.wav')
    const rate = Math.max(-10, Math.min(10, Math.round(Number(ratePercent || 0) / 10)))
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      'if ($env:AMADEUS_VOICE_NAME) { $s.SelectVoice($env:AMADEUS_VOICE_NAME) }; ' +
      '$s.Rate = [int]$env:AMADEUS_VOICE_RATE; ' +
      '$s.SetOutputToWaveFile($env:AMADEUS_WAV); ' +
      '$s.Speak($env:AMADEUS_SPEAK_TEXT); ' +
      '$s.Dispose()'
    try {
      await this.#run(
        script,
        {
          AMADEUS_VOICE_NAME: String(voice || ''),
          AMADEUS_VOICE_RATE: String(Number.isFinite(rate) ? rate : 0),
          AMADEUS_WAV: wav,
          AMADEUS_SPEAK_TEXT: clean,
        },
        { timeoutMs: 60000 },
      )
      const audio = fs.readFileSync(wav)
      if (audio.length < 128) {
        throw new AmadeusError(ErrorCode.UNAVAILABLE, 'system voice produced no audio')
      }
      logger.info(`synthesized ${audio.length} bytes with ${voice || 'the default voice'}`)
      return { audio, mime: 'audio/wav', words: [], style: null }
    } catch (e) {
      if (e instanceof AmadeusError) throw e
      throw new AmadeusError(
        ErrorCode.UNAVAILABLE,
        `system voice failed: ${e && e.message ? e.message : e}`,
        { degrade: 'system-voice-failed' },
      )
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* the temp dir is harmless */
      }
    }
  }

  /**
   * Queue one line. Resolves when *this* line has been spoken (or refused), so
   * a caller that cares can wait, and one that does not can ignore the promise.
   */
  speak(text) {
    const clean = sanitize(text)
    if (!clean) return Promise.resolve({ ok: false, degrade: 'empty' })
    const backend = this.#resolve()
    if (!backend) {
      this.lastDegrade = 'no-system-voice'
      return Promise.resolve({ ok: false, degrade: 'no-system-voice' })
    }
    if (this.queue.length >= this.maxQueue) {
      // Drop the newest, never the line already being spoken.
      this.lastDegrade = 'queue-full'
      logger.warn(`queue full (${this.maxQueue}); dropping a line of ${clean.length} chars`)
      return Promise.resolve({ ok: false, degrade: 'queue-full' })
    }
    return new Promise((resolve) => {
      this.queue.push({ text: clean, resolve })
      this.#pump()
    })
  }

  #pump() {
    if (this.active || this.queue.length === 0) return
    const job = this.queue.shift()
    const backend = this.#resolve()
    let child
    try {
      child = this.spawnImpl(backend.cmd, [...backend.args, ...(backend.viaEnv ? [] : [job.text])], {
        stdio: 'ignore',
        windowsHide: true,
        // The text never appears in the command line on Windows.
        env: backend.viaEnv ? { ...this.env, AMADEUS_SPEAK_TEXT: job.text } : this.env,
      })
    } catch (e) {
      this.lastDegrade = 'spawn-failed'
      job.resolve({ ok: false, degrade: 'spawn-failed', detail: String((e && e.message) || e) })
      this.#pump()
      return
    }

    const finish = (result) => {
      if (this.active !== job) return
      clearTimeout(job.timer)
      this.active = null
      this.lastDegrade = result.ok ? null : result.degrade
      job.resolve(result)
      this.#pump()
    }

    this.active = job
    job.child = child
    job.timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, degrade: 'system-tts-timeout' })
    }, this.timeoutMs)
    job.timer.unref?.()

    child.on('error', (e) => {
      finish({ ok: false, degrade: 'spawn-failed', detail: String((e && e.message) || e) })
    })
    child.on('exit', (code) => {
      if (code === 0) finish({ ok: true, backend: backend.id, chars: job.text.length })
      else finish({ ok: false, degrade: 'system-tts-failed', detail: `exit ${code}` })
    })
  }

  /** Stop talking now: used on shutdown so no orphan process is left behind. */
  shutdown() {
    for (const job of this.queue) job.resolve({ ok: false, degrade: 'shutdown' })
    this.queue.length = 0
    const active = this.active
    if (active) {
      clearTimeout(active.timer)
      try {
        active.child.kill()
      } catch {
        /* already gone */
      }
      this.active = null
      active.resolve({ ok: false, degrade: 'shutdown' })
    }
  }
}
