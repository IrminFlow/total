// mcp_log (WP 5.7): one row per MCP request — what was asked (method + tool / resource), by which
// client, under which role and privacy options, whether it succeeded, the response size and a
// SHA-256 of exactly what was returned. Never the content. Like ai_outbound_log, it is the record
// of what left Total; no SDK import here (the app reads it for Settings → Agent access).
import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import type { McpLogRow, McpRole } from '@shared/mcp'

export interface NewMcpLog {
  sessionId: string
  clientName: string | null
  clientVersion: string | null
  role: McpRole
  userName: string | null
  method: string
  target?: string | null
  ok: boolean
  error?: string | null
  /** The exact response text (hashed and measured here, never stored). */
  response?: string | null
  masked: boolean
  pseudonymised: boolean
  draftId?: number | null
  durationMs?: number
}

export function logMcp(db: DB, e: NewMcpLog): number {
  const response = e.response ?? null
  return Number(
    db
      .prepare(
        `INSERT INTO mcp_log (session_id, client_name, client_version, role, user_name, method, target, ok, error, response_bytes,
           response_sha256, masked, pseudonymised, draft_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.sessionId, e.clientName, e.clientVersion, e.role, e.userName, e.method, e.target ?? null, e.ok ? 1 : 0, e.error?.slice(0, 500) ?? null,
        response === null ? 0 : Buffer.byteLength(response, 'utf8'),
        response === null ? null : createHash('sha256').update(response, 'utf8').digest('hex'),
        e.masked ? 1 : 0, e.pseudonymised ? 1 : 0, e.draftId ?? null, Math.max(0, Math.round(e.durationMs ?? 0))
      ).lastInsertRowid
  )
}

interface Row {
  id: number
  at: string
  session_id: string
  client_name: string | null
  client_version: string | null
  role: McpRole
  user_name: string | null
  method: string
  target: string | null
  ok: number
  error: string | null
  response_bytes: number
  response_sha256: string | null
  masked: number
  pseudonymised: number
  draft_id: number | null
  duration_ms: number
}

export function listMcpLog(db: DB, limit = 2000): McpLogRow[] {
  return (db.prepare('SELECT * FROM mcp_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
    id: r.id,
    at: r.at,
    sessionId: r.session_id,
    clientName: r.client_name,
    clientVersion: r.client_version,
    role: r.role,
    userName: r.user_name,
    method: r.method,
    target: r.target,
    ok: r.ok === 1,
    error: r.error,
    responseBytes: r.response_bytes,
    responseSha256: r.response_sha256,
    masked: r.masked === 1,
    pseudonymised: r.pseudonymised === 1,
    draftId: r.draft_id,
    durationMs: r.duration_ms
  }))
}
