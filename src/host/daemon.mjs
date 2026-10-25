import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAuth } from './auth.mjs'
import { createChatRoutes } from './chat-routes.mjs'
import { createMemoryRoutes } from './memory-routes.mjs'
import { createVoiceRoutes } from './voice-routes.mjs'
import { ping } from './daemon-client.mjs'
import { maskConfig } from '../core/config.mjs'
import { STT_MAX_BYTES } from '../core/stt.mjs'
import { ensureIncomingRing, mediaEffectPath, contentTypeFor } from '../core/sounds.mjs'
import { ErrorCode } from '../shared/errors.mjs'
import { APP_VERSION } from '../shared/version.mjs'
import { taskLinePicker } from '../core/task-lines.mjs'
import { log, createChildLogger } from '../shared/log.mjs'

const logger = createChildLogger('[daemon]')
const MAX_BODY = 1024 * 1024

/**
 * Panel tabs identify themselves with a per-tab id (sessionStorage on the
 * client). The SSE stream carries it as a query parameter because EventSource
 * cannot set headers; regular requests carry it as a header.
 */
function clientIdOf(req, url) {
  const fromHeader = req.headers['x-amadeus-client']
  if (typeof fromHeader === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(fromHeader)) return fromHeader
  const fromQuery = url.searchParams.get('client')
  if (typeof fromQuery === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(fromQuery)) return fromQuery
  return null
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.moc': 'application/octet-stream',
  '.moc3': 'application/octet-stream',
  '.model.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

/**
 * Read a request body with a hard cap.
 *
 * On overflow the stream keeps being drained and discarded instead of being
 * destroyed: destroying the socket makes the caller's 4xx response unreachable
 * (the client sees ECONNRESET instead of "too large"), which is exactly the
 * failure mode a client-side upload limit is supposed to avoid.
 */
function collectBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        if (!overflowed) {
          overflowed = true
          reject(Object.assign(new Error(`body too large (max ${max} bytes)`), { status: 413 }))
        }
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (overflowed) return
      if (chunks.length === 0) return resolve({})
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

async function readBody(req, max = MAX_BODY) {
  const raw = await collectBody(req, max)
  if (Buffer.isBuffer(raw) === false) return raw
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (e) {
    throw new Error('invalid json body')
  }
}

/**
 * Binary variant of readBody, for the one route that carries audio.
 * The cap is enforced while streaming, so an oversized upload is never held in
 * memory in full.
 */
async function readRaw(req, max) {
  const raw = await collectBody(req, max)
  return Buffer.isBuffer(raw) ? raw : Buffer.from([])
}

export function createDaemon(deps) {
  const {
    paths,
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
    hub,
    diag,
    assets,
    proactive,
    version = APP_VERSION,
  } = deps

  const token = crypto.randomBytes(32).toString('base64url')
  const auth = createAuth(token)
  let server = null
  let port = 0
  let runtimeTimer = null
  // Ring buffer of client-side errors. Without this a panel crash is invisible:
  // it only reaches the browser console, which the user never opens.
  const clientReports = []

  const guard = (handler) => async (req, res, url, ctx) => {
    try {
      await handler(req, res, url, ctx)
    } catch (e) {
      const code =
        e && e.code === ErrorCode.INVALID_ARGUMENT ? 400 : Number(e && e.status) || 500
      logger.warn('route error:', e && e.message ? e.message : e)
      if (!res.headersSent) sendJson(res, code, { ok: false, error: e.message || String(e) })
      else res.end()
    }
  }

  const routes = {
    'GET /amadeus/health': guard(async (req, res) => {
      sendJson(res, 200, { ok: true, version, uptimeMs: Math.round(process.uptime() * 1000) })
    }),

    'GET /amadeus/status': guard(async (req, res) => {
      sendJson(res, 200, {
        ok: true,
        version,
        config: maskConfig(config.get()),
        // only ever "configured / where from" — the values never leave the daemon
        secrets: secrets.describeAll(),
        // where speech-to-text would run if the mic is pressed right now
        speechInput: stt ? stt.describe() : null,
        voice: tts.stats(),
        events: hub.status(),
        sessions: sessions.list().length,
        memory: memory.stats(),
        characterContent: deps.characterContent
          ? { displayName: deps.characterContent.displayName, callName: deps.characterContent.callName,
              welcome: deps.characterContent.welcome, tapReactions: deps.characterContent.tapReactions }
          : null,
      })
    }),

    'GET /amadeus/config': guard(async (req, res) => {
      sendJson(res, 200, { ok: true, config: maskConfig(config.get()), secrets: secrets.describeAll() })
    }),

    'PATCH /amadeus/config': guard(async (req, res) => {
      const body = await readBody(req)
      const { config: next, rejected } = config.update(body?.patch ?? body)
      audit.record({ source: 'panel', tool: 'config.update', summary: Object.keys(body?.patch ?? body).join(',') })
      hub.broadcast('config', { config: maskConfig(next) })
      sendJson(res, 200, { ok: true, config: maskConfig(next), rejected })
    }),

    ...createChatRoutes({ guard, readBody, sendJson, sessions, chat, config, proactive, clientIdOf }),

    'POST /amadeus/say': guard(async (req, res) => {
      const body = await readBody(req)
      const item = hub.enqueueUtterance({
        text: body?.text,
        cn: body?.cn,
        emotion: body?.emotion,
        expr: body?.expr,
        kind: 'say',
      })
      if (!item) return sendJson(res, 400, { ok: false, error: 'missing text' })
      proactive?.noteInteraction()
      audit.record({ source: 'panel', tool: 'say', summary: String(body?.text).slice(0, 60) })
      sendJson(res, 200, { ok: true, utterance: item })
    }),

    'POST /amadeus/utterance/ack': guard(async (req, res) => {
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, ...hub.ack(body?.id, body?.status || 'ok', body?.detail) })
    }),

    // A greeting must not enter the playback queue until the chosen clone can
    // actually synthesize it. This prewarms the same cache entry, without
    // switching providers or playing any audio.
    'POST /amadeus/tts/prepare': guard(async (req, res) => {
      const body = await readBody(req)
      if (tts.providerId() !== 'qwen-local') {
        return sendJson(res, 200, { ok: true, ready: true })
      }
      await tts.synthesize(body?.text || '', { emotion: body?.emotion })
      sendJson(res, 200, { ok: true, ready: true })
    }),

    'POST /amadeus/call': guard(async (req, res) => {
      const body = await readBody(req)
      const item = hub.enqueueUtterance({
        text: body?.text || 'ねぇ、起きてる？',
        cn: body?.cn || '喂，你醒着吗？',
        emotion: body?.emotion || 'soft',
        kind: 'call',
      })
      audit.record({ source: 'panel', tool: 'call', summary: body?.reason || 'manual' })
      proactive?.noteInteraction()
      sendJson(res, 200, { ok: true, utterance: item })
    }),

    'GET /amadeus/tts': guard(async (req, res, url) => {
      const text = url.searchParams.get('text') || ''
      const emotion = url.searchParams.get('emotion') || 'neutral'
      if (!text) return sendJson(res, 400, { ok: false, error: 'missing text' })
      const result = await tts.synthesize(text, {
        voice: url.searchParams.get('voice') || undefined,
        emotion,
      })
      const words = Array.isArray(result.words) ? result.words : []
      res.writeHead(200, {
        'Content-Type': result.mime || 'audio/mpeg',
        'Content-Length': result.audio.length,
        'Cache-Control': 'public, max-age=3600',
        'X-Amadeus-Words': Buffer.from(JSON.stringify(words)).toString('base64'),
        'X-Amadeus-Cache': result.cached ? 'hit' : 'miss',
        'X-Amadeus-Provider': tts.providerId(),
      })
      res.end(result.audio)
    }),

    /**
     * The incoming-call ring.
     *
     * Only ever served from our own data directory: the Windows mail sound is
     * imported into `<data>/sounds` once, a file the user drops in next to it
     * wins, and nothing here accepts a path from the caller.
     */
    'GET /amadeus/sound/incoming': guard(async (req, res) => {
      const ring = ensureIncomingRing(paths)
      if (!ring.ok || !ring.path) {
        return sendJson(res, 404, { ok: false, error: 'no ring sound', reason: ring.reason || null })
      }
      let audio
      try {
        audio = fs.readFileSync(ring.path)
      } catch (e) {
        return sendJson(res, 404, {
          ok: false,
          error: 'ring unreadable',
          reason: e && e.message ? e.message : null,
        })
      }
      res.writeHead(200, {
        'Content-Type': contentTypeFor(ring.path),
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
        'X-Amadeus-Ring': ring.source,
      })
      res.end(audio)
    }),

    'GET /amadeus/sound/media': guard(async (req, res, url) => {
      const file = mediaEffectPath(paths, url.searchParams.get('event'))
      if (!file) return sendJson(res, 404, { ok: false, error: 'media sound unavailable' })
      const audio = fs.readFileSync(file)
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': audio.length,
        'Cache-Control': 'public, max-age=3600',
      })
      res.end(audio)
    }),

    ...createMemoryRoutes({ guard, readBody, sendJson, memory, audit, hub }),

    'POST /amadeus/notify': guard(async (req, res) => {
      const body = await readBody(req)
      // A turn this panel started is already answered out loud by the chat
      // pipeline. Announcing "task complete" on top of it made her say two
      // different things at once, so panel-originated turns never broadcast.
      if (body?.origin === 'panel') {
        audit.record({ source: 'daemon', tool: 'notify.panel-origin', summary: String(body?.type || '') })
        return sendJson(res, 200, { ok: true, kind: body?.kind || 'unknown', broadcasted: false, reason: 'panel-origin' })
      }
      // A `codex exec` that finishes while the user's own turn is still running
      // is a helper, not a task: announcing it said "目标达成" in the middle of
      // the work the user was watching.
      if (deps.hasActiveTask?.()) {
        audit.record({ source: 'daemon', tool: 'notify.nested', summary: String(body?.turnId || body?.type || '').slice(0, 16) })
        return sendJson(res, 200, { ok: true, kind: body?.kind || 'unknown', broadcasted: false, reason: 'nested-turn' })
      }
      const enabled = config.getPath('broadcast.enabled') === true
      const kind = body?.kind || 'unknown'
      // The rollout watcher may have announced this very turn already (Desktop
      // and CLI turns carry the same turn id): never say it twice.
      const boundary = kind === 'task-failed' ? 'failed' : 'complete'
      if (body?.turnId && deps.isTurnAnnounced?.({ turnId: body.turnId, kind: boundary })) {
        return sendJson(res, 200, { ok: true, kind, broadcasted: false, reason: 'already-announced' })
      }
      const want =
        enabled &&
        config.getPath('voice.enabled') === true &&
        ((kind === 'task-complete' && config.getPath('broadcast.onTaskComplete') === true) ||
          (kind === 'task-failed' && config.getPath('broadcast.onTaskFailed') === true))
      let utterance = null
      let system = null
      if (want) {
        const line = (deps.taskLinePicker || taskLinePicker).next(boundary)
        // The panel queue is always filled first: it is the fallback when the
        // system voice is missing, and the only channel when a panel is open.
        utterance = hub.enqueueUtterance({ ...line, kind: 'broadcast' })
        deps.onTaskAnnounced?.({ kind: boundary, turnId: body?.turnId || null, source: 'notify' })
        // The watcher path audits its own announcements; this one has to as
        // well, otherwise "did she say anything?" cannot be answered from the
        // audit trail alone.
        audit.record({
          source: 'daemon',
          tool: `notify.${boundary}`,
          summary: String(body?.turnId || body?.type || '').slice(0, 16),
        })
        const wantsSystem = config.getPath('broadcast.systemTts') === true
        const panelOpen = hub.status().clients > 0
        // Never replace the selected clone with a Windows system voice.
        if (wantsSystem && config.getPath('voice.provider') === 'qwen-local') {
          system = 'clone-panel-only'
        } else if (wantsSystem && !panelOpen && systemTts?.available()) {
          system = 'speaking'
          // Deliberately not awaited: the notify hook must not wait seconds for
          // a sentence to finish.
          systemTts
            .speak(line.cn || line.text)
            .then((result) => {
              if (result.ok) {
                // Already said out loud: drop the queued item so opening the
                // panel later does not repeat it.
                hub.ack(utterance.id)
              } else {
                audit.record({
                  source: 'daemon',
                  tool: 'system-tts',
                  summary: result.degrade || 'failed',
                })
              }
            })
            .catch(() => {})
        } else if (wantsSystem) {
          system = panelOpen ? 'panel-open' : 'no-system-voice'
        }
      }
      sendJson(res, 200, {
        ok: true,
        kind,
        broadcasted: Boolean(utterance),
        systemTts: system,
        enabled,
      })
    }),

    'POST /amadeus/report': guard(async (req, res) => {
      const body = await readBody(req)
      const entry = {
        ts: Date.now(),
        level: ['error', 'warn', 'info'].includes(body?.level) ? body.level : 'info',
        message: String(body?.message ?? '').slice(0, 300),
        detail: String(body?.detail ?? '').slice(0, 1000),
        where: String(body?.where ?? '').slice(0, 120),
      }
      if (entry.message.length > 0) {
        clientReports.push(entry)
        if (clientReports.length > 100) clientReports.shift()
        if (entry.level === 'error') {
          audit.record({ source: 'panel', tool: 'client.error', summary: entry.message })
          logger.warn('client error:', entry.message, entry.where)
        }
      }
      sendJson(res, 200, { ok: true })
    }),

    'GET /amadeus/logs': guard(async (req, res, url) => {
      const limit = Number(url.searchParams.get('limit') || 50)
      sendJson(res, 200, { ok: true, client: clientReports.slice(-limit) })
    }),

    'GET /amadeus/diag': guard(async (req, res, url) => {
      const deep = url.searchParams.get('deep') === '1'
      const result = await diag({ paths, config, secrets, tts, stt, llm: deps.llm, hub, deep })
      sendJson(res, 200, result)
    }),

    'GET /amadeus/assets/status': guard(async (req, res) => {
      if (!assets) return sendJson(res, 503, { ok: false, error: 'asset manager unavailable' })
      sendJson(res, 200, assets.status())
    }),

    'GET /amadeus/proactive': guard(async (req, res) => {
      if (!proactive) return sendJson(res, 503, { ok: false, error: 'scheduler unavailable' })
      sendJson(res, 200, { ok: true, ...proactive.status(), clients: hub.status().clients })
    }),

    'POST /amadeus/proactive/tick': guard(async (req, res) => {
      if (!proactive) return sendJson(res, 503, { ok: false, error: 'scheduler unavailable' })
      const decision = await proactive.tick()
      sendJson(res, 200, { ok: true, decision, ...proactive.status() })
    }),

    // A tab claims audio when it gains focus, so speech follows the window the
    // user is actually looking at instead of the first tab that happened to open.
    'POST /amadeus/client/active': guard(async (req, res, url) => {
      const clientId = clientIdOf(req, url)
      if (!clientId) return sendJson(res, 400, { ok: false, error: 'missing client id' })
      sendJson(res, 200, { ok: true, ...hub.claimAudio(clientId) })
    }),

    // The one write path for credentials. The value goes in and never comes
    // back: the response is the same describe() the status route exposes.
    'POST /amadeus/secrets': guard(async (req, res) => {
      const body = await readBody(req)
      const name = String(body?.name ?? '').trim()
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' })
      try {
        secrets.set(name, body?.value ?? '')
      } catch (e) {
        const status = e && e.code === ErrorCode.INVALID_ARGUMENT ? 400 : 409
        return sendJson(res, status, { ok: false, error: e.message, degrade: e.degrade || null })
      }
      audit.record({ source: 'panel', tool: 'secrets.set', summary: name })
      sendJson(res, 200, { ok: true, secret: secrets.describe(name) })
    }),

    ...createVoiceRoutes({ guard, readBody, sendJson, voices, systemTts, config, secrets, audit }),

    // Speech-to-text. The recording is forwarded, never stored: the transcript
    // is the only thing that comes back. With `provider: browser` the daemon
    // refuses (`use-browser`) so the panel keeps its own recognition path.
    'POST /amadeus/stt': guard(async (req, res) => {
      if (!stt) return sendJson(res, 503, { ok: false, error: 'speech input unavailable' })
      let audio
      try {
        audio = await readRaw(req, STT_MAX_BYTES)
      } catch (e) {
        return sendJson(res, 413, { ok: false, error: e.message, degrade: 'audio-too-large' })
      }
      try {
        const out = await stt.transcribe(audio, {
          mime: req.headers['content-type'] || '',
          lang: config.getPath('speechInput.lang'),
        })
        // Byte count only: a transcript is private conversation content.
        audit.record({ source: 'panel', tool: 'stt.transcribe', summary: `${audio.length} bytes` })
        sendJson(res, 200, { ok: true, ...out })
      } catch (e) {
        const status =
          e.code === ErrorCode.INVALID_ARGUMENT ? 400 : e.code === ErrorCode.DEGRADED ? 409 : 502
        sendJson(res, status, { ok: false, error: e.message, degrade: e.degrade || null })
      }
    }),

    'POST /amadeus/assets/install': guard(async (req, res) => {
      if (!assets) return sendJson(res, 503, { ok: false, error: 'asset manager unavailable' })
      const body = await readBody(req)
      // Never accept a URL from the caller: only a registry pack id.
      if (body?.packId) {
        const result = await assets.install(String(body.packId), { force: body?.force === true })
        return sendJson(res, 200, result)
      }
      const result = await assets.installAll({ force: body?.force === true })
      sendJson(res, 200, result)
    }),

    'POST /amadeus/assets/verify': guard(async (req, res) => {
      if (!assets) return sendJson(res, 503, { ok: false, error: 'asset manager unavailable' })
      sendJson(res, 200, assets.verify())
    }),

    // Bring your own model: the caller names a local file instead of letting us
    // download one. The registry hash still has to match, so this cannot be used
    // to slip arbitrary content into the model directory.
    'POST /amadeus/assets/install-file': guard(async (req, res) => {
      if (!assets) return sendJson(res, 503, { ok: false, error: 'asset manager unavailable' })
      const body = await readBody(req)
      const packId = String(body?.packId ?? '').trim()
      const file = String(body?.path ?? '').trim()
      if (!packId || !file) return sendJson(res, 400, { ok: false, error: 'missing packId or path' })
      const result = await assets.installFromFile(packId, file)
      audit.record({ source: 'cli', tool: 'assets.install-file', summary: `${packId} <- ${file}` })
      sendJson(res, 200, result)
    }),

    'POST /amadeus/action': guard(async (req, res) => {
      const body = await readBody(req)
      const cmd = body?.cmd
      if (cmd === 'ping') return sendJson(res, 200, { ok: true, pong: Date.now() })
      if (cmd === 'clear') {
        // stops the current speech queue; the hub broadcasts `cleared` so the
        // panel can drop anything it has locally buffered too
        sendJson(res, 200, { ok: true, ...hub.clear() })
        return
      }
      if (cmd === 'shutdown') {
        sendJson(res, 200, { ok: true, shuttingDown: true })
        // stop() closes the listener and removes the runtime file; the process
        // itself must exit explicitly or the event loop keeps it alive.
        setTimeout(async () => {
          await stop()
          process.exit(0)
        }, 150)
        return
      }
      sendJson(res, 400, { ok: false, error: `unknown cmd: ${cmd}` })
    }),
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const pathname = url.pathname

    const key = `${req.method} ${pathname}`
    const route = routes[key]

    const authResult = auth.check(req, url)
    if (!authResult.ok) {
      return sendJson(res, authResult.status, { ok: false, error: authResult.reason })
    }

    const headers = {}
    if (authResult.kind === 'token-exchange' && authResult.sessionId) {
      headers['Set-Cookie'] = auth.cookieHeader(authResult.sessionId)
    }

    // SSE stream
    if (req.method === 'GET' && pathname === '/amadeus/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...headers,
      })
      res.write('retry: 3000\n\n')
      const remove = hub.addClient(res, clientIdOf(req, url))
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {
          /* ignore */
        }
      }, 25000)
      keepAlive.unref?.()
      req.on('close', () => {
        clearInterval(keepAlive)
        remove()
      })
      return
    }

    if (route) {
      if (Object.keys(headers).length > 0) res.setHeader('Set-Cookie', headers['Set-Cookie'])
      return route(req, res, url)
    }

    // dynamic session routes: /amadeus/sessions/:id[/messages]
    const sessionMatch = pathname.match(/^\/amadeus\/sessions\/([A-Za-z0-9_-]{4,80})(\/messages)?$/)
    if (sessionMatch) {
      const id = sessionMatch[1]
      const isMessages = Boolean(sessionMatch[2])
      try {
        if (isMessages && req.method === 'GET') {
          const session = sessions.get(id)
          return sendJson(res, 200, {
            ok: true,
            session: { id: session.id, name: session.name, summary: session.summary },
            messages: session.messages.slice(-200),
          })
        }
        if (!isMessages && req.method === 'PATCH') {
          const body = await readBody(req)
          const session = sessions.rename(id, body?.name)
          return sendJson(res, 200, { ok: true, session })
        }
        if (!isMessages && req.method === 'DELETE') {
          const result = sessions.remove(id)
          audit.record({ source: 'panel', tool: 'session.remove', summary: id })
          return sendJson(res, 200, { ok: true, ...result })
        }
      } catch (e) {
        const status = e && e.code === ErrorCode.NOT_FOUND ? 404 : 400
        return sendJson(res, status, { ok: false, error: e.message })
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }

    if (req.method === 'GET' && pathname.startsWith('/amadeus/assets/')) {
      const rel = pathname.slice('/amadeus/assets/'.length)
      // Only the two logical namespaces are served. The manager resolves them
      // against the manifest and re-checks containment; there is no way to ask
      // for an arbitrary path in the cache tree.
      let file = null
      if (rel.startsWith('runtime/')) file = assets?.resolveRuntime(rel.slice('runtime/'.length))
      else if (rel.startsWith('current/')) file = assets?.resolveCurrent(rel.slice('current/'.length))
      if (!file) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      return serveStatic(res, file, headers)
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'not found', path: pathname }))
  }

  function serveStatic(res, file, extraHeaders = {}) {
    let data
    try {
      data = fs.readFileSync(file)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      ...extraHeaders,
    })
    res.end(data)
  }

  function urlForPanel() {
    return `http://127.0.0.1:${port}/amadeus/panel/index.html?token=${token}`
  }

  async function start() {
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        logger.error('unhandled request error:', e && e.message ? e.message : e)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
      })
    })

    // Prefer the port the previous run used: a panel window that is still open
    // then keeps pointing at a live address instead of a dead one.
    // daemon.json is removed on shutdown, so the port is remembered separately.
    const portFile = path.join(paths.runtimeDir, 'last-port.txt')
    let previousPort = 0
    try {
      const saved = Number(fs.readFileSync(portFile, 'utf8').trim())
      if (Number.isInteger(saved) && saved > 0 && saved < 65536) previousPort = saved
    } catch {
      /* first start */
    }
    const listen = (candidate) =>
      new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener('listening', onListening)
          reject(e)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(candidate, '127.0.0.1')
      })
    try {
      await listen(previousPort)
    } catch {
      if (previousPort) await listen(0)
      else throw new Error('could not bind the loopback port')
    }
    // Windows can hand listen(0) a port that Fetch (and Chromium) forbids,
    // such as 10080. A healthy server on that port looks like "Network error"
    // to the panel. Verify browser-style access before publishing its address.
    let reachable = false
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${server.address().port}/__amadeus_port_probe`, {
          signal: AbortSignal.timeout(2000),
        })
        reachable = true
        break
      } catch {
        await new Promise((resolve) => server.close(resolve))
        await listen(0)
      }
    }
    if (!reachable) {
      await new Promise((resolve) => server.close(resolve))
      throw new Error('could not bind a browser-reachable loopback port')
    }
    port = server.address().port
    try {
      fs.writeFileSync(portFile, String(port), { encoding: 'utf8', mode: 0o600 })
    } catch {
      /* remembering the port is best-effort */
    }

    fs.mkdirSync(paths.runtimeDir, { recursive: true })
    const startedAt = Date.now()
    const pointer = () => JSON.stringify({ pid: process.pid, port, token, version, startedAt, dataRoot: paths.dataRoot }, null, 2)
    fs.writeFileSync(paths.daemonFile, pointer(), { mode: 0o600 })
    /**
     * Keep the pointer honest.
     *
     * The daemon is useless if clients cannot find it: `daemon.json` was seen
     * pointing at a dead pid while a healthy daemon listened on another port,
     * which is exactly the "Amadeus will not wake up" state. Rewriting the file
     * whenever it is missing or no longer describes *us* is cheap insurance.
     */
    runtimeTimer = setInterval(() => {
      refreshPointer().catch(() => {})
    }, 60000)
    runtimeTimer.unref?.()

    /**
     * Rewrite the pointer when it does not describe this instance, and get out
     * of the way when a *different* live daemon owns it - two daemons where only
     * one is discoverable is how the panel ends up talking to a dead address.
     */
    async function refreshPointer() {
      let other = null
      try {
        other = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
      } catch {
        /* missing or truncated: ours to rewrite */
      }
      if (other && other.pid !== process.pid) {
        if (await ping(other)) {
          logger.warn('another daemon owns daemon.json; stopping this instance')
          await stop()
          process.exit(0)
          return
        }
        logger.warn('replacing a stale daemon.json that pointed at another instance')
      } else if (other && other.port === port) {
        return
      }
      try {
        fs.writeFileSync(paths.daemonFile, pointer(), { mode: 0o600 })
      } catch {
        /* best effort - a failed write must not take the daemon down */
      }
    }
    logger.info(`listening on http://127.0.0.1:${port}`)
    return { port, token, url: urlForPanel() }
  }

  async function stop() {
    try {
      hub.broadcast('shutdown', { at: Date.now() })
      for (const res of hub.clients.values()) {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      setTimeout(resolve, 1500)
    })
    if (runtimeTimer) clearInterval(runtimeTimer)
    runtimeTimer = null
    try {
      // Only our own pointer may be removed: a stale shutdown must not delete
      // the file a freshly started daemon just wrote.
      const parsed = JSON.parse(fs.readFileSync(paths.daemonFile, 'utf8'))
      if (!parsed || parsed.pid === process.pid) fs.unlinkSync(paths.daemonFile)
    } catch {
      /* ignore */
    }
    log.info('[daemon] stopped')
  }

  return { start, stop, urlForPanel, get port() { return port }, get token() { return token }, routes }
}
