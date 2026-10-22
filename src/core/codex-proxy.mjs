import { execFile } from 'node:child_process'

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const CACHE_MS = 60000
let cached = { at: 0, value: null }

/** Only the HTTPS proxy from Windows' enabled user setting is relevant here. */
export function parseWinInetProxy(output) {
  const text = String(output || '')
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/im.test(text)) return null
  const raw = text.match(/^\s*ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im)?.[1]?.trim()
  if (!raw || raw.length > 512) return null
  const value = raw.match(/(?:^|;)https=([^;]+)/i)?.[1]?.trim()
    || (/^[^=;]+$/.test(raw) ? raw : null)
  if (!value || /\s|@/.test(value)) return null
  if (!/:\d+$/.test(value.replace(/^[a-z]+:\/\//i, ''))) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function readWindowsProxy() {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', INTERNET_SETTINGS], {
      windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024,
    }, (error, stdout) => resolve(error ? null : parseWinInetProxy(stdout)))
  })
}

/** Keep existing proxy env untouched; never edit system or Codex global settings. */
export async function codexChildEnv({ env = process.env, platform = process.platform, now = Date.now() } = {}) {
  if (platform !== 'win32' || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return env
  if (now - cached.at >= CACHE_MS) cached = { at: now, value: await readWindowsProxy() }
  return cached.value ? { ...env, HTTPS_PROXY: cached.value } : env
}
