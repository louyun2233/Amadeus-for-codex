#!/usr/bin/env node
/**
 * MCP stdio server for Amadeus.
 *
 * This process is intentionally thin: it holds no state, and forwards every
 * tool call to the resident daemon (starting it on first use). That keeps the
 * "one companion" invariant while still letting the agent call into her.
 */
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePaths, ensureDirs } from '../src/shared/paths.mjs'
import { APP_VERSION } from '../src/shared/version.mjs'
import { ensureDaemon, callDaemon, readDaemonInfo } from '../src/host/daemon-client.mjs'
import { openPanel } from '../src/host/panel-launcher.mjs'

const paths = ensureDirs(resolvePaths())
const autoOpenMarker = path.join(paths.runtimeDir, 'mcp-auto-open')
const openedParentFile = path.join(paths.runtimeDir, 'mcp-opened-parent')
let autoOpenStarted = false

function openPanelOnConnect() {
  if (autoOpenStarted || !fs.existsSync(autoOpenMarker)) return
  autoOpenStarted = true
  // Codex may start more than one MCP instance for the same desktop session.
  // Remember its parent PID so closing the panel stays a user decision until
  // Codex itself is restarted.
  try {
    if (fs.readFileSync(openedParentFile, 'utf8') === String(process.ppid)) return
  } catch {
    /* first launch */
  }
  try {
    fs.writeFileSync(openedParentFile, String(process.ppid), { mode: 0o600 })
  } catch {
    /* the in-memory latch still avoids repeats in this process */
  }
  // Do not delay MCP initialization while the daemon and native panel start.
  setImmediate(async () => {
    try {
      const result = await openPanel({ paths, welcome: true })
      if (result?.ok) return
    } catch {
      /* a failed launch can be retried by the next MCP connection */
    }
    try {
      if (fs.readFileSync(openedParentFile, 'utf8') === String(process.ppid)) {
        fs.unlinkSync(openedParentFile)
      }
    } catch {
      /* the watcher still provides an independent retry path */
    }
  })
}

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'amadeus', version: APP_VERSION }

const TOOLS = [
  {
    name: 'amadeus_status',
    description:
      'Amadeus 的运行状态：语音/记忆/面板/能力自检摘要（不含任何密钥）。需要确认伴侣是否在线时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_capabilities',
    description: '列出各能力（对话模型、语音合成、语音输入、Live2D 资源）的可用性与降级原因。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_recall',
    description: '按关键词检索 Amadeus 的长期记忆。默认检索面板聊天记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        namespace: { type: 'string', enum: ['panel', 'codex'], description: '记忆命名空间' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_remember',
    description:
      '把一条值得长期记住的信息写入 Amadeus 的 codex 记忆库。用于记录用户偏好、决定、进行中的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容（一句话）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
        workspace: { type: 'string', description: '可选：所属工作区' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_forget',
    description: '按关键词或 id 删除记忆。删除前建议先用 amadeus_recall 确认。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id' },
        query: { type: 'string', description: '或按关键词删除' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_export',
    description: '导出全部记忆（JSON），用于备份。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_say',
    description:
      '让 Amadeus 用日语朗读一句话（面板需要处于打开状态）。默认需要预先授权，见 permissions.preauthorizeSay。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的日文' },
        emotion: { type: 'string', description: '情绪标签，默认 neutral' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_call',
    description: '让 Amadeus 主动「打电话」到面板（播放来电界面）。默认需要预先授权。',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: '可选：来电原因' } },
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_open_panel',
    description: '打开 Amadeus 原生 Windows 面板，或报告面板已打开；不返回会话令牌。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_sessions',
    description: '列出 Amadeus 的伴侣会话。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_assets_status',
    description:
      '查询 Live2D 素材状态：模型是否已安装、Cubism 2 运行时是否就绪、哈希是否匹配。面板看不到角色时先用这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_assets_install',
    description:
      '安装或修复 Live2D 素材（模型 + Cubism 2 运行时）。只从项目内置注册表登记的来源下载并校验 SHA-256，只写入用户自己的缓存目录。',
    inputSchema: {
      type: 'object',
      properties: {
        packId: { type: 'string', description: '可选：只安装指定素材包；包 ID 见 config/assets.registry.json' },
        force: { type: 'boolean', description: '可选：忽略已下载缓存，强制重新下载' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'amadeus_proactive',
    description:
      '查询主动交互调度状态：来电与空闲开关、间隔、距上次互动多久、是否正在生成台词、当前有几个面板连着。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amadeus_memory_clear',
    description: '清空某个命名空间的记忆（破坏性操作）。',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', enum: ['panel', 'codex'] },
        confirm: { type: 'boolean', description: '必须显式传 true' },
      },
      required: ['namespace', 'confirm'],
      additionalProperties: false,
    },
  },
]

