import crypto from 'node:crypto'

/**
 * `Sec-MS-GEC` token generation for the Edge read-aloud endpoint.
 *
 * Microsoft switched the endpoint to a "v2" token: the value is
 * `<16 hex>-<64 hex>` (a custom CS64 digest plus a SHA-256 digest) and the
 * handshake must announce `Sec-MS-GEC-Version=2-<chromium>`. The old
 * single-SHA-256 token is now answered with `403 Forbidden`, which is why the
 * whole voice path went silent.
 *
 * The digests are ported from the MIT-licensed `edge-tts` project
 * (rany2/edge-tts, `src/edge_tts/drm.py`): its SHA-256 variant starts from a
 * non-standard initial state and mixes adjusted round constants, so a stock
 * `createHash('sha256')` cannot reproduce it. 32-bit multiplies go through
 * `Math.imul` and the two 64-bit rotate-and-shift steps use BigInt, because
 * JavaScript numbers cannot hold the products exactly.
 */

export const WIN_EPOCH = 11644473600
export const SEC_MS_GEC_TICK_SECONDS = 300

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const MASK = 0xffffffff
const U32 = 0x100000000n

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4,
  0x03effbd2,
]
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
]
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]
const SHA256_ADJUSTMENT = 0xc9dc06a7
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
]
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

const mul = (a, b) => Math.imul(a, b) >>> 0
const rol16 = (value) => ((((value & MASK) << 16) | ((value & MASK) >>> 16)) >>> 0)

/** SHA-256 small sigma zero, low 32 bits only. */
function sigma0(value) {
  return ((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3)) >>> 0
}

/** SHA-256 small sigma one, low 32 bits only. */
function sigma1(value) {
  return ((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10)) >>> 0
}

/**
 * One SHA-256 variant round function. Multiples of 2**32+1 repeat the word in
 * 64 bits so a shift stands in for a rotate; BigInt keeps that exact where a
 * double would round.
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS
  for (let i = firstRound; i < 64; i++) {
    // `>>> 0` first: `& MASK` above can leave a negative 32-bit value, and
    // BigInt(-x) would then multiply the wrong number.
    const rotE = BigInt(e >>> 0) * U32 + BigInt(e >>> 0)
    const rotA = BigInt(a >>> 0) * U32 + BigInt(a >>> 0)
    const mixE = Number(((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) & 0xffffffffn)
    const mixA = Number(((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) & 0xffffffffn)
    const t1 = (h + mixE + (g ^ (e & (f ^ g))) + constants[i] + words[i]) & MASK
    const t2 = (mixA + ((a & b) | (c & (a | b)))) & MASK
    h = g
    g = f
    f = e
    e = (d + t1) & MASK
    d = c
    c = b
    b = a
    a = (t1 + t2) & MASK
  }
  return [a, b, c, d, e, f, g, h]
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) & MASK
  }
}

function sha256Init(data) {
  const words = new Array(16).fill(0)
  words[14] = ((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0
  words[15] = ((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0
  for (let i = 16; i <= 29; i++) {
    let value = SHA256_SCHEDULE[i - 16]
    if (i - 2 >= 14) {
      const term = sigma1(words[i - 2])
      value += i === 16 ? term ^ SHA256_SIGMA1_ADJUSTMENT : term
    }
    if (i - 7 >= 14) value += words[i - 7]
    if (i - 15 >= 14) {
      const term = sigma0(words[i - 15])
      value += i === 29 ? term ^ SHA256_SIGMA0_ADJUSTMENT : term
    }
    words[i] = value & MASK
  }
  words[30] =
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) &
    MASK
  expandSchedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, 14)
  return SHA256_INITIAL.map((x, i) => (x + working[i]) & MASK)
}

/** Split into little-endian 32-bit words, zero-padded to an even count. */
function wordsLe4Even(bytes) {
  let padded = Buffer.from(bytes)
  if (padded.length % 4 !== 0) {
    padded = Buffer.concat([padded, Buffer.alloc(4 - (padded.length % 4))])
  }
  const words = []
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i))
  if (words.length % 2 !== 0) words.push(0)
  return words
}

export function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt must contain at least seven bytes')
  const length = 57 + data.length
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc((((55 - length) % 64) + 64) % 64),
    (() => {
      const tail = Buffer.alloc(8)
      tail.writeBigUInt64BE(BigInt(length * 8))
      return tail
    })(),
  ])
  let state = sha256Init(data.subarray(0, 7))
  for (let offset = 0; offset < padded.length; offset += 64) {
    const block = padded.subarray(offset, offset + 64)
    const words = []
    for (let i = 0; i < 16; i++) words.push(block.readUInt32BE(i * 4))
    expandSchedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((x, i) => (x + working[i]) & MASK)
  }
  const out = Buffer.alloc(32)
  // `& MASK` can leave a negative 32-bit value; buffers want the unsigned view.
  state.forEach((word, i) => out.writeUInt32BE(word >>> 0, i * 4))
  return out
}

