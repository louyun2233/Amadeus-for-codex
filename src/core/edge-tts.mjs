import crypto from 'node:crypto'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'
import { createChildLogger } from '../shared/log.mjs'
import { WsClient } from './ws-client.mjs'
import {
  adjustClockSkew,
  secMsGecV2,
  skewSecondsFromDate,
  TRUSTED_CLIENT_TOKEN,
} from './edge-tts-drm.mjs'

const logger = createChildLogger('[edge-tts]')

/**
 * Edge TTS over the public "read aloud" WebSocket, implemented in Node so the
 * default voice path needs no Python and no API key (Q26 / R1).
 *
 * Prosody/emotion profiles are derived from amadeus-for-dsh (MIT, yyxcnasd);
 * the style is applied per request instead of through a process-global, which
 * removes the concurrency race in the upstream implementation.
 *
 * The `Sec-MS-GEC` handshake token is generated in `edge-tts-drm.mjs`. Microsoft
 * moved the endpoint to a v2 token + `Sec-MS-GEC-Version=2-...`; the old
 * single-SHA-256 form is answered with 403, which is what silenced this channel
 * until the port was updated.
 */

const CHROMIUM_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0]
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/**
 * `<mstts:express-as>` is a non-official extension of this endpoint and the
 * service now rejects it with WebSocket close code 1007. Emotion is therefore
 * expressed purely through prosody (pitch/volume/rate), which also keeps the
 * voice identity stable — no switching the speaker just to get a mood.
 *
 * The style column in PROFILES is kept for documentation and for a future
 * re-enable if Microsoft restores support.
 */
const EXPRESS_AS_ENABLED = false

/** emotion -> [style, rate, pitch, volume] */
const PROFILES = {
  happy: ['cheerful', '+0%', '+8Hz', '+6%'],
  excited: ['cheerful', '+0%', '+18Hz', '+12%'],
  elated: ['cheerful', '+0%', '+24Hz', '+16%'],
  winking: ['cheerful', '+0%', '+12Hz', '+8%'],
  annoyed: ['cheerful', '+0%', '-2Hz', '+14%'],
  surprised: ['cheerful', '+0%', '+22Hz', '+14%'],
  question: ['chat', '+0%', '+14Hz', '+4%'],
  neutral: ['chat', '+0%', '+0Hz', '+0%'],
  thinking: ['chat', '+0%', '+8Hz', '-4%'],
  side: ['chat', '+0%', '+5Hz', '-2%'],
  soft: ['customerservice', '+0%', '-6Hz', '-12%'],
  blush: ['customerservice', '+0%', '-4Hz', '-8%'],
  sad: [null, '+0%', '-14Hz', '-10%'],
  disappointed: [null, '+0%', '-12Hz', '-12%'],
  eyes_closed: [null, '+0%', '-8Hz', '-8%'],
  indifferent: [null, '+0%', '-2Hz', '-4%'],
  angry: [null, '+0%', '-4Hz', '+16%'],
  furious: [null, '+0%', '+2Hz', '+22%'],
}

function dateToString(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    'GMT+0000 (Coordinated Universal Time)'
  )
}

function scaleProsody(value, intensity) {
  const m = String(value).match(/^([+-]?\d+(?:\.\d+)?)(%|Hz)$/)
  if (!m) return value
  const factor = Math.max(0.2, Math.min(2, intensity))
  const num = Number(m[1]) * factor
  return `${num >= 0 ? '+' : ''}${num.toFixed(0)}${m[2]}`
}

