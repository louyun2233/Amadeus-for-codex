import zlib from 'node:zlib'
import path from 'node:path'
import fs from 'node:fs'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'

/**
 * Minimal tar (ustar/pax) reader + gzip wrapper.
 *
 * Node ships gzip but no tar, and pulling a dependency in for one archive
 * format is not worth it. The reader is deliberately strict: an archive is
 * untrusted input, so anything unusual (links, devices, absolute paths, `..`,
 * oversized or too many entries) is rejected rather than accommodated.
 */

const BLOCK = 512

export const DEFAULT_LIMITS = {
  maxEntries: 2000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxPathLength: 512,
}

function readString(buf) {
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

function readNumber(buf) {
  // GNU base-256 encoding: high bit of the first byte set
  if (buf.length > 0 && (buf[0] & 0x80) !== 0) {
    let value = 0n
    const copy = Buffer.from(buf)
    copy[0] &= 0x7f
    for (const b of copy) value = (value << 8n) | BigInt(b)
    return Number(value)
  }
  const text = readString(buf).trim()
  if (text.length === 0) return 0
  const value = parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function checksumOk(header) {
  const expected = readNumber(header.subarray(148, 156))
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]
    unsigned += byte
    signed += byte < 128 ? byte : byte - 256
  }
  return expected === unsigned || expected === signed
}

function parsePax(data) {
  // records: "<len> <key>=<value>\n"
  const out = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(offset, offset + length)
    const eq = record.indexOf(0x3d)
    if (eq > 0) {
      const key = record.subarray(space - offset + 1, eq).toString('utf8')
      const value = record.subarray(eq + 1, record.length - 1).toString('utf8')
      out[key] = value
    }
    offset += length
  }
  return out
}

export function isGzip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/**
 * Validate and collect archive entries. Returns files and directories with
 * every path already normalized and proven to stay inside the extraction root.
 */
export function readTar(buffer, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const files = []
  const dirs = []
  let totalBytes = 0
  let offset = 0
  let entries = 0
  let pendingPax = null
  let pendingLongName = null

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK

    if (header.every((b) => b === 0)) {
      // end-of-archive marker; stop
      break
    }
    if (!checksumOk(header)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'tar: header checksum mismatch')
    }

    const rawName = readString(header.subarray(0, 100))
    const prefix = readString(header.subarray(345, 500))
    const size = readNumber(header.subarray(124, 136))
    const typeFlag = String.fromCharCode(header[156] || 0x30)
    const linkName = readString(header.subarray(157, 257))

    const dataStart = offset
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (dataStart + padded > buffer.length) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'tar: truncated entry data')
    }
    const data = buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + padded

    if (typeFlag === 'g') continue
    if (typeFlag === 'x') {
      pendingPax = parsePax(data)
      continue
    }
    if (typeFlag === 'L') {
      pendingLongName = readString(data)
      continue
    }
    if (typeFlag === 'K') continue

    entries += 1
    if (entries > lim.maxEntries) {
      throw new AmadeusError(
        ErrorCode.INVALID_ARGUMENT,
        `tar: too many entries (>${lim.maxEntries})`,
      )
    }

    let name = rawName
    if (pendingLongName !== null) {
      name = pendingLongName
      pendingLongName = null
    }
    if (pendingPax) {
      if (pendingPax.path) name = pendingPax.path
      if (pendingPax.linkpath) linkName
      pendingPax = null
    }
    if (prefix.length > 0 && !name.startsWith(prefix + '/')) name = `${prefix}/${name}`

    const safe = safeEntryPath(name, lim)

    if (typeFlag === '5') {
      dirs.push(safe)
      continue
    }
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '\u0000' || typeFlag === '7') {
      if (size > lim.maxFileBytes) {
        throw new AmadeusError(
          ErrorCode.INVALID_ARGUMENT,
          `tar: entry too large (${safe}, ${size} bytes)`,
        )
      }
      totalBytes += size
      if (totalBytes > lim.maxTotalBytes) {
        throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'tar: archive expands beyond the size limit')
      }
      files.push({ path: safe, data, size })
      continue
    }
    // symlink '2', hardlink '1', char '3', block '4', fifo '6', or anything unknown
    throw new AmadeusError(
      ErrorCode.INVALID_ARGUMENT,
      `tar: unsupported entry type "${typeFlag}" for ${safe}`,
    )
  }

  return { files, dirs, totalBytes, entries }
}

function safeEntryPath(name, lim) {
  const raw = String(name || '')
  if (raw.length === 0) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'tar: empty entry name')
  }
  if (raw.length > lim.maxPathLength) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: path too long: ${raw.slice(0, 80)}…`)
  }
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: illegal character in path: ${raw}`)
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: absolute path rejected: ${raw}`)
  }
  const parts = raw.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.length === 0) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: empty path rejected: ${raw}`)
  }
  for (const part of parts) {
    if (part === '..') {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: parent traversal rejected: ${raw}`)
    }
  }
  return parts.join('/')
}

/** gzip -> readTar. Accepts a plain (uncompressed) tar too. */
export function readTarGz(buffer, limits = {}, onProgress) {
  if (!Buffer.isBuffer(buffer)) {
    throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'archive must be a Buffer')
  }
  onProgress?.({ phase: 'decompress' })
  const raw = isGzip(buffer) ? zlib.gunzipSync(buffer) : buffer
  onProgress?.({ phase: 'read', bytes: raw.length })
  return readTar(raw, limits)
}

/**
 * Write validated entries under `destDir`, optionally stripping leading path
 * components. Containment is re-checked per file (defence in depth: the reader
 * already rejected traversal, but a bug there must not become a write escape).
 */
export function writeEntries(archive, destDir, { strip = '' } = {}) {
  const root = path.resolve(destDir)
  fs.mkdirSync(root, { recursive: true })
  const written = []
  const stripParts = strip ? strip.split('/').filter(Boolean) : []

  for (const file of archive.files) {
    let rel = file.path
    if (stripParts.length > 0) {
      const parts = rel.split('/')
      const matches = stripParts.every((p, i) => parts[i] === p)
      if (matches) rel = parts.slice(stripParts.length).join('/')
    }
    if (rel.length === 0) continue
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new AmadeusError(ErrorCode.INVALID_ARGUMENT, `tar: refusing to write outside root: ${rel}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.data)
    written.push(rel)
  }
  return written
}
