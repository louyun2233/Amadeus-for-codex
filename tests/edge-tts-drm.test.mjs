import test from 'node:test'
import assert from 'node:assert/strict'
import { cs64Digest, gecTicks, secMsGecV2, sha256Digest } from '../src/core/edge-tts-drm.mjs'

/**
 * The voice channel is the one thing here that depends on someone else's
 * private protocol, so its token generator is pinned to published vectors.
 *
 * Expected values were produced by `generate_sec_ms_gec_v2` from rany2/edge-tts
 * (MIT) at these timestamps. When they fail, Microsoft changed the handshake
 * again - the fix is a deliberate update of this file plus the port, which is
 * exactly the signal that was missing when the endpoint started answering 403
 * and the companion simply went quiet.
 */

const VECTORS = [
  [
    1750000000,
    'B029A7426816F097-4579D112DC47FC3BF432B499C0A282F427C659474AF9BF5FA33CE2C003F9E9C2',
  ],
  [
    1792070000,
    '056A5CE8584C8447-2F74987221B15671A95DE887790BC2472B151A33BF057F3394DDB28DCE668E22',
  ],
  [
    1792070428.5,
    '1019DA0002A338E8-6C0429B94D08177F221C13B88C78C1EDBBC8854358AB1DAB2EEBCC97183E9AB4',
  ],
  [0, '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
]

test('the v2 token matches the published edge-tts vectors', () => {
  for (const [seconds, expected] of VECTORS) {
    assert.equal(secMsGecV2(seconds * 1000), expected, `timestamp ${seconds}`)
  }
})

test('the token has the shape the handshake expects', () => {
  const token = secMsGecV2()
  assert.match(token, /^[0-9A-F]{16}-[0-9A-F]{64}$/)
})

test('the token is stable inside a five minute bucket and moves across buckets', () => {
  const bucketStart = 1792069800_000 // 300 * 5973566
  assert.equal(bucketStart / 1000 % 300, 0, 'the fixture must sit on a bucket edge')
  assert.equal(secMsGecV2(bucketStart), secMsGecV2(bucketStart + 299_000))
  assert.notEqual(secMsGecV2(bucketStart), secMsGecV2(bucketStart + 300_000))
})

test('ticks are Windows file time, floored to the bucket', () => {
  assert.equal(gecTicks(0), 116444736000000000n)
  // one bucket later, and a fraction inside a bucket floors to its start
  assert.equal(gecTicks(300), 116444739000000000n)
  assert.equal(gecTicks(300.5), 116444739000000000n)
  assert.equal(gecTicks(600), 116444742000000000n)
})

test('digest primitives are stable on a known input', () => {
  const salt = Buffer.from('1164447360000000006A5AA1D4EAFF4E9FB37E23D68491D6F4', 'ascii')
  const digest = sha256Digest(salt)
  assert.equal(
    digest.toString('hex').toUpperCase(),
    '28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6',
  )
  const [lo, hi] = cs64Digest(salt, digest)
  // the wire format is the two 32-bit words written little-endian
  const packed = Buffer.alloc(8)
  packed.writeUInt32LE(lo >>> 0, 0)
  packed.writeUInt32LE(hi >>> 0, 4)
  assert.equal(packed.toString('hex').toUpperCase(), '52BC7A17B50DFEC9')
})

test('a salt shorter than seven bytes is refused instead of mis-hashing', () => {
  assert.throws(() => sha256Digest(Buffer.from('123456')), /at least seven bytes/)
})
