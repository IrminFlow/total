// Persistence for the agent (WP 5.1): threads, messages, drafts, usage, the outbound log and the
// pseudonym map — the AI migration tables (see migrations.ts, the "WP 5.1" entry). Nothing here touches the books.
import type { DB } from '../db/connection'
import type {
  AiContext, AiDraftDto, AiDraftStatus, AiFigure, AiMessageDto, AiMessageRole, AiOutboundRow, AiSource, AiThreadDto, AiToolCallDto, AiUsageRow, AiVoucherDraftPayload
} from '@shared/ai'
import { descendantIdsByName } from '../services/masters'
import { assignAliases, createPseudonymiser, type Pseudonymiser } from './privacy'

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))
const parse = <T>(s: string | null, fallback: T): T => {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

// ---------- threads ----------

interface ThreadRow {
  id: number
  title: string
  created_at: string
  updated_at: string
  n: number
  cost: number | null
  pinned: number
}

export function createThread(db: DB, title: string, userName: string | null): number {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation'
  return Number(db.prepare('INSERT INTO ai_threads (title, user_name) VALUES (?, ?)').run(t, userName).lastInsertRowid)
}

export function threadExists(db: DB, id: number): boolean {
  return !!db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(id)
}

export function touchThread(db: DB, id: number): void {
  db.prepare("UPDATE ai_threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id)
}

export function listThreads(db: DB, running: ReadonlySet<number> = new Set()): AiThreadDto[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.created_at, t.updated_at, t.pinned,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.thread_id = t.id AND m.role != 'tool') AS n,
              (SELECT SUM(u.cost_micro_usd) FROM ai_usage u WHERE u.thread_id = t.id) AS cost
         FROM ai_threads t ORDER BY t.pinned DESC, t.updated_at DESC, t.id DESC`
    )
    .all() as ThreadRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.n,
    costMicroUsd: r.cost,
    running: running.has(r.id),
    pinned: r.pinned === 1
  }))
}

export function getThread(db: DB, id: number): { id: number; title: string } | null {
  return (db.prepare('SELECT id, title FROM ai_threads WHERE id = ?').get(id) as { id: number; title: string } | undefined) ?? null
}

/** WP 5.2: rename (titles are the user's; the first question only seeds it). */
export function renameThread(db: DB, id: number, title: string): void {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!t) throw new Error('A conversation needs a title')
  db.prepare('UPDATE ai_threads SET title = ? WHERE id = ?').run(t, id)
}

export function setThreadPinned(db: DB, id: number, pinned: boolean): void {
  db.prepare('UPDATE ai_threads SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

/** WP 5.2 Regenerate: the thread's last user message, and how many messages follow it. */
export function lastUserMessage(db: DB, threadId: number): { id: number; content: string; after: number } | null {
  const r = db.prepare("SELECT id, content FROM ai_messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(threadId) as
    | { id: number; content: string }
    | undefined
  if (!r) return null
  const after = (db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ? AND id > ?').get(threadId, r.id) as { n: number }).n
  return { ...r, after }
}

/** Removes the answer to be regenerated (every message after `messageId`). Drafts it made keep
 *  their rows (message_id → NULL) — the user still decides on them; usage rows stay too. */
export function deleteMessagesAfter(db: DB, threadId: number, messageId: number): { messageIds: number[]; supersededDrafts: number[] } {
  const ids = (db.prepare('SELECT id FROM ai_messages WHERE thread_id = ? AND id > ? ORDER BY id').all(threadId, messageId) as { id: number }[]).map((r) => r.id)
  // Open drafts the discarded answer made can no longer be reviewed from it: superseded (before
  // the delete, which would null their message_id).
  const drafts = ids.length
    ? (db
        .prepare(`SELECT id FROM ai_drafts WHERE status = 'open' AND message_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as { id: number }[]).map((r) => r.id)
    : []
  for (const d of drafts) setDraftStatus(db, d, 'superseded')
  db.prepare('DELETE FROM ai_messages WHERE thread_id = ? AND id > ?').run(threadId, messageId)
  return { messageIds: ids, supersededDrafts: drafts }
}

/** WP 5.2: who started a thread (rename / pin / regenerate: its owner or an accountant+). */
export function threadOwner(db: DB, id: number): string | null {
  return (db.prepare('SELECT user_name FROM ai_threads WHERE id = ?').get(id) as { user_name: string | null } | undefined)?.user_name ?? null
}

export function deleteThread(db: DB, id: number): void {
  db.prepare('DELETE FROM ai_threads WHERE id = ?').run(id)
}

// ---------- messages ----------

