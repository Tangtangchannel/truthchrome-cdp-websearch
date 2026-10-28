import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Append-only JSONL trace of what the browser provider did.
 *
 * The trace exists so a search can be audited without exposing anything the
 * model saw: it records a salted-free SHA-256 prefix of the query (enough to
 * tell two searches apart, not enough to read one back), the engine name, the
 * result count, and a duration. Page bodies, URLs, cookies, and the query text
 * itself are never written.
 */
export function createJournal(settings) {
  if (!settings.journal) return { record() {}, close() {}, path: undefined }

  let ready = false
  const ensureDirectory = () => {
    if (ready) return true
    try {
      mkdirSync(dirname(settings.journalPath), { recursive: true })
      ready = true
      return true
    } catch {
      return false
    }
  }

  return {
    path: settings.journalPath,
    /**
     * Append one record. Never throws: observability must not break a request.
     *
     * @param {{ op: 'search' | 'fetch' | 'download' | 'xhs', ok: boolean, engine?: string, count?: number, bytes?: number, durationMs: number, query?: string, host?: string, code?: string }} entry - trace fields.
     */
    record(entry) {
      if (!ensureDirectory()) return
      const record = {
        ts: new Date().toISOString(),
        provider: 'browser',
        op: entry.op,
        ok: entry.ok,
      }
      if (entry.engine !== undefined) record.engine = entry.engine
      if (entry.count !== undefined) record.count = entry.count
      if (entry.bytes !== undefined) record.bytes = entry.bytes
      if (entry.host !== undefined) record.host = entry.host
      if (entry.code !== undefined) record.code = entry.code
      if (entry.query !== undefined) record.queryHash = hash(entry.query)
      record.durationMs = Math.round(entry.durationMs)
      try {
        appendFileSync(settings.journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      } catch {
        // Tracing is optional; a read-only home directory must not fail a search.
      }
    },
    close() {},
  }
}

/**
 * Short, non-reversible fingerprint of a query, for correlating trace lines.
 *
 * @param {string} query - the query text.
 * @returns {string} first 16 hex characters of SHA-256.
 */
export function hash(query) {
  return createHash('sha256').update(String(query), 'utf8').digest('hex').slice(0, 16)
}
