import { execFile } from 'node:child_process'
import { AmadeusError, ErrorCode } from '../shared/errors.mjs'

export const COMPANION_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'view_image', 'apps', 'plugins', 'multi_agent',
  'code_mode_host', 'image_generation', 'skill_search',
  'hooks', 'computer_use', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'code_mode', 'artifact', 'memories',
])

export function companionToolArgs(serverNames = []) {
  const args = COMPANION_DISABLED_FEATURES.flatMap((name) => ['--disable', name])
  args.push('--config', 'web_search="disabled"', '--config', 'notify=[]')
  for (const name of serverNames) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new AmadeusError(ErrorCode.UNAVAILABLE, '聊天权限隔离失败：MCP 名称格式不支持')
    }
    args.push('--config', `mcp_servers.${name}.enabled=false`)
  }
  return args
}

/** Resolve names with plugins already disabled. Never return launch args/env. */
export function listConfiguredMcpServers(target, { cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(target.cmd, [...target.argsPrefix, '--disable', 'plugins', '--disable', 'apps', 'mcp', 'list', '--json'], {
      cwd, env, signal, windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (signal?.aborted) return reject(signal.reason)
      if (error) return reject(new AmadeusError(ErrorCode.UNAVAILABLE, '无法确认聊天子进程的 MCP 隔离，已停止本次调用'))
      try {
        const entries = JSON.parse(stdout)
        if (!Array.isArray(entries) || entries.length > 128) throw new Error('invalid MCP list')
        const names = entries.map((entry) => entry.name)
        companionToolArgs(names)
        resolve(names)
      } catch {
        reject(new AmadeusError(ErrorCode.UNAVAILABLE, '聊天子进程的 MCP 配置无法安全解析'))
      }
    })
  })
}

/** Retain provider/proxy auth while dropping inherited host-control channels. */
export function companionEnvironment(env) {
  const keepCodex = new Set(['CODEX_HOME', 'CODEX_API_KEY'])
  return Object.fromEntries(Object.entries(env).filter(([name]) => {
    const key = name.toUpperCase()
    return !key.startsWith('AMADEUS_') && (!key.startsWith('CODEX_') || keepCodex.has(key))
  }))
}