interface MessageRow {
  id: number
  thread_id: number
  role: AiMessageRole
  content: string
  status: AiMessageDto['status']
  tool_calls_json: string | null
  tool_call_id: string | null
  tool_name: string | null
  tool_input_json: string | null
  tool_output_json: string | null
  tool_ok: number | null
  truncated: number
  sources_json: string | null
  figures_json: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_micro_usd: number | null
  draft_id: number | null
  sent_text: string | null
  sent_privacy: string | null
  reasoning_json: string | null
  context_json: string | null
  created_at: string
}

/** A stored message plus the main-only cache columns (never sent to the renderer — see toDto). */
export interface StoredMessage extends AiMessageDto {
  sentText: string | null
  sentPrivacy: string | null
  reasoning: Record<string, unknown>[]
}

/** The renderer's view of a message (drops the outbound cache and reasoning items). */
export function toDto(m: StoredMessage): AiMessageDto {
  const { sentText: _s, sentPrivacy: _p, reasoning: _r, ...dto } = m
  return dto
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    sentText: r.sent_text,
    sentPrivacy: r.sent_privacy,
    reasoning: parse<Record<string, unknown>[]>(r.reasoning_json, []),
    id: r.id,
    threadId: r.thread_id,
    role: r.role,
    content: r.content,
    status: r.status,
    toolCalls: parse<AiToolCallDto[]>(r.tool_calls_json, []),
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    toolInput: parse<unknown>(r.tool_input_json, null),
    toolOutput: parse<unknown>(r.tool_output_json, null),
    toolOk: r.tool_ok == null ? null : r.tool_ok === 1,
    truncated: r.truncated === 1,
    sources: parse<AiSource[]>(r.sources_json, []),
    figures: parse<AiFigure[]>(r.figures_json, []),
    model: r.model,
    costMicroUsd: r.cost_micro_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    draftId: r.draft_id,
    context: parse<AiContext | null>(r.context_json, null),
    createdAt: r.created_at
  }
}

export interface NewMessage {
  threadId: number
  role: AiMessageRole
  content?: string
  status?: AiMessageDto['status']
  toolCalls?: AiToolCallDto[]
  toolCallId?: string
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  toolOk?: boolean
  truncated?: boolean
  sources?: AiSource[]
  figures?: AiFigure[]
  model?: string
  inputTokens?: number
  outputTokens?: number
  costMicroUsd?: number | null
  draftId?: number | null
  sentText?: string | null
  sentPrivacy?: string | null
  reasoning?: Record<string, unknown>[]
  /** User messages: the screen context the question was asked with (Regenerate reuses it). */
  context?: AiContext | null
}