function addProsody(base, delta) {
  const a = String(base).match(/^([+-]?\d+(?:\.\d+)?)(%|Hz)$/)
  const b = String(delta).match(/^([+-]?\d+(?:\.\d+)?)(%|Hz)$/)
  if (!a || !b || a[2] !== b[2]) return delta
  const num = Number(a[1]) + Number(b[1])
  return `${num >= 0 ? '+' : ''}${num.toFixed(0)}${a[2]}`
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildRequest({ text, voice, emotion, rate, pitch, intensity }) {
  const profile = PROFILES[emotion] || PROFILES.neutral
  let [style, emoRate, emoPitch, volume] = profile
  if (!EXPRESS_AS_ENABLED) style = null

  const finalRate = addProsody(rate || '+0%', scaleProsody(emoRate, intensity ?? 1))
  const finalPitch = addProsody(pitch || '+0Hz', scaleProsody(emoPitch, intensity ?? 1))
  const inner = `<prosody pitch='${finalPitch}' rate='${finalRate}' volume='${volume}'>${escapeXml(
    text,
  )}</prosody>`
  const voiced = style
    ? `<voice name='${voice}'><mstts:express-as style='${style}'>${inner}</mstts:express-as></voice>`
    : `<voice name='${voice}'>${inner}</voice>`
  const needsMstts = style ? ' xmlns:mstts="http://www.w3.org/2001/mstts"' : ''
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' ` +
    `xml:lang='ja-JP'${needsMstts}>${voiced}</speak>`
  return { ssml, style, finalRate, finalPitch, volume }
}

function parseMetadata(text) {
  const idx = text.indexOf('\r\n\r\n')
  if (idx < 0) return null
  const body = text.slice(idx + 4)
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Synthesize one sentence. Returns mp3 bytes plus word boundaries in ms.
 * `words` entries are {o, d} to match the DSH `X-Amadeus-Words` contract.
 */
export function synthesize({
  text,
  voice = 'ja-JP-NanamiNeural',
  emotion = 'neutral',
  rate = '+0%',
  pitch = '+0Hz',
  intensity = 1.0,
  timeoutMs = 30000,
  wsFactory = (url, opts) => new WsClient(url, opts),
} = {}) {
  const clean = String(text ?? '').trim()
  if (clean.length === 0) {
    return Promise.reject(new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'empty text'))
  }
  if (clean.length > 300) {
    return Promise.reject(new AmadeusError(ErrorCode.INVALID_ARGUMENT, 'text too long (max 300)'))
  }

  const { ssml, style } = buildRequest({ text: clean, voice, emotion, rate, pitch, intensity })
  const headers = {
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-CH-UA':
      `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR}", ` +
      `"Chromium";v="${CHROMIUM_MAJOR}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 ` +
      `Edg/${CHROMIUM_MAJOR}.0.0.0`,
  }

  /**
   * A rejected handshake is often a clock problem, not a bad request: the token
   * is derived from our own wall clock. When the server tells us its date, the
   * offset is corrected once and the request is retried - that is what keeps a
   * machine with a drifting clock talking.
   */
  let retriedWithCorrection = false

  const attempt = () => {
    const connectionId = crypto.randomBytes(16).toString('hex')
    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGecV2()}` +
      `&Sec-MS-GEC-Version=2-${CHROMIUM_VERSION}` +
      `&ConnectionId=${connectionId}`
    const requestId = crypto.randomBytes(16).toString('hex')

    return new Promise((resolve, reject) => {
      const ws = wsFactory(url, {
        timeoutMs,
        headers: {
          ...headers,
          Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
        },
      })

      const chunks = []
      const words = []
      let settled = false

      const timer = setTimeout(() => finish(new AmadeusError(ErrorCode.UNAVAILABLE, 'edge tts timeout')), timeoutMs)

      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        if (err && !retriedWithCorrection && err.status === 403) {
          const fix = skewSecondsFromDate(err.headers?.date)
          if (fix !== null && fix !== 0) {
            retriedWithCorrection = true
            adjustClockSkew(fix)
            logger.warn(
              `handshake answered 403; corrected clock skew by ${Math.round(fix)}s and retrying`,
            )
            resolve(attempt())
            return
          }
        }
        if (err) reject(err)
        else resolve(value)
      }

      ws.on('error', (e) => {
        const wrapped = new AmadeusError(
          ErrorCode.UNAVAILABLE,
          `edge tts socket error: ${e.message}`,
          { degrade: 'edge-tts-unavailable' },
        )
        // carry what the handshake told us: status and headers decide the retry
        wrapped.status = e.status
        wrapped.headers = e.headers
        finish(wrapped)
      })
      ws.on('close', (info) => {
        if (settled) return
        if (chunks.length > 0) {
          finish(null, { audio: Buffer.concat(chunks), words, mime: 'audio/mpeg', style })
        } else {
          finish(
            new AmadeusError(
              ErrorCode.UNAVAILABLE,
              `edge tts closed without audio (code ${info && info.code})`,
              { degrade: 'edge-tts-unavailable' },
            ),
          )
        }
      })

      ws.on('open', () => {
        const ts = dateToString()
        const config = JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        })
        ws.send(
          `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\n` +
            `Path:speech.config\r\n\r\n${config}`,
        )
        ws.send(
          `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`,
        )
      })

      ws.on('message', (payload, isBinary) => {
        if (!isBinary) {
          const s = payload.toString('utf8')
          if (s.includes('Path:turn.end')) {
            if (chunks.length === 0) {
              finish(new AmadeusError(ErrorCode.UNAVAILABLE, 'edge tts produced no audio'))
            } else {
              finish(null, { audio: Buffer.concat(chunks), words, mime: 'audio/mpeg', style })
            }
            return
          }
          if (s.includes('Path:audio.metadata')) {
            const meta = parseMetadata(s)
            for (const item of meta?.Metadata || []) {
              if (item.Type === 'WordBoundary' && item.Data) {
                words.push({
                  o: Math.round(Number(item.Data.Offset || 0) / 10000),
                  d: Math.round(Number(item.Data.Duration || 0) / 10000),
                })
              }
            }
          }
          return
        }
        const buf = payload
        if (buf.length < 2) return
        const headerLen = buf.readUInt16BE(0)
        const header = buf.subarray(2, 2 + headerLen).toString('utf8')
        if (!header.includes('Path:audio')) return
        chunks.push(buf.subarray(2 + headerLen))
      })

      ws.connect()
    })
  }

  return attempt()
}

/** Lightweight reachability probe used by the diagnostics page. */
export async function probe({ voice = 'ja-JP-NanamiNeural' } = {}) {
  try {
    const res = await synthesize({ text: 'テスト', voice, timeoutMs: 15000 })
    return { ok: true, bytes: res.audio.length }
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) }
  }
}

export const EDGE_VOICES = [
  'ja-JP-NanamiNeural',
  'ja-JP-KeitaNeural',
  'ja-JP-AoiNeural',
  'ja-JP-MayuNeural',
  'ja-JP-ShioriNeural',
  'ja-JP-NaokiNeural',
  'ja-JP-DaichiNeural',
]
