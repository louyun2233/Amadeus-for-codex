import fs from 'node:fs'
import path from 'node:path'

/**
 * Turn events for Codex Desktop.
 *
 * The `notify` hook only fires for `codex exec` runs, so work started in the
 * Desktop window never reached her: no reaction when a task started, and the
 * finished-task line came only from the CLI. Codex writes its own session
 * rollout as JSONL and every turn shows up there as
 * `task_started` / `task_complete` (`turn_aborted` when it is stopped).
 *
 * Reading those files is read-only, needs no protocol client and covers both
 * Desktop and CLI turns; the daemon de-duplicates by turn id so a CLI turn that
 * already went through the notify hook is not announced twice.
 */

export const TASK_KINDS = Object.freeze({
  task_started: 'start',
  task_complete: 'complete',
  turn_aborted: 'failed',
})

/** One rollout line -> a task event, or null when it is not a turn boundary. */
export function parseTaskEvent(line) {
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const type = raw?.payload?.type
  const kind = TASK_KINDS[type]
  if (!kind) return null
  const turnId = raw?.payload?.turn_id || raw?.payload?.turnId || null
  if (typeof turnId !== 'string' || turnId.length === 0) return null
  const at = Date.parse(raw?.timestamp || '')
  return { kind, turnId, at: Number.isFinite(at) ? at : Date.now() }
}

function normalize(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** A rollout that belongs to the panel's own chat is not a user task. */
export function isOwnSessionCwd(cwd, dataRoot) {
  const here = normalize(cwd)
  const root = normalize(dataRoot)
  if (!here || !root) return false
  return here === root || here.startsWith(`${root}/`)
}

/** The `session_meta` line carries the working directory of the session. */
export function readSessionCwd(file, { maxBytes = 16 * 1024 } = {}) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0)
      const firstLine = buffer.subarray(0, read).toString('utf8').split('\n')[0]
      const meta = JSON.parse(firstLine)
      return meta?.payload?.cwd || null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Newest rollout files, walking the `YYYY/MM/DD` folders from the end. */
export function newestRollouts(root, limit = 3, { readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const out = []
  // The active session is not necessarily in the newest folder: a thread
  // started days ago keeps being appended, so the walk has to see every day
  // before choosing by mtime. The budget only stops a pathological tree.
  const budget = Math.max(limit * 40, 200)
  const descend = (dir, depth) => {
    if (out.length >= budget || depth > 3) return
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => path.join(dir, e.name))
      .map((file) => {
        try {
          return { file, mtime: stat(file).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of files) out.push(entry)
    for (const name of dirs) descend(path.join(dir, name), depth + 1)
  }
  descend(root, 0)
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

export class TaskWatcher {
  /**
   * @param {{sessionsRoot: string, dataRoot?: string|null, onEvent?: Function, pollMs?: number,
   *          tailBytes?: number, maxFiles?: number, listFiles?: Function, now?: Function, log?: Function}} options
   */
  constructor({
    sessionsRoot,
    dataRoot = null,
    onEvent = () => {},
    pollMs = 2000,
    tailBytes = 128 * 1024,
    maxFiles = 3,
    listFiles = (root, limit) => newestRollouts(root, limit),
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    this.sessionsRoot = sessionsRoot
    this.dataRoot = dataRoot
    this.onEvent = onEvent
    this.pollMs = pollMs
    this.tailBytes = tailBytes
    this.maxFiles = maxFiles
    this.listFiles = listFiles
    this.now = now
    this.log = log
    this.offsets = new Map()
    this.ignored = new Set()
    this.seen = new Set()
    this.seenOrder = []
    this.timer = null
  }

  start() {
    if (this.timer) return this
    // Prime first: history must not be announced the moment the daemon starts.
    this.poll({ prime: true })
    this.timer = setInterval(() => {
      try {
        this.poll()
      } catch (e) {
        this.log(`task watch failed: ${e && e.message ? e.message : e}`)
      }
    }, this.pollMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** @returns {{kind: string, turnId: string, at: number}[]} events emitted now */
  poll({ prime = false } = {}) {
    const emitted = []
    // Once a file is being tracked it stays tracked: a long-running thread is
    // appended for days and would otherwise drop out of the "newest" window.
    const candidates = new Map()
    for (const entry of this.listFiles(this.sessionsRoot, this.maxFiles)) candidates.set(entry.file, entry)
    for (const file of this.offsets.keys()) {
      if (!candidates.has(file)) candidates.set(file, { file, mtime: 0 })
    }
    for (const { file } of candidates.values()) {
      if (this.ignored.has(file)) continue
      if (!this.ignored.has(`${file}:checked`)) {
        const cwd = readSessionCwd(file)
        this.ignored.add(`${file}:checked`)
        if (cwd && isOwnSessionCwd(cwd, this.dataRoot)) {
          this.ignored.add(file)
          continue
        }
      }
      let size
      try {
        size = fs.statSync(file).size
      } catch {
        continue
      }
      const previous = this.offsets.get(file)
      // First sight (or a truncated file): start at the end, so history is
      // never announced when the daemon starts.
      if (previous === undefined || size < previous) {
        this.offsets.set(file, size)
        continue
      }
      if (prime || size === previous) continue
      // Stay bounded on a huge file: skip ahead, then ignore the partial line.
      const start = size - previous > this.tailBytes ? size - this.tailBytes : previous
      let chunk
      try {
        const fd = fs.openSync(file, 'r')
        try {
          const length = size - start
          const buffer = Buffer.alloc(length)
          fs.readSync(fd, buffer, 0, length, start)
          chunk = buffer.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        continue
      }
      const lastBreak = chunk.lastIndexOf('\n')
      if (lastBreak < 0) continue
      const complete = chunk.slice(0, lastBreak + 1)
      this.offsets.set(file, start + Buffer.byteLength(complete, 'utf8'))
      for (const line of complete.split('\n')) {
        const event = parseTaskEvent(line)
        if (!event) continue
        const key = `${event.turnId}:${event.kind}`
        if (this.seen.has(key)) continue
        this.seen.add(key)
        this.seenOrder.push(key)
        while (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift())
        emitted.push(event)
        this.onEvent(event)
      }
    }
    return emitted
  }
}
