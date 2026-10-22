import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

let counter = 0

export function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `amadeus-test-${process.pid}-${counter++}-`))
  const dataRoot = path.join(root, 'data')
  const cacheRoot = path.join(root, 'cache')
  const paths = {
    dataRoot,
    cacheRoot,
    configFile: path.join(dataRoot, 'config.json'),
    secretsFile: path.join(dataRoot, 'secrets.json'),
    sessionsDir: path.join(dataRoot, 'sessions'),
    memoryDir: path.join(dataRoot, 'memory'),
    auditFile: path.join(dataRoot, 'audit.jsonl'),
    runtimeDir: path.join(dataRoot, 'runtime'),
    daemonFile: path.join(dataRoot, 'runtime', 'daemon.json'),
    modelsDir: path.join(cacheRoot, 'models'),
    voiceCacheDir: path.join(cacheRoot, 'voices'),
    downloadsDir: path.join(cacheRoot, 'downloads'),
    runtimeCacheDir: path.join(cacheRoot, 'runtime'),
    tmpDir: path.join(dataRoot, 'tmp'),
  }
  for (const dir of [
    paths.dataRoot,
    paths.sessionsDir,
    paths.memoryDir,
    paths.runtimeDir,
    paths.modelsDir,
    paths.voiceCacheDir,
    paths.downloadsDir,
    paths.runtimeCacheDir,
    paths.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return paths
}

export function tarHeader(name, size, type = '0', linkname = '') {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 8, 'ascii')
  h.write('0000000\0', 108, 8, 'ascii')
  h.write('0000000\0', 116, 8, 'ascii')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii')
  h.write(type, 156, 1, 'ascii')
  h.write(linkname, 157, 100, 'utf8')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

export function makeTarGz(entries) {
  const parts = []
  for (const e of entries) {
    if (e.type === 'dir') {
      parts.push(tarHeader(e.name, 0, '5'))
      continue
    }
    const data = Buffer.from(e.data ?? '', 'utf8')
    parts.push(tarHeader(e.name, data.length, '0'))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}

export function cleanup(paths) {
  try {
    fs.rmSync(path.dirname(paths.dataRoot), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
