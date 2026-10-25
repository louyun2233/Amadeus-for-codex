import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCodex } from './llm.mjs'
import { probe as probeEdge } from './edge-tts.mjs'
import { ensureIncomingRing } from './sounds.mjs'
import { findNotifyArray, isOurNotifyCommand } from './codex-config.mjs'
import { CODES, degrade } from './codes.mjs'
import { readOwnership, PRODUCT } from '../shared/layout.mjs'
import { nativeWindowExecutable } from '../host/panel-launcher.mjs'
import { characterSourceFile } from './character.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NOTIFY_HOOK = path.resolve(HERE, '..', '..', 'bin', 'amadeus-notify.mjs')
/** Resolved per call so a test (or a portable install) can point it anywhere. */
function codexConfigPath() {
  return process.env.AMADEUS_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml')
}

function checkFile(file) {
  try {
    const st = fs.statSync(file)
    return { present: true, bytes: st.size }
  } catch {
    return { present: false, bytes: 0 }
  }
}

/**
 * Capability self-check. The DSH version only probed sandbox write access and
 * left users guessing why there was no sound; this reports every prerequisite
 * that the main path and each optional provider actually needs.
 *
 * Every failure carries a stable `AM-xxxx` code (see `codes.mjs`), so a report
 * can be compared between runs and pasted into an issue without guesswork.
 */
