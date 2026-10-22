import { describeMemory } from '../core/memory.mjs'

/** Long-term memory endpoints shared by the panel and the MCP/CLI clients. */
export function createMemoryRoutes({ guard, readBody, sendJson, memory, audit, hub }) {
  return {
    'GET /amadeus/memory': guard(async (req, res, url) => {
      const namespace = url.searchParams.get('namespace') || undefined
      const query = url.searchParams.get('q') || ''
      const limit = Number(url.searchParams.get('limit') || 50)
      // Corrected facts are hidden by default; includeSuperseded=1 exposes them for auditing.
      const includeSuperseded = url.searchParams.get('includeSuperseded') === '1'
      const entries = query
        ? memory.search(query, { k: limit, namespace, includeSuperseded })
        : memory.list(namespace || 'panel', { limit, includeSuperseded })
      sendJson(res, 200, {
        ok: true,
        entries: entries.map((entry) => ({ ...entry, provenance: describeMemory(entry) })),
        stats: memory.stats(),
      })
    }),

    'GET /amadeus/memory/export': guard(async (req, res) => {
      sendJson(res, 200, { ok: true, data: memory.exportAll() })
    }),

    'POST /amadeus/memory': guard(async (req, res) => {
      const body = await readBody(req)
      const entry = memory.add(body?.namespace || 'codex', {
        content: body?.content,
        tags: body?.tags,
        workspace: body?.workspace,
        source: body?.source || 'api',
        type: body?.type,
      })
      audit.record({ source: body?.source || 'api', tool: 'memory.add', summary: entry.content })
      hub.broadcast('memory', memory.stats())
      sendJson(res, 200, { ok: true, entry })
    }),

    'POST /amadeus/memory/forget': guard(async (req, res) => {
      const body = await readBody(req)
      if (!body?.query) return sendJson(res, 400, { ok: false, error: 'missing query' })
      const result = memory.forgetByQuery(body.query)
      audit.record({ source: body?.source || 'api', tool: 'memory.forget', summary: body.query })
      hub.broadcast('memory', memory.stats())
      sendJson(res, 200, { ok: true, ...result })
    }),

    'POST /amadeus/memory/clear': guard(async (req, res) => {
      const body = await readBody(req)
      const namespace = body?.namespace || 'panel'
      const result = memory.clear(namespace)
      audit.record({ source: 'panel', tool: 'memory.clear', summary: namespace })
      hub.broadcast('memory', { namespace, ...memory.stats() })
      sendJson(res, 200, { ok: true, ...result })
    }),

    'DELETE /amadeus/memory': guard(async (req, res, url) => {
      const id = url.searchParams.get('id')
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
      const result = memory.remove(id)
      audit.record({ source: 'panel', tool: 'memory.remove', summary: id })
      hub.broadcast('memory', { ...memory.stats() })
      sendJson(res, 200, { ok: true, ...result })
    }),
  }
}
