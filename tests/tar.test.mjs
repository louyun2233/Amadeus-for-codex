import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { readTar, readTarGz, writeEntries } from '../src/core/tar.mjs'

function tarHeader(name, size, type = '0', linkname = '') {
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

function makeTar(entries) {
  const parts = []
  for (const e of entries) {
    if (e.raw) {
      parts.push(e.raw)
      continue
    }
    if (e.type === 'dir') {
      parts.push(tarHeader(e.name, 0, '5'))
      continue
    }
    const data = Buffer.from(e.data ?? '', 'utf8')
    parts.push(tarHeader(e.name, data.length, e.type || '0', e.linkname || ''))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

test('reads a normal archive and strips the root directory', () => {
  const tar = makeTar([
    { name: 'kurisu/', type: 'dir' },
    { name: 'kurisu/model.json', data: '{"a":1}' },
    { name: 'kurisu/textures/tex.png', data: 'PNG' },
  ])
  const archive = readTar(tar)
  assert.equal(archive.files.length, 2)
  assert.equal(archive.entries, 3)
  assert.deepEqual(
    archive.files.map((f) => f.path),
    ['kurisu/model.json', 'kurisu/textures/tex.png'],
  )

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-tar-'))
  try {
    const written = writeEntries(archive, dest, { strip: 'kurisu' })
    assert.deepEqual(written.sort(), ['model.json', 'textures/tex.png'])
    assert.equal(fs.readFileSync(path.join(dest, 'model.json'), 'utf8'), '{"a":1}')
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('gz wrapper handles compressed archives and reports bytes', () => {
  const gz = zlib.gzipSync(makeTar([{ name: 'a.txt', data: 'hello' }]))
  let sawRead = false
  const archive = readTarGz(gz, {}, (p) => {
    if (p.phase === 'read') sawRead = true
  })
  assert.equal(archive.files[0].path, 'a.txt')
  assert.equal(sawRead, true)
})

test('rejects parent traversal', () => {
  const tar = makeTar([{ name: '../../evil.txt', data: 'x' }])
  assert.throws(() => readTar(tar), /parent traversal|absolute/)
})

test('rejects nested traversal even when it looks harmless', () => {
  const tar = makeTar([{ name: 'kurisu/../../../evil.txt', data: 'x' }])
  assert.throws(() => readTar(tar), /parent traversal/)
})

test('rejects absolute paths and drive letters', () => {
  assert.throws(() => readTar(makeTar([{ name: '/etc/passwd', data: 'x' }])), /absolute/)
  assert.throws(() => readTar(makeTar([{ name: 'C:/windows/x', data: 'x' }])), /absolute/)
})

test('rejects backslash paths (windows separator smuggling)', () => {
  assert.throws(() => readTar(makeTar([{ name: 'kurisu\\..\\evil', data: 'x' }])), /illegal character/)
})

test('rejects symlinks, hardlinks and devices', () => {
  assert.throws(() => readTar(makeTar([{ name: 'link', type: '2', linkname: '/etc/passwd' }])), /unsupported entry type/)
  assert.throws(() => readTar(makeTar([{ name: 'hard', type: '1', linkname: 'x' }])), /unsupported entry type/)
  assert.throws(() => readTar(makeTar([{ name: 'dev', type: '3' }])), /unsupported entry type/)
})

test('rejects too many entries', () => {
  const entries = []
  for (let i = 0; i < 20; i++) entries.push({ name: `f${i}.txt`, data: 'x' })
  assert.throws(() => readTar(makeTar(entries), { maxEntries: 10 }), /too many entries/)
})

test('rejects oversized files and total expansion', () => {
  const big = 'x'.repeat(4096)
  assert.throws(
    () => readTar(makeTar([{ name: 'big.bin', data: big }]), { maxFileBytes: 1024 }),
    /too large/,
  )
  const many = []
  for (let i = 0; i < 5; i++) many.push({ name: `f${i}.bin`, data: big })
  assert.throws(() => readTar(makeTar(many), { maxTotalBytes: 8192 }), /size limit/)
})

test('rejects headers with a bad checksum', () => {
  const header = tarHeader('evil.txt', 3)
  header[0] = 0x78 // mutate after checksum was computed
  const tar = Buffer.concat([header, Buffer.from('abc'), Buffer.alloc(509), Buffer.alloc(1024)])
  assert.throws(() => readTar(tar), /checksum mismatch/)
})

test('rejects truncated entry data', () => {
  const header = tarHeader('a.txt', 2048)
  const tar = Buffer.concat([header, Buffer.from('short')])
  assert.throws(() => readTar(tar), /truncated/)
})

test('writeEntries refuses to escape the destination even if validation is bypassed', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-tar-'))
  try {
    const fake = { files: [{ path: '../escape.txt', data: Buffer.from('x') }], dirs: [] }
    assert.throws(() => writeEntries(fake, dest), /refusing to write outside root/)
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('parses the real kurisu archive when it has been fetched', (t) => {
  const file = path.resolve(
    process.cwd(),
    '..',
    '..',
    'work',
    'asset-probe',
    'kurisu.tar.gz',
  )
  if (!fs.existsSync(file)) {
    t.skip('work/asset-probe/kurisu.tar.gz not present')
    return
  }
  const archive = readTarGz(fs.readFileSync(file))
  const names = archive.files.map((f) => f.path)
  assert.ok(names.includes('kurisu/kurisu.model.json'))
  assert.equal(names.filter((n) => n.startsWith('kurisu/expressions/')).length, 4)
  assert.equal(names.filter((n) => n.startsWith('kurisu/motions/')).length, 18)
  assert.ok(names.includes('kurisu/shizuku.moc'))
  assert.ok(names.includes('kurisu/shizuku.physics.json'))
  // the archive carries motion sounds; they are extracted but not played yet
  assert.equal(names.filter((n) => n.startsWith('kurisu/sounds/')).length, 15)
  assert.equal(names.length, 48)

  const model = JSON.parse(
    archive.files.find((f) => f.path === 'kurisu/kurisu.model.json').data.toString('utf8'),
  )
  assert.equal(model.model, 'shizuku.moc')
  assert.deepEqual(
    model.expressions.map((e) => e.name),
    ['f01', 'f02', 'f03', 'f04'],
  )
  assert.deepEqual(Object.keys(model.motions), [
    'idle',
    'tap_body',
    'pinch_in',
    'pinch_out',
    'shake',
    'flick_head',
  ])
  assert.deepEqual(
    model.hit_areas.map((h) => h.name),
    ['head', 'mouth', 'body'],
  )
})