export function cs64Digest(data, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)]
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) => mul(coefficient, factors[index % 2]))
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset >>> 0)

  wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, index) => {
    const key = index % 2 === 0 ? keyA : keyB
    let term = mul(word, key)
    let offset = mul(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db)
    if (index === 0) {
      term += mul(CS64_ADJUSTMENT0, factors[0])
      offset += CS64_ADJUSTMENT1
    }
    terms.push(term & MASK)
    offsets.push(offset & MASK)
  })

  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]
    const y = terms[index + 1]
    let t = rol16((offsets[index] + x) & MASK)
    let q = mul(t, 0x76f50f34)
    swapAcc += (mul(rol16(q), 0xc3efea97) + q) & MASK
    t = rol16((offsets[index + 1] + y) & MASK)
    q = mul(t, 0x1881ce3c)
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) & MASK
    swapAcc = (swapAcc + swapLast) & MASK

    state = (mul(state, keyA) + x) & MASK
    state = mul(rol16(state), 0xcf98b111)
    state = mul(rol16(state), 0x87085b9f)
    state = mul(rol16(state), 0x12ceb96d)
    state = mul(rol16(state), 0x257e1d83)
    acc += state
    t = (mul(state, keyB) + y) & MASK
    t = mul(rol16(t), 0xa27416f5)
    t = mul(rol16(t), 0xd38396ff)
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69)
    acc = (acc + state) & MASK
  }
  return [swapLast ^ state, swapAcc ^ acc].map((v) => v >>> 0)
}

/**
 * Clock correction.
 *
 * The token is derived from our own wall clock, so a machine that is a few
 * minutes off gets its handshake rejected with 403 - which looks like "the
 * service is down" and is impossible to guess from the outside. The endpoint
 * sends its own `Date` on that response; the difference is stored here and
 * applied to every later token, exactly like the upstream client does.
 */
export const MAX_SKEW_SECONDS = 7 * 24 * 3600

let clockSkewSeconds = 0

/** RFC 7231 date header -> unix seconds, or null when it is not a date. */
export function parseHttpDate(value) {
  const parsed = Date.parse(String(value ?? '').trim())
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

/**
 * How far off the server clock is, in seconds, or null when the header is
 * missing/unusable. A wildly wrong value is refused rather than trusted: a
 * broken proxy must not be able to move our clock by years.
 */
export function skewSecondsFromDate(value, nowMs = Date.now()) {
  const server = parseHttpDate(value)
  if (server === null) return null
  const delta = server - nowMs / 1000
  if (Math.abs(delta) < 1) return 0
  if (Math.abs(delta) > MAX_SKEW_SECONDS) return null
  return delta
}

export function adjustClockSkew(seconds) {
  if (!Number.isFinite(seconds)) return clockSkewSeconds
  clockSkewSeconds = Math.max(-MAX_SKEW_SECONDS, Math.min(MAX_SKEW_SECONDS, seconds))
  return clockSkewSeconds
}

export function getClockSkew() {
  return clockSkewSeconds
}

/** Tests (and a future "clock was fixed" action) need a way back to zero. */
export function resetClockSkew() {
  clockSkewSeconds = 0
  return clockSkewSeconds
}

/** Now, as the server sees it. */
export function skewedNowMs(nowMs = Date.now()) {
  return nowMs + clockSkewSeconds * 1000
}

/** The ticks value the endpoint expects: Windows file time, 5-minute buckets. */
export function gecTicks(unixSeconds) {
  let ticks = Number(unixSeconds) + WIN_EPOCH
  ticks -= ticks % SEC_MS_GEC_TICK_SECONDS
  return BigInt(Math.round(ticks * 1e7))
}

/**
 * `<cs64>-<sha256>`, matching edge-tts' `generate_sec_ms_gec_v2`.
 * `unixMs` defaults to now and exists so the value is reproducible in tests.
 */
export function secMsGecV2(unixMs = skewedNowMs()) {
  const salt = Buffer.from(`${gecTicks(unixMs / 1000)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = sha256Digest(salt)
  const [lo, hi] = cs64Digest(salt, digest)
  const packed = Buffer.alloc(8)
  packed.writeUInt32LE(lo, 0)
  packed.writeUInt32LE(hi, 4)
  const cs64 = packed.toString('hex').toUpperCase()
  return `${cs64}-${digest.toString('hex').toUpperCase()}`
}

/** Legacy single-SHA-256 token; kept only as a fallback and for reference. */
export function secMsGecV1(unixMs = skewedNowMs()) {
  return crypto
    .createHash('sha256')
    .update(`${gecTicks(unixMs / 1000)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}
