const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const TYPES = new Map([
  ['image/png', { suffix: '.png', match: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) }],
  ['image/jpeg', { suffix: '.jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['image/webp', { suffix: '.webp', match: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' }],
])

export function parseChatImage(value) {
  if (value == null) return null
  const mime = String(value?.mime || '')
  const type = TYPES.get(mime)
  const encoded = value?.data
  if (!type || typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('invalid image attachment (PNG, JPEG or WebP, max 3 MB)'), { status: 400 })
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded || !type.match(bytes)) {
    throw Object.assign(new Error('invalid image attachment'), { status: 400 })
  }
  return { mime, suffix: type.suffix, bytes }
}
