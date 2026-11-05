import http from 'node:http'
import { Readable } from 'node:stream'

/** Direct local transport: no environment proxy and no redirect following. */
export function fetchLoopback(input, { method = 'GET', headers = {}, body, signal } = {}) {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new TypeError('expected a local daemon address')
  }
  // Never resolve a loopback hostname through a configured DNS/proxy service.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, signal, agent: false }, (response) => {
      const responseHeaders = new Headers()
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1])
      }
      const status = response.statusCode || 500
      const empty = method === 'HEAD' || [204, 205, 304].includes(status)
      if (empty) response.resume()
      resolve(new Response(empty ? null : Readable.toWeb(response), { status, headers: responseHeaders }))
    })
    request.on('error', reject)
    if (body !== undefined && body !== null) request.write(body)
    request.end()
  })
}
