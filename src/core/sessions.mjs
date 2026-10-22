import path from 'node:path'
import crypto from 'node:crypto'
import { readJson, writeJsonAtomic, listFiles, removeFile } from './store.mjs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
}

/**
 * Companion sessions are Amadeus' own conversation threads. They are
 * deliberately NOT mapped onto Codex threads (Q23): the companion keeps her
 * own history and can optionally carry a workspace tag.
 */
export class SessionStore {
  constructor(paths) {
    this.dir = paths.sessionsDir
  }

  #file(id) {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(String(id))) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'invalid session id')
    }
    return path.join(this.dir, `${id}.json`)
  }

  #read(id) {
    const session = readJson(this.#file(id), null)
    if (!session) throw new AmadeusError(ErrorCode.NOT_FOUND, `session not found: ${id}`)
    if (!Array.isArray(session.messages)) session.messages = []
    return session
  }

  list() {
    return listFiles(this.dir)
      .map((file) => readJson(file, null))
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        endedAt: s.endedAt ?? null,
        workspace: s.workspace ?? null,
        messageCount: (s.messages || []).length,
        hasSummary: typeof s.summary === 'string' && s.summary.length > 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  create({ name, workspace = null, greeting = null } = {}) {
    const sessions = this.list()
    const session = {
      id: newId(),
      name: name || `会话 ${sessions.length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspace,
      summary: '',
      messages: greeting
        ? [{ id: newId(), role: 'assistant', zh: greeting, ja: greeting, emotion: 'neutral', ts: Date.now() }]
        : [],
    }
    writeJsonAtomic(this.#file(session.id), session)
    return session
  }

  get(id) {
    return this.#read(id)
  }

  ensureAny() {
    const all = this.list()
    // A closed session is history, not context: one-shot mode closes the thread
    // after every exchange, so the next message starts a clean one.
    const open = all.find((s) => !s.endedAt)
    if (open) return this.get(open.id)
    return this.create()
  }

  /** Mark a session finished. The file is kept, it just stops being reused. */
  close(id) {
    const s = this.#read(id)
    s.endedAt = Date.now()
    s.updatedAt = s.endedAt
    writeJsonAtomic(this.#file(id), s)
    return s
  }

  rename(id, name) {
    const s = this.#read(id)
    s.name = String(name || '').slice(0, 80) || s.name
    s.updatedAt = Date.now()
    writeJsonAtomic(this.#file(id), s)
    return s
  }

  remove(id) {
    const all = this.list()
    if (all.length <= 1) {
      throw new AmadeusError(ErrorCode.CONFLICT, 'cannot delete the last session')
    }
    return { removed: removeFile(this.#file(id)) }
  }

  append(id, message) {
    const s = this.#read(id)
    const entry = {
      id: newId(),
      role: message.role === 'user' ? 'user' : 'assistant',
      zh: String(message.zh ?? ''),
      ja: String(message.ja ?? ''),
      emotion: message.emotion || 'neutral',
      isSummary: message.isSummary === true,
      ts: message.ts || Date.now(),
    }
    s.messages.push(entry)
    s.updatedAt = entry.ts
    writeJsonAtomic(this.#file(id), s)
    return entry
  }

  setSummary(id, summary) {
    const s = this.#read(id)
    s.summary = String(summary || '').slice(0, 2000)
    s.updatedAt = Date.now()
    writeJsonAtomic(this.#file(id), s)
    return s
  }

  replaceMessages(id, messages) {
    const s = this.#read(id)
    s.messages = messages
    s.updatedAt = Date.now()
    writeJsonAtomic(this.#file(id), s)
    return s
  }

  recentMessages(id, n = 20) {
    const s = this.#read(id)
    return s.messages.slice(-n)
  }
}