export function addMessage(db: DB, m: NewMessage): StoredMessage {
  const id = Number(
    db
      .prepare(
        `INSERT INTO ai_messages (thread_id, role, content, status, tool_calls_json, tool_call_id, tool_name, tool_input_json,
           tool_output_json, tool_ok, truncated, sources_json, figures_json, model, input_tokens, output_tokens, cost_micro_usd, draft_id,
           sent_text, sent_privacy, reasoning_json, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.threadId,
        m.role,
        m.content ?? '',
        m.status ?? 'ok',
        m.toolCalls?.length ? json(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.toolName ?? null,
        m.toolInput === undefined ? null : json(m.toolInput),
        m.toolOutput === undefined ? null : json(m.toolOutput),
        m.toolOk === undefined ? null : m.toolOk ? 1 : 0,
        m.truncated ? 1 : 0,
        m.sources?.length ? json(m.sources) : null,
        m.figures?.length ? json(m.figures) : null,
        m.model ?? null,
        m.inputTokens ?? null,
        m.outputTokens ?? null,
        m.costMicroUsd ?? null,
        m.draftId ?? null,
        m.sentText ?? null,
        m.sentPrivacy ?? null,
        m.reasoning?.length ? JSON.stringify(m.reasoning) : null,
        m.context ? JSON.stringify(m.context) : null
      ).lastInsertRowid
  )
  touchThread(db, m.threadId)
  return getMessage(db, id)!
}

export function updateMessageUsage(db: DB, id: number, u: { inputTokens: number; outputTokens: number; costMicroUsd: number | null; model: string }): void {
  db.prepare(
    `UPDATE ai_messages SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?,
       cost_micro_usd = CASE WHEN ? IS NULL THEN cost_micro_usd ELSE COALESCE(cost_micro_usd, 0) + ? END, model = ? WHERE id = ?`
  ).run(u.inputTokens, u.outputTokens, u.costMicroUsd, u.costMicroUsd, u.model, id)
}

export function getMessage(db: DB, id: number): StoredMessage | null {
  const r = db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(id) as MessageRow | undefined
  return r ? toMessage(r) : null
}

export function listMessages(db: DB, threadId: number): StoredMessage[] {
  return (db.prepare('SELECT * FROM ai_messages WHERE thread_id = ? ORDER BY id').all(threadId) as MessageRow[]).map(toMessage)
}

// ---------- drafts ----------

interface DraftRow {
  id: number
  thread_id: number | null
  kind: 'voucher'
  summary: string
  payload_json: string
  status: AiDraftStatus
  voucher_id: number | null
  unrequested: number
  created_at: string
  consumed_at: string | null
}

function toDraft(r: DraftRow): AiDraftDto {
  return {
    id: r.id,
    threadId: r.thread_id,
    kind: r.kind,
    summary: r.summary,
    payload: JSON.parse(r.payload_json) as AiVoucherDraftPayload,
    status: r.status,
    voucherId: r.voucher_id,
    unrequested: r.unrequested === 1,
    createdAt: r.created_at,
    consumedAt: r.consumed_at
  }
}

export function insertDraft(
  db: DB,
  d: { threadId: number | null; messageId: number | null; summary: string; payload: AiVoucherDraftPayload; unrequested?: boolean }
): AiDraftDto {
  const id = Number(
    db
      .prepare("INSERT INTO ai_drafts (thread_id, message_id, kind, summary, payload_json, unrequested) VALUES (?, ?, 'voucher', ?, ?, ?)")
      .run(d.threadId, d.messageId, d.summary, JSON.stringify(d.payload), d.unrequested ? 1 : 0).lastInsertRowid
  )
  return getDraft(db, id)!
}

export function getDraft(db: DB, id: number): AiDraftDto | null {
  const r = db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(id) as DraftRow | undefined
  return r ? toDraft(r) : null
}

export function listDrafts(db: DB, status?: AiDraftStatus, threadId?: number): AiDraftDto[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (status) {
    where.push('status = ?')
    args.push(status)
  }
  if (threadId !== undefined) {
    where.push('thread_id = ?')
    args.push(threadId)
  }
  const rows = db.prepare(`SELECT * FROM ai_drafts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`).all(...args) as DraftRow[]
  return rows.map(toDraft)
}

export function setDraftStatus(db: DB, id: number, status: AiDraftStatus, voucherId: number | null = null): void {
  db.prepare(
    `UPDATE ai_drafts SET status = ?, voucher_id = COALESCE(?, voucher_id),
       consumed_at = CASE WHEN ? = 'open' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END WHERE id = ?`
  ).run(status, voucherId, status, id)
}

// ---------- usage ----------

export interface NewUsage {
  threadId: number | null
  messageId: number | null
  provider: string
  model: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  costMicroUsd: number | null
  durationMs: number
  ok: boolean
  error?: string | null
  /** Local calendar day 'YYYY-MM-DD'. */
  day: string
}

export function recordUsage(db: DB, u: NewUsage): number {
  return Number(
    db
      .prepare(
        `INSERT INTO ai_usage (thread_id, message_id, day, provider, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens,
           cost_micro_usd, duration_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u.threadId, u.messageId, u.day, u.provider, u.model, u.inputTokens, u.cachedTokens, u.outputTokens, u.reasoningTokens,
        u.costMicroUsd, u.durationMs, u.ok ? 1 : 0, u.error ?? null
      ).lastInsertRowid
  )
}

export function listUsage(db: DB, limit = 2000): AiUsageRow[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.at, u.day, u.thread_id, t.title, u.model, u.input_tokens, u.cached_tokens, u.output_tokens, u.cost_micro_usd, u.duration_ms, u.ok
         FROM ai_usage u LEFT JOIN ai_threads t ON t.id = u.thread_id ORDER BY u.id DESC LIMIT ?`
    )
    .all(limit) as {
    id: number; at: string; day: string; thread_id: number | null; title: string | null; model: string; input_tokens: number
    cached_tokens: number; output_tokens: number; cost_micro_usd: number | null; duration_ms: number; ok: number
  }[]
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    day: r.day,
    threadId: r.thread_id,
    threadTitle: r.title,
    model: r.model,
    inputTokens: r.input_tokens,
    cachedTokens: r.cached_tokens,
    outputTokens: r.output_tokens,
    costMicroUsd: r.cost_micro_usd,
    durationMs: r.duration_ms,
    ok: r.ok === 1
  }))
}

// ---------- outbound log ----------

export interface NewOutbound {
  threadId: number | null
  provider: string
  model: string
  requestBytes: number
  instructionsBytes: number
  messageCount: number
  toolsOffered: string[]
  toolResultsSent: string[]
  masked: boolean
  pseudonymised: boolean
  payloadSha256: string
  /** WP 5.2: the screen context included (local record; the sent copy is masked). */
  context?: AiContext | null
}

export function logOutbound(db: DB, o: NewOutbound): number {
  return Number(
    db
      .prepare(
        `INSERT INTO ai_outbound_log (thread_id, provider, model, request_bytes, instructions_bytes, message_count, tools_offered_json,
           tool_results_json, masked, pseudonymised, payload_sha256, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        o.threadId, o.provider, o.model, o.requestBytes, o.instructionsBytes, o.messageCount, JSON.stringify(o.toolsOffered),
        JSON.stringify(o.toolResultsSent), o.masked ? 1 : 0, o.pseudonymised ? 1 : 0, o.payloadSha256,
        o.context ? JSON.stringify(o.context) : null
      ).lastInsertRowid
  )
}

