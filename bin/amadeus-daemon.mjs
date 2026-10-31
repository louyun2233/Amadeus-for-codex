#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import { ConfigStore } from '../src/core/config.mjs'
import { SecretStore } from '../src/core/secrets.mjs'
import { AuditLog } from '../src/core/audit.mjs'
import { SessionStore } from '../src/core/sessions.mjs'
import { MemoryStore } from '../src/core/memory.mjs'
import { TtsService } from '../src/core/tts.mjs'
import { ensureLocalQwen } from '../src/core/local-qwen-service.mjs'
import { SttService } from '../src/core/stt.mjs'
import { SystemTts } from '../src/core/system-tts.mjs'
import { VoiceLibrary } from '../src/core/voices.mjs'
import { AssetManager } from '../src/core/assets.mjs'
import { createLlmRouter } from '../src/core/llm.mjs'
import { ChatEngine } from '../src/core/chat.mjs'
import { loadPersona } from '../src/core/persona.mjs'
import { loadCharacterContent } from '../src/core/character.mjs'
import { runDiagnostics } from '../src/core/diag.mjs'
import { EventHub } from '../src/host/events.mjs'
import { createDaemon } from '../src/host/daemon.mjs'
import { wireChatEvents } from '../src/host/chat-events.mjs'
import { EMOTION_EXPR } from '../src/core/emotion.mjs'
import { ProactiveScheduler } from '../src/core/scheduler.mjs'
import { readJson, writeJsonAtomic } from '../src/core/store.mjs'
import { log } from '../src/shared/log.mjs'
import { APP_VERSION } from '../src/shared/version.mjs'
import { readDaemonInfo, ping } from '../src/host/daemon-client.mjs'
import { TaskWatcher } from '../src/host/task-watch.mjs'
import { ActiveTurnLedger } from '../src/host/task-policy.mjs'
import { TaskLinePicker } from '../src/core/task-lines.mjs'

const paths = ensureDirs(resolvePaths())

/**
 * Single instance per data directory.
 *
 * A pid probe alone is not enough: the pointer survives a reboot, and a daemon
 * that is *listening* is the only proof that the instance is real. A stale
 * pointer is removed so clients stop trusting it.
 */
const existing = readDaemonInfo(paths)
if (existing && (await ping(existing))) {
  log.warn(`[daemon] another instance is already running (pid ${existing.pid}, port ${existing.port}); exiting`)
  process.exit(0)
}
if (existing) {
  try {
    fs.unlinkSync(paths.daemonFile)
  } catch {
    /* ignore */
  }
  log.warn('[daemon] removed a stale daemon pointer (its process is gone or not answering)')
}

const config = new ConfigStore(paths)
const characterName = config.getPath('character') || 'kurisu'
const persona = loadPersona(characterName)
const characterContent = loadCharacterContent(characterName)
const taskLinePicker = new TaskLinePicker(Math.random, characterContent.taskLines)
const secrets = new SecretStore(paths)
const audit = new AuditLog(paths)
// Warm the selected clone while the panel loads. Only record startup phases,
// never reference audio, speech text or local service paths.
if (config.getPath('voice.enabled') && config.getPath('voice.provider') === 'qwen-local') {
  void ensureLocalQwen(paths, {
    onStatus: (phase) => audit.record({ source: 'voice', tool: 'qwen.startup', summary: phase }),
  }).then((ready) => {
    if (!ready) log.warn('[qwen] prewarm could not start the local service')
  }).catch((error) => {
    log.warn('[qwen] prewarm failed:', error && error.message ? error.message : error)
  })
}
const sessions = new SessionStore(paths)
const memory = new MemoryStore(paths, config)
// Optional last-resort channel for when no panel is open to speak the line.
const systemTts = new SystemTts()
// 默认 + 导入：the voice list is the built-in default plus user imports.
const voices = new VoiceLibrary(paths)
const tts = new TtsService({ paths, config, secretStore: secrets, voices, systemTts })
const stt = new SttService({ config, secretStore: secrets })
const llm = createLlmRouter({ paths, getConfig: () => config.get(), secretStore: secrets })
const hub = new EventHub()
const assets = new AssetManager({ paths, config, audit, hub })

// --- proactive scheduler ---------------------------------------------------
// State is persisted so a restart does not immediately "call" the user again,
// and so a machine that was asleep does not wake up to a backlog of calls.
const proactiveFile = path.join(paths.dataRoot, 'proactive.json')
const proactiveState = Object.assign(
  { lastCallAt: 0, callCount: 0, lastUserAt: 0, lastProactiveAt: 0 },
  readJson(proactiveFile, {}),
)

const proactive = new ProactiveScheduler({
  config,
  characterContent,
  personaText: persona.text,
  state: proactiveState,
  persist: (state) => {
    try {
      writeJsonAtomic(proactiveFile, state)
    } catch (e) {
      log.warn('[scheduler] failed to persist state:', e && e.message ? e.message : e)
    }
  },
  hasAudience: () => hub.status().clients > 0,
  isBusy: () => chat.isRunning(),
  complete: async (system) => {
    const adapter = llm.pick(config.getPath('chat.provider'))
    const res = await adapter.chat({ system, history: [], user: '（现在请按格式开口）' })
    return res.text
  },
  deliver: ({ kind, jp, cn, emotion }) => {
    hub.enqueueUtterance({
      text: jp,
      cn,
      emotion,
      expr: EMOTION_EXPR[emotion] || '',
      kind,
    })
    audit.record({ source: 'scheduler', tool: kind, summary: cn.slice(0, 80) })
    log.info(`[scheduler] ${kind}: ${jp}`)
  },
  report: (level, msg, detail) => {
    log[level === 'error' ? 'error' : 'warn']('[scheduler]', msg, detail || '')
    // The daemon runs detached with stdio ignored, so stderr is unreachable in
    // practice. Record degradations in the audit log too, otherwise the reason
    // a generated line fell back to a canned one is simply lost.
    audit.record({
      source: 'scheduler',
      tool: level === 'error' ? 'error' : 'degraded',
      summary: detail ? `${msg}: ${detail}` : msg,
    })
  },
})