async function statusSnapshot() {
  const { body } = await callDaemon(paths, 'GET', '/amadeus/status')
  return body
}

async function preauthorized(flag) {
  const { body } = await callDaemon(paths, 'GET', '/amadeus/config')
  return body?.config?.permissions?.[flag] === true
}

async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'amadeus_status': {
      const body = await statusSnapshot()
      return { ok: body?.ok !== false, status: body }
    }
    case 'amadeus_capabilities': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/diag')
      return body
    }
    case 'amadeus_recall': {
      const q = encodeURIComponent(String(a.query ?? ''))
      const limit = Number(a.limit || 8)
      const ns = `&namespace=${encodeURIComponent(a.namespace || 'panel')}`
      const { body } = await callDaemon(paths, 'GET', `/amadeus/memory?q=${q}&limit=${limit}${ns}`)
      return body
    }
    case 'amadeus_remember': {
      const { body } = await callDaemon(paths, 'POST', '/amadeus/memory', {
        namespace: 'codex',
        content: a.text,
        tags: a.tags,
        workspace: a.workspace,
        source: 'mcp',
      })
      return body
    }
    case 'amadeus_forget': {
      if (a.id) {
        const { body } = await callDaemon(paths, 'DELETE', `/amadeus/memory?id=${encodeURIComponent(a.id)}`)
        return body
      }
      const { body } = await callDaemon(paths, 'POST', '/amadeus/memory/forget', { query: a.query })
      return body
    }
    case 'amadeus_export': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/memory/export')
      return body
    }
    case 'amadeus_say': {
      if (!(await preauthorized('preauthorizeSay'))) {
        return {
          ok: false,
          code: 'needs_confirmation',
          reason: 'amadeus_say 需要预先授权：请在面板设置里开启「允许模型主动发声」。',
        }
      }
      const { body } = await callDaemon(paths, 'POST', '/amadeus/say', { text: a.text, emotion: a.emotion })
      return body
    }
    case 'amadeus_call': {
      if (!(await preauthorized('preauthorizeCall'))) {
        return {
          ok: false,
          code: 'needs_confirmation',
          reason: 'amadeus_call 需要预先授权：请在面板设置里开启「允许模型触发来电」。',
        }
      }
      const { body } = await callDaemon(paths, 'POST', '/amadeus/call', { reason: a.reason })
      return body
    }
    case 'amadeus_open_panel': {
      const result = await openPanel({ paths, welcome: true })
      return {
        ok: result.ok,
        status: result.status,
        note: result.ok ? 'Amadeus 原生面板已打开或正在启动。' : '原生面板无法启动，请检查安装与自检结果。',
      }
    }
    case 'amadeus_sessions': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/sessions')
      return body
    }
    case 'amadeus_assets_status': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/assets/status')
      return body
    }
    case 'amadeus_assets_install': {
      const payload = a.packId ? { packId: a.packId, force: a.force === true } : { force: a.force === true }
      const { body } = await callDaemon(paths, 'POST', '/amadeus/assets/install', payload)
      return body
    }
    case 'amadeus_proactive': {
      const { body } = await callDaemon(paths, 'GET', '/amadeus/proactive')
      return body
    }
    case 'amadeus_memory_clear': {
      if (a.confirm !== true) {
        return { ok: false, code: 'needs_confirmation', reason: '需要 confirm:true 才会清空记忆。' }
      }
      const { body } = await callDaemon(paths, 'POST', '/amadeus/memory/clear', { namespace: a.namespace })
      return body
    }
    default:
      return { ok: false, code: 'unknown_tool', reason: `unknown tool: ${name}` }
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    })
    openPanelOnConnect()
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    try {
      const result = await callTool(name, args)
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result && result.ok === false,
      })
    } catch (e) {
      return reply(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              code: 'internal',
              reason: e && e.message ? e.message : String(e),
            }),
          },
        ],
        isError: true,
      })
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  handle(msg).catch(() => {})
})

// Warm the daemon in the background so the first tool call is fast.
ensureDaemon(paths, { timeoutMs: 10000 }).catch(() => {})
void readDaemonInfo
