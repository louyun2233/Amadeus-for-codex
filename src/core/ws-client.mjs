import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { URL } from 'node:url'

/**
 * Minimal RFC6455 WebSocket client.
 *
 * Node's built-in WebSocket cannot set request headers, and the Edge TTS
 * endpoint requires Origin/User-Agent/Cookie to accept the upgrade. Rather than
 * take a dependency we implement the small subset we need: text and binary
 * frames, fragmentation, ping/pong, close. No extensions are negotiated, so
 * permessage-deflate never enters the picture.
 */

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
const MAX_PAYLOAD = 32 * 1024 * 1024

export class WsClient extends EventEmitter {
  constructor(url, { headers = {}, timeoutMs = 15000 } = {}) {
    super()
    this.url = url
    this.headers = headers
    this.timeoutMs = timeoutMs
    this.socket = null
    this.open = false
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOp = null
    this.handshakeBuffer = Buffer.alloc(0)
    this.setMaxListeners(50)
  }

  connect() {
    let target
    try {
      target = new URL(this.url)
    } catch (e) {
      queueMicrotask(() => this.#fail(new Error(`invalid websocket url: ${e.message}`)))
      return this
    }
    const secure = target.protocol === 'wss:'
    const port = target.port ? Number(target.port) : secure ? 443 : 80
    const key = crypto.randomBytes(16).toString('base64')
    this.expectAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    for (const [k, v] of Object.entries(this.headers)) {
      if (v === undefined || v === null) continue
      lines.push(`${k}: ${v}`)
    }
    this.handshake = lines.join('\r\n') + '\r\n\r\n'

    const timer = setTimeout(() => {
      if (!this.open) this.#fail(new Error('websocket handshake timeout'))
    }, this.timeoutMs)
    this.handshakeTimer = timer

    const onConnect = () => {
      if (this.socket && typeof this.socket.setNoDelay === 'function') this.socket.setNoDelay(true)
      // The handshake must be sent as soon as the transport is up; waiting for
      // the response first would deadlock.
      try {
        this.socket.write(this.handshake)
      } catch (e) {
        this.#fail(e)
      }
    }
    this.socket = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname }, onConnect)
      : net.connect({ host: target.hostname, port }, onConnect)

    this.socket.on('data', (chunk) => this.#onData(chunk))
    this.socket.on('error', (e) => this.#fail(e))
    this.socket.on('close', () => this.#handleClose())
  }

  #fail(err) {
    if (this.closed) return
    this.closed = true
    this.#clearTimer()
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.emit('error', err)
    this.emit('close', { code: 1006, reason: String(err && err.message) })
  }

  #clearTimer() {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  #onData(chunk) {
    if (!this.open) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk])
      const end = this.handshakeBuffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.handshakeBuffer.subarray(0, end).toString('latin1')
      const rest = this.handshakeBuffer.subarray(end + 4)
      this.handshakeBuffer = Buffer.alloc(0)
      const statusLine = head.split('\r\n')[0] || ''
      if (!/ 101 /.test(statusLine)) {
        // Keep the response metadata: the Date header is how a client can
        // notice that its own clock is off (a 403 here is often exactly that).
        const err = new Error(`websocket upgrade rejected: ${statusLine}`)
        const status = Number((statusLine.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1])
        if (Number.isFinite(status)) err.status = status
        err.statusLine = statusLine
        err.headers = Object.fromEntries(
          head
            .split('\r\n')
            .slice(1)
            .map((line) => {
              const at = line.indexOf(':')
              return at < 0 ? null : [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]
            })
            .filter(Boolean),
        )
        this.#fail(err)
        return
      }
      const acceptLine = head
        .split('\r\n')
        .find((l) => l.toLowerCase().startsWith('sec-websocket-accept:'))
      const accept = acceptLine ? acceptLine.split(':')[1].trim() : ''
      if (accept !== this.expectAccept) {
        this.#fail(new Error('websocket accept mismatch'))
        return
      }
      this.open = true
      this.#clearTimer()
      this.emit('open')
      if (rest.length > 0) this.#onData(rest)
      return
    }

    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.#readFrame()
      if (!frame) break
      this.#handleFrame(frame)
    }
  }

  #readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(MAX_PAYLOAD)) {
        this.#fail(new Error('websocket frame too large'))
        return null
      }
      len = Number(big)
      offset += 8
    }
    let maskKey = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + len) return null

    let payload = buf.subarray(offset, offset + len)
    if (maskKey) {
      const copy = Buffer.from(payload)
      for (let i = 0; i < copy.length; i++) copy[i] ^= maskKey[i % 4]
      payload = copy
    }
    this.buffer = buf.subarray(offset + len)
    return { fin, opcode, payload }
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === OP.PING) {
      this.#sendFrame(OP.PONG, payload)
      return
    }
    if (opcode === OP.PONG) return
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.#sendFrame(OP.CLOSE, payload.subarray(0, 2))
      this.closed = true
      this.#clearTimer()
      try {
        this.socket.end()
      } catch {
        /* ignore */
      }
      this.emit('close', { code, reason: payload.subarray(2).toString('utf8') })
      return
    }
    if (opcode === OP.CONT) {
      this.fragments.push(payload)
      if (fin) {
        const full = Buffer.concat(this.fragments)
        const op = this.fragmentOp
        this.fragments = []
        this.fragmentOp = null
        this.emit('message', full, op === OP.BINARY)
      }
      return
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (!fin) {
        this.fragments = [payload]
        this.fragmentOp = opcode
        return
      }
      this.emit('message', payload, opcode === OP.BINARY)
    }
  }

  #handleClose() {
    if (this.closed) return
    this.closed = true
    this.#clearTimer()
    this.emit('close', { code: 1006, reason: 'socket closed' })
  }

  #sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(6)
      header[1] = 0x80 | len
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(14)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    const mask = crypto.randomBytes(4)
    mask.copy(header, header.length - 4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
    this.socket.write(Buffer.concat([header, masked]))
  }

  send(data) {
    if (typeof data === 'string') this.#sendFrame(OP.TEXT, Buffer.from(data, 'utf8'))
    else this.#sendFrame(OP.BINARY, Buffer.from(data))
  }

  close() {
    if (this.closed) return
    try {
      this.#sendFrame(OP.CLOSE, Buffer.from([0x03, 0xe8]))
    } catch {
      /* ignore */
    }
    this.closed = true
    this.#clearTimer()
    try {
      this.socket?.end()
    } catch {
      /* ignore */
    }
    this.emit('close', { code: 1000, reason: 'client closed' })
  }
}