// One minute is granular enough for intervals measured in hours, and cheap.
const proactiveTimer = setInterval(() => {
  proactive.tick().catch((e) => log.warn('[scheduler] tick rejected:', e && e.message ? e.message : e))
}, 60000)
proactiveTimer.unref?.()

const chat = new ChatEngine({ sessions, memory, llm, config, audit, personaName: persona.name })

// --- task interactions ------------------------------------------------------
const TASK_FLAGS = {
  start: 'broadcast.onTaskStart',
  complete: 'broadcast.onTaskComplete',
  failed: 'broadcast.onTaskFailed',
}

/**
 * Turn ids already announced.
 *
 * A Desktop turn is announced from the rollout watcher, a CLI turn from the
 * notify hook - and both carry the same turn id, so this is what keeps a `codex
 * exec` task from being announced twice.
 */
const announcedTurns = new Map()
const ANNOUNCED_LIMIT = 300

/** Keyed by turn *and* boundary: "she started" and "she finished" are different lines. */
function turnKey(turnId, kind) {
  return `${String(turnId)}:${String(kind)}`
}

function rememberTurn(turnId, kind) {
  if (!turnId) return
  announcedTurns.set(turnKey(turnId, kind), Date.now())
  while (announcedTurns.size > ANNOUNCED_LIMIT) {
    const oldest = announcedTurns.keys().next().value
    announcedTurns.delete(oldest)
  }
}

function alreadyAnnouncedTurn(turnId, kind, now = Date.now()) {
  if (!turnId || !kind) return false
  const at = announcedTurns.get(turnKey(turnId, kind))
  return Boolean(at) && now - at < 10 * 60 * 1000
}

/**
 * Say something about a task boundary.
 *
 * @returns {boolean} whether a line was queued
 */
function announceTask(kind, { turnId = null, source = 'task' } = {}) {
  if (config.getPath('broadcast.enabled') !== true) return false
  const flag = TASK_FLAGS[kind]
  if (!flag || config.getPath(flag) !== true) return false
  if (config.getPath('voice.enabled') !== true) return false
  if (alreadyAnnouncedTurn(turnId, kind)) return false
  const line = taskLinePicker.next(kind)
  if (!line) return false
  hub.enqueueUtterance({
    text: line.text,
    cn: line.cn,
    emotion: line.emotion,
    expr: EMOTION_EXPR[line.emotion] || '',
    kind: 'broadcast',
  })
  rememberTurn(turnId, kind)
  audit.record({ source, tool: `task.${kind}`, summary: turnId ? String(turnId).slice(0, 12) : '' })
  return true
}

/**
 * Which turn is the user's own.
 *
 * While the agent works it spawns `codex exec` helpers, and each of those is
 * its own session with its own boundaries. Announcing them made "目标达成"
 * appear in the middle of the task the user was watching, so only the outermost
 * turn is spoken about; a nested boundary is recorded in the audit and skipped.
 */
const activeTurns = new ActiveTurnLedger()

/**
 * Desktop turns never reach the notify hook, so their boundaries are read from
 * Codex's own session rollouts (read-only file tail).
 */
const taskWatcher = new TaskWatcher({
  sessionsRoot: process.env.AMADEUS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions'),
  dataRoot: paths.dataRoot,
  onEvent: ({ kind, turnId }) => {
    // Rollout metadata identifies subagents directly. Independent Desktop
    // chats may overlap, so overlap alone must not silence either task.
    activeTurns.observe({ kind, turnId })
    const said = announceTask(kind, { turnId, source: 'task-watch' })
    if (!said) log.info(`[task-watch] ${kind} ${String(turnId).slice(0, 8)} not announced`)
  },
  log: (message) => log.warn(`[task-watch] ${message}`),
})
taskWatcher.start()

// The same event contract is exercised in isolation by tests.
wireChatEvents({ chat, hub, config, memory, log })

const diag = (opts) => runDiagnostics({ ...opts, llm, assets, stt, systemTts })

const daemon = createDaemon({
  paths,
  characterContent,
  taskLinePicker,
  config,
  secrets,
  sessions,
  memory,
  audit,
  chat,
  tts,
  stt,
  systemTts,
  voices,
  llm,
  hub,
  assets,
  proactive,
  diag,
  // Both announcement paths share one turn-id ledger, so a CLI turn that the
  // hook already announced is not repeated by the rollout watcher.
  onTaskAnnounced: ({ turnId, kind }) => rememberTurn(turnId, kind),
  isTurnAnnounced: ({ turnId, kind }) => alreadyAnnouncedTurn(turnId, kind),
  hasActiveTask: () => activeTurns.hasActive(),
  version: APP_VERSION,
})

const info = await daemon.start()
log.info(`[daemon] panel listening on port ${info.port}`)

const shutdown = async () => {
  try {
    // Stop talking before exiting, otherwise the speech process outlives us.
    systemTts.shutdown()
    taskWatcher.stop()
    await daemon.stop()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