export function setOutboundStatus(db: DB, id: number, status: 'sent' | 'ok' | 'error' | 'cancelled'): void {
  db.prepare('UPDATE ai_outbound_log SET status = ? WHERE id = ?').run(status, id)
}

export function listOutbound(db: DB, limit = 2000): AiOutboundRow[] {
  const rows = db.prepare('SELECT * FROM ai_outbound_log ORDER BY id DESC LIMIT ?').all(limit) as {
    id: number; at: string; thread_id: number | null; provider: string; model: string; request_bytes: number; message_count: number
    tools_offered_json: string; tool_results_json: string; masked: number; pseudonymised: number; payload_sha256: string; status: string; context_json: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    threadId: r.thread_id,
    model: r.model,
    provider: r.provider,
    requestBytes: r.request_bytes,
    messageCount: r.message_count,
    toolsOffered: parse<string[]>(r.tools_offered_json, []),
    toolResultsSent: parse<string[]>(r.tool_results_json, []),
    masked: r.masked === 1,
    pseudonymised: r.pseudonymised === 1,
    payloadSha256: r.payload_sha256,
    status: r.status,
    context: parse<AiContext | null>(r.context_json, null)
  }))
}

// ---------- pseudonyms ----------

/** Party ledgers = everything under Sundry Debtors / Sundry Creditors. Assigns any missing alias
 *  (stable: existing aliases never change) and returns the pseudonymiser for this company. */
export function companyPseudonymiser(db: DB): Pseudonymiser {
  const partyGroups = descendantIdsByName(db, ['Sundry Debtors', 'Sundry Creditors'])
  const parties = (db.prepare('SELECT id, name, group_id FROM ledgers').all() as { id: number; name: string; group_id: number }[]).filter((l) =>
    partyGroups.has(l.group_id)
  )
  const existing = new Map(
    (db.prepare('SELECT ledger_id, alias FROM ai_pseudonyms').all() as { ledger_id: number; alias: string }[]).map((r) => [r.ledger_id, r.alias])
  )
  const fresh = assignAliases(existing, parties.map((p) => p.id))
  if (fresh.length) {
    const ins = db.prepare('INSERT INTO ai_pseudonyms (ledger_id, alias) VALUES (?, ?)')
    db.transaction(() => {
      for (const f of fresh) {
        ins.run(f.ledgerId, f.alias)
        existing.set(f.ledgerId, f.alias)
      }
    })()
  }
  const others = (db.prepare('SELECT name, group_id FROM ledgers').all() as { name: string; group_id: number }[])
    .filter((l) => !partyGroups.has(l.group_id))
    .map((l) => l.name)
  const groups = (db.prepare('SELECT name FROM groups').all() as { name: string }[]).map((g) => g.name)
  return createPseudonymiser(parties.map((p) => ({ name: p.name, alias: existing.get(p.id)! })), [...others, ...groups])
}

// ---------- delete everything ----------

export interface AiDataCounts {
  threads: number
  messages: number
  drafts: number
  memory: number
  usage: number
  outbound: number
  pseudonyms: number
}

export function aiDataCounts(db: DB): AiDataCounts {
  const n = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  return {
    threads: n('ai_threads'),
    messages: n('ai_messages'),
    drafts: n('ai_drafts'),
    memory: n('ai_memory'),
    usage: n('ai_usage'),
    outbound: n('ai_outbound_log'),
    pseudonyms: n('ai_pseudonyms')
  }
}

/** Threads (and their messages), drafts, memory and the pseudonym map. Usage and the outbound log
 *  are kept — they are the record of what was spent and sent — unless `includeLogs`. */
export function deleteAllAiData(db: DB, includeLogs: boolean): AiDataCounts {
  const before = aiDataCounts(db)
  db.transaction(() => {
    db.exec('DELETE FROM ai_drafts; DELETE FROM ai_messages; DELETE FROM ai_threads; DELETE FROM ai_memory; DELETE FROM ai_pseudonyms;')
    if (includeLogs) db.exec('DELETE FROM ai_usage; DELETE FROM ai_outbound_log;')
    // Kept logs keep their sizes and fingerprints, not the (masked) screen context that was sent.
    else db.exec('UPDATE ai_outbound_log SET context_json = NULL WHERE context_json IS NOT NULL;')
  })()
  return before
}