export async function runDiagnostics({
  paths,
  config,
  secrets,
  tts,
  stt,
  systemTts,
  llm,
  hub,
  assets,
  deep = false,
} = {}) {
  const out = { ok: true, checks: {}, degrade: [] }

  out.checks.node = {
    ok: Number(process.versions.node.split('.')[0]) >= 22,
    version: process.versions.node,
  }

  // writability of our own data directory (no elevation involved)
  const probeFile = path.join(paths.tmpDir, 'diag-probe.json')
  try {
    fs.mkdirSync(paths.tmpDir, { recursive: true })
    fs.writeFileSync(probeFile, JSON.stringify({ at: Date.now() }), { mode: 0o600 })
    fs.unlinkSync(probeFile)
    out.checks.dataDir = { ok: true, path: paths.dataRoot }
  } catch (e) {
    out.checks.dataDir = { ok: false, path: paths.dataRoot, reason: e.message }
    out.ok = false
      out.degrade.push(
        degrade(CODES.DATA_DIR_UNWRITABLE, {
          capability: 'storage',
          reason: e.message,
          action: 'check permissions on the data directory, or move it with AMADEUS_DATA_DIR',
        }),
      )
  }

    // Ownership marker: written on first start, and the thing a future cleanup
    // step can require before touching anything.
    const ownership = readOwnership(paths)
    out.checks.storage = {
      ok: Boolean(ownership),
      product: ownership?.product || null,
      expectedProduct: PRODUCT,
      schema: ownership?.schema || null,
      dataRoot: paths.dataRoot,
      cacheRoot: paths.cacheRoot,
    }
    if (!ownership) {
      out.degrade.push(
        degrade(CODES.LAYOUT_UNOWNED, {
          capability: 'storage',
          reason: 'storage-layout.json is missing or belongs to another product',
          action: 'start the daemon once (it rewrites the marker), or delete the data directory',
        }),
      )
    }

  const codex = await resolveCodex()
  out.checks.codexCli = { ok: Boolean(codex), path: codex || null }
  if (!codex) {
      out.degrade.push(
        degrade(CODES.CODEX_CLI_MISSING, {
          capability: 'chat',
          reason: 'codex CLI not found',
          action: 'install Codex CLI, or set a dedicated chat API key',
        }),
      )
  }

  if (llm) {
    out.checks.llm = await llm.describe()
    if (!out.checks.llm['codex-exec']?.available) out.ok = out.ok && true
  }

    // The persona ships with the project, not with the user data: it used to be
    // probed one directory above the data root, which is never where it lives
    // and made every report claim the persona was missing.
    out.checks.persona = checkFile(characterSourceFile(config.getPath('character') || 'kurisu', 'md'))
    out.checks.characterContent = checkFile(characterSourceFile(config.getPath('character') || 'kurisu', 'json'))

  if (assets) {
    const assetStatus = assets.status()
    const model = assetStatus.activeModel
    out.checks.live2dModel = {
      ok: Boolean(model?.installed),
      installed: Boolean(model?.installed),
      version: model?.version || null,
      expectedSha256: model?.expectedSha256 || null,
      entry: model?.entry || null,
    }
    if (!model?.installed) {
        out.degrade.push(
          degrade(CODES.MODEL_MISSING, {
            capability: 'live2d',
            reason: 'model not installed',
            action: 'run `amadeus assets install` (or use the panel button)',
          }),
        )
    }
  }

    // The ring is what makes an incoming call audible at all.
    const ring = ensureIncomingRing(paths)
    out.checks.ringSound = { ok: ring.ok, source: ring.source, bytes: ring.bytes, path: ring.path || null }
    if (!ring.ok) {
      out.degrade.push(
        degrade(CODES.RING_SOUND_MISSING, {
          capability: 'call-ring',
          reason: ring.reason || 'no ring sound',
          action: 'drop a wav/mp3 into <data>/sounds/incoming.*, or restore the Windows media sounds',
        }),
      )
    }

    const native = nativeWindowExecutable()
    const python = path.resolve(HERE, '..', '..', '.native-venv', 'Scripts', 'pythonw.exe')
    const nativeReady = Boolean(native && fs.existsSync(python))
    out.checks.panelNative = { ok: nativeReady, launcher: native || null, python: fs.existsSync(python) }
    if (!nativeReady) {
      out.degrade.push(
        degrade(CODES.PANEL_NATIVE_MISSING, {
          capability: 'panel',
          reason: 'native Qt/OpenGL panel is not installed',
          action: 'run 安装 Amadeus.cmd to install the native panel',
        }),
      )
    }

    // Codex rewrites its own config on update; the watcher repairs it, but the
    // check has to be able to say out loud that it is currently missing.
    let hookInstalled = false
    try {
      const configText = fs.readFileSync(codexConfigPath(), 'utf8')
      const found = findNotifyArray(configText)
      hookInstalled = Boolean(found) && isOurNotifyCommand(found.parts, NOTIFY_HOOK)
    } catch {
      hookInstalled = false
    }
    out.checks.notifyHook = { ok: hookInstalled, configPath: codexConfigPath() }
    if (!hookInstalled) {
      out.degrade.push(
        degrade(CODES.NOTIFY_HOOK_MISSING, {
          capability: 'broadcast',
          reason: 'Codex config.toml does not point notify at amadeus-notify.mjs',
          action: 'run `node bin/amadeus-hook.mjs ensure` (the watcher does this on its own)',
        }),
      )
    }

  out.checks.secrets = secrets ? secrets.describeAll() : {}
  out.checks.voice = tts
    ? { provider: tts.providerId(), name: config?.getPath('voice.name') || '', ...tts.stats() }
    : {}
  out.checks.speechInput = stt ? stt.describe() : {}
  if (stt && !stt.isReady()) {
      out.degrade.push(
        degrade(CODES.SPEECH_INPUT_NOT_READY, {
          capability: 'speech-input',
          reason: stt.describe().reason,
          action: 'check Windows speech recognition and microphone permissions',
        }),
      )
  }
  out.checks.systemTts = systemTts ? systemTts.describe() : {}
  if (systemTts && config?.getPath('broadcast.systemTts') === true && !systemTts.available()) {
      out.degrade.push(
        degrade(CODES.SYSTEM_TTS_UNAVAILABLE, {
          capability: 'system-tts',
          reason: systemTts.describe().reason || 'no system speech command on this platform',
          action: 'turn "system broadcast" off in the panel, or install a system voice',
        }),
      )
  }
  out.checks.events = hub ? hub.status() : {}
  out.checks.voiceEnabled = config?.getPath('voice.enabled') === true

  if (deep) {
    // The Edge relay is probed with an actual Edge voice: the configured one
    // may belong to another provider (阿里云 "Cherry"), and the server answers
    // an unknown voice with close code 1007 - which used to read as "the voice
    // service is down".
    const configured = config?.getPath('voice.name') || ''
    out.checks.edgeTts = await probeEdge({
      voice: /Neural$/.test(configured) ? configured : 'ja-JP-NanamiNeural',
    })
    if (!out.checks.edgeTts.ok) {
        out.degrade.push(
          degrade(CODES.EDGE_TTS_UNREACHABLE, {
            capability: 'voice',
            reason: out.checks.edgeTts.reason,
            action: 'this is the built-in fallback voice; check network access to speech.platform.bing.com',
          }),
        )
    }
  }

  return out
}
