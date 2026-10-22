import { appendJsonl, readJsonl } from './store.mjs'
import { redactText } from './redact.mjs'

/**
 * Append-only audit trail for every mutating operation. Entries never contain
 * raw secrets and store only a short, redacted summary of user content -
 * paths, URLs with query strings and credential-looking strings are stripped
 * before the row is written, because this file is also what a support report
 * copies from.
 */
export class AuditLog {
  constructor(paths) {
    this.file = paths.auditFile
  }

  record(entry) {
    const row = {
      ts: Date.now(),
      source: entry.source || 'unknown',
      tool: entry.tool || 'unknown',
      summary: redactText(entry.summary).slice(0, 200),
      undo: entry.undo ?? null,
    }
    try {
      appendJsonl(this.file, row)
    } catch {
      /* audit must never break the caller */
    }
    return row
  }

  recent(limit = 50) {
    return readJsonl(this.file, limit)
  }
}
