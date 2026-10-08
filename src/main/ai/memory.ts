// Per-company AI memory (WP 5.6) — the rows (ai_memory, in the company DB like the threads: a
// backup copies the file, so it carries them; the books export / import does NOT include AI data),
// every write audited (entity 'ai_memory'), the book statistics behind derived suggestions, and
// the `remember` tool.
//
// Who writes what:
//   - the user (Settings → AI → Memory, or the panel's "Remember this?"): creates entries active,
//     edits, accepts, archives, deletes; an owner may forget everything;
//   - the assistant (`remember`): only ever a 'suggested' row, flagged `unrequested` when the
//     user's message carries no remember intent (drafting/intent.ts isRequestedMemory); over MCP
//     the row is source 'mcp' with the client's name in `origin` (an explicit tool call);
//   - the books (proposeMemories): suggestions computed at query time, never stored until the user
//     accepts (an active 'derived' row) or dismisses them (an archived one, so it is not offered again).
// The pure rules (identifier refusal, block cap, derivation) live in memoryRules.ts.
import { z } from 'zod'
import type { DB } from '../db/connection'
import {
  AI_MEMORY_KINDS, aiMemoryDataSchema, type AiMemoryCreateInput, type AiMemoryData, type AiMemoryDto, type AiMemoryKind, type AiMemoryList,
  type AiMemoryPurpose, type AiMemorySource, type AiMemoryStatus, type AiMemorySuggestion, type AiMemoryUpdateInput
} from '@shared/ai'
import { IN_BOOKS } from '../services/vouchers'
import { writeAudit } from '../services/audit'
import { defineTool } from './tools/registry'
import { isRequestedMemory as requestedMemory } from './drafting/intent'
import { currentDraftOrigin } from './store'
import { ledgerClassifier, partyLedgerFits, purposeProblem } from './ledgerClass'
import {
  EMPTY_MEMORY_CONTEXT, buildMemoryBlock, createMemoryContext, memoryProblems, proposeMemories, renderPartyName, type MemoryContext, templatePartyName, type BookStats, type KindLedgerStat, type PartyStat
} from './memoryRules'

const parse = <T>(s: string | null, fallback: T): T => {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

interface MemoryRow {
  id: number
  kind: AiMemoryKind
  key: string | null
  text: string
  data_json: string | null
  source: AiMemorySource
  status: AiMemoryStatus
  unrequested: number
  thread_id: number | null
  message_id: number | null
  created_by: string | null
  origin: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  use_count: number
}

const nameOf = (db: DB, table: 'ledgers' | 'stock_items', id: number | undefined): string | undefined =>
  id ? ((db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? undefined) : undefined

function labelsFor(db: DB, data: AiMemoryData | null): AiMemoryDto['labels'] {
  const labels: AiMemoryDto['labels'] = {}
  if (data?.ledgerId) labels.ledger = nameOf(db, 'ledgers', data.ledgerId)
  if (data?.partyLedgerId) labels.party = nameOf(db, 'ledgers', data.partyLedgerId)
  if (data?.itemId) labels.item = nameOf(db, 'stock_items', data.itemId)
  return labels
}

function toDto(db: DB, r: MemoryRow): AiMemoryDto {
  const data = parse<AiMemoryData | null>(r.data_json, null)
  const labels = labelsFor(db, data)
  return {
    id: r.id,
    kind: r.kind,
    // Party names are stored as a token and shown with the party's CURRENT name (a renamed party
    // never leaves its old name behind, and the live name is pseudonymised like any party name).
    text: data?.partyLedgerId ? renderPartyName(r.text, labels.party ?? null) : r.text,
    data,
    source: r.source,
    status: r.status,
    unrequested: r.unrequested === 1,
    threadId: r.thread_id,
    createdBy: r.created_by,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    labels
  }
}

export function getMemory(db: DB, id: number): AiMemoryDto | null {
  const r = db.prepare('SELECT * FROM ai_memory WHERE id = ?').get(id) as MemoryRow | undefined
  return r ? toDto(db, r) : null
}

export function listMemory(db: DB, status?: AiMemoryStatus): AiMemoryDto[] {
  const rows = (status
    ? db.prepare('SELECT * FROM ai_memory WHERE status = ? ORDER BY updated_at DESC, id DESC').all(status)
    : db.prepare('SELECT * FROM ai_memory ORDER BY updated_at DESC, id DESC').all()) as MemoryRow[]
  return rows.map((r) => toDto(db, r))
}

export function activeMemories(db: DB): AiMemoryDto[] {
  return listMemory(db, 'active')
}

/** The memory context outside a chat turn (MCP tool calls): the same entries a chat question's
 *  block would carry (cap and order), and none while "Use memory" is off. */
export function memoryContextFor(db: DB, useMemory: boolean): MemoryContext {
  if (!useMemory) return EMPTY_MEMORY_CONTEXT
  const all = activeMemories(db)
  const ids = new Set(buildMemoryBlock(all).ids)
  return createMemoryContext(all.filter((m) => ids.has(m.id)))
}

/** The ids the data points at must exist and fit (a typo'd id would make a draft pick the wrong
 *  ledger): a preferred ledger must suit its purpose (cash / bank for payment / receipt, expense
 *  for expense / purchase, income for sales / income); a party memory's party must be a debtor or
 *  creditor and its usual ledger an income (debtor) or expense (creditor) ledger. */
function checkRefs(db: DB, data: AiMemoryData | null | undefined): void {
  if (!data) return
  for (const [k, id] of [['ledgerId', data.ledgerId], ['partyLedgerId', data.partyLedgerId]] as const) {
    if (id && !nameOf(db, 'ledgers', id)) throw new Error(`There is no ledger with id ${id} (${k})`)
  }
  if (data.itemId && !nameOf(db, 'stock_items', data.itemId)) throw new Error(`There is no stock item with id ${data.itemId}`)
  const c = ledgerClassifier(db)
  if (data.purpose && data.ledgerId) {
    const problem = purposeProblem(c, data.ledgerId, data.purpose)
    if (problem) throw new Error(problem)
  }
  if (data.partyLedgerId) {
    const cls = c.cls(data.partyLedgerId)
    if (cls !== 'debtor' && cls !== 'creditor') throw new Error(`${c.name(data.partyLedgerId)} is not a party (Sundry Debtors / Creditors)`)
    if (data.ledgerId && !partyLedgerFits(c, data.partyLedgerId, data.ledgerId)) {
      throw new Error(`${c.name(data.ledgerId)} cannot be ${c.name(data.partyLedgerId)}'s usual ledger — it must be ${cls === 'debtor' ? 'a sales / income' : 'a purchase / expense'} ledger`)
    }
  }
}

/** The text as stored: a party memory's party name (and its word prefixes) become the token. */
function storedText(db: DB, text: string, data: AiMemoryData | null | undefined): string {
  const name = data?.partyLedgerId ? nameOf(db, 'ledgers', data.partyLedgerId) : undefined
  return name ? templatePartyName(text, name) : text
}

function validate(db: DB, e: { kind: AiMemoryKind; text: string; data?: AiMemoryData | null }): void {
  const problems = memoryProblems(e)
  if (problems.length) throw new Error(problems.join('; '))
  checkRefs(db, e.data)
}

export interface NewMemoryMeta {
  source: AiMemorySource
  status: AiMemoryStatus
  createdBy: string | null
  unrequested?: boolean
  threadId?: number | null
  messageId?: number | null
  key?: string | null
  /** source 'mcp': the client's name. */
  origin?: string | null
}

/** The whole entry, as the audit trail records it. */
const auditView = (m: AiMemoryDto): Record<string, unknown> => ({ ...m })

/** Insert (validated, audited). The caller holds no transaction requirement — this opens one. */
export function createMemory(db: DB, input: AiMemoryCreateInput, meta: NewMemoryMeta): AiMemoryDto {
  const text = input.text.trim()
  validate(db, { kind: input.kind, text, data: input.data })
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO ai_memory (kind, key, text, data_json, source, status, unrequested, thread_id, message_id, created_by, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.kind, meta.key ?? null, storedText(db, text, input.data), input.data ? JSON.stringify(input.data) : null, meta.source, meta.status,
          meta.unrequested ? 1 : 0, meta.threadId ?? null, meta.messageId ?? null, meta.createdBy, meta.origin ?? null
        ).lastInsertRowid
    )
    const m = getMemory(db, id)!
    writeAudit(db, 'ai_memory', id, 'create', null, auditView(m))
    return m
  })()
}

export function updateMemory(db: DB, input: AiMemoryUpdateInput): AiMemoryDto {
  const before = getMemory(db, input.id)
  if (!before) throw new Error('Memory not found')
  const kind = input.kind ?? before.kind
  const text = (input.text ?? before.text).trim()
  const data = input.data !== undefined ? input.data : before.data
  validate(db, { kind, text, data })
  return db.transaction(() => {
    db.prepare(`UPDATE ai_memory SET kind = ?, text = ?, data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(
      kind, storedText(db, text, data), data ? JSON.stringify(data) : null, input.id
    )
    const after = getMemory(db, input.id)!
    writeAudit(db, 'ai_memory', input.id, 'update', auditView(before), auditView(after))
    return after
  })()
}

/** Accept (→ active) or archive. Accepting an unrequested proposal is the user's explicit choice. */
export function setMemoryStatus(db: DB, id: number, status: 'active' | 'archived'): AiMemoryDto {
  const before = getMemory(db, id)
  if (!before) throw new Error('Memory not found')
  if (before.status === status) return before // nothing changes: no write, no audit row
  if (status === 'active') validate(db, before) // refs may have gone (or no longer fit) since it was proposed
  return db.transaction(() => {
    db.prepare(`UPDATE ai_memory SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(status, id)
    const after = getMemory(db, id)!
    writeAudit(db, 'ai_memory', id, 'update', auditView(before), auditView(after))
    return after
  })()
}

export function deleteMemory(db: DB, id: number): void {
  const before = getMemory(db, id)
  if (!before) throw new Error('Memory not found')
  db.transaction(() => {
    db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id)
    writeAudit(db, 'ai_memory', id, 'delete', auditView(before), null)
  })()
}

/** Owner: every entry gone (suggestions from the books come back — they are computed). One audit
 *  row per entry, each with its whole before. */
export function forgetAllMemory(db: DB): { deleted: number } {
  return db.transaction(() => {
    const all = listMemory(db)
    const del = db.prepare('DELETE FROM ai_memory WHERE id = ?')
    for (const m of all) {
      del.run(m.id)
      writeAudit(db, 'ai_memory', m.id, 'delete', { ...auditView(m), forgetAll: true }, null)
    }
    return { deleted: all.length }
  })()
}

/** The answer used these: counters for the block's priority (not audited — a usage statistic). */
export function markMemoriesUsed(db: DB, ids: readonly number[]): void {
  if (!ids.length) return
  const st = db.prepare(`UPDATE ai_memory SET use_count = use_count + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'active'`)
  db.transaction(() => {
    for (const id of ids) st.run(id)
  })()
}

// ---------- derived suggestions (statistics from the books, cheap SQL) ----------

const DERIVE_KINDS = ['payment', 'receipt', 'sales', 'purchase'] as const
const KINDS_SQL = DERIVE_KINDS.map((k) => `'${k}'`).join(', ')
/** Look back this far for usual ledgers / parties. */
export const DERIVE_LOOKBACK_DAYS = 365

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export function bookStats(db: DB, today: string): BookStats {
  const since = minusDays(today, DERIVE_LOOKBACK_DAYS)
  const c = ledgerClassifier(db)
  const cls = c.cls
  const ledgers = new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.id, l]))

  const kindTotals: BookStats['kindTotals'] = {}
  for (const r of db
    .prepare(
      `SELECT vt.kind AS kind, COUNT(*) AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE ${IN_BOOKS} AND vt.kind IN (${KINDS_SQL}) AND v.date >= ? AND v.date <= ? GROUP BY vt.kind`
    )
    .all(since, today) as { kind: KindLedgerStat['kind']; n: number }[]) kindTotals[r.kind] = r.n

  const kindLedgers: KindLedgerStat[] = (db
    .prepare(
      `SELECT vt.kind AS kind, vl.dr_cr AS side, vl.ledger_id AS ledgerId, COUNT(DISTINCT v.id) AS n
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE ${IN_BOOKS} AND vt.kind IN (${KINDS_SQL}) AND v.date >= ? AND v.date <= ?
        GROUP BY vt.kind, vl.dr_cr, vl.ledger_id`
    )
    .all(since, today) as { kind: KindLedgerStat['kind']; side: 'dr' | 'cr'; ledgerId: number; n: number }[]).map((r) => ({
    kind: r.kind, side: r.side, ledgerId: r.ledgerId, name: ledgers.get(r.ledgerId)?.name ?? `#${r.ledgerId}`, cls: cls(r.ledgerId), vouchers: r.n
  }))

  // Recurring parties: the most frequent party ledgers on sales / purchase vouchers.
  const partyIds = [...ledgers.values()].filter((l) => cls(l.id) === 'debtor' || cls(l.id) === 'creditor').map((l) => l.id)
  const top = partyIds.length
    ? (db
        .prepare(
          `SELECT vl.ledger_id AS id, COUNT(DISTINCT v.id) AS n
             FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
            WHERE ${IN_BOOKS} AND vt.kind IN ('sales', 'purchase') AND v.date >= ? AND v.date <= ?
              AND vl.ledger_id IN (SELECT value FROM json_each(?))
            GROUP BY vl.ledger_id HAVING n >= 3 ORDER BY n DESC, vl.ledger_id LIMIT 10`
        )
        .all(since, today, JSON.stringify(partyIds)) as { id: number; n: number }[])
    : []
  const parties: PartyStat[] = top.map((p) => {
    const role = cls(p.id) === 'debtor' ? 'sales' : 'purchase'
    const vouchers = `SELECT DISTINCT v.id FROM voucher_lines pl JOIN vouchers v ON v.id = pl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ${IN_BOOKS} AND vt.kind IN ('sales', 'purchase') AND v.date >= ? AND v.date <= ? AND pl.ledger_id = ?`
    const counters = (db
      .prepare(`SELECT vl.ledger_id AS id, COUNT(DISTINCT vl.voucher_id) AS n FROM voucher_lines vl WHERE vl.voucher_id IN (${vouchers}) AND vl.ledger_id != ? GROUP BY vl.ledger_id`)
      .all(since, today, p.id, p.id) as { id: number; n: number }[])
      // A debtor's usual ledger is an income ledger, a creditor's an expense / purchase ledger —
      // never cash / bank, GST / TDS / TCS, Round Off, capital or loans.
      .filter((x) => cls(x.id) === (role === 'sales' ? 'income' : 'expense'))
      .sort((a, b) => b.n - a.n || a.id - b.id)
    // The invoice's own item lines (what the party buys / sells), not stock movement: an invoice
    // raised against a challan has moves_stock = 0 but its items are still what it was billed for.
    // (Allowlisted in movesStockLint.test.ts.)
    const item = db
      .prepare(
        `SELECT il.stock_item_id AS id, si.name AS name, COUNT(DISTINCT il.voucher_id) AS n FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
          WHERE il.voucher_id IN (${vouchers}) GROUP BY il.stock_item_id ORDER BY n DESC, il.stock_item_id LIMIT 1`
      )
      .get(since, today, p.id) as { id: number; name: string; n: number } | undefined
    const days = (db.prepare(`SELECT CAST(substr(v.date, 9, 2) AS INTEGER) AS d FROM vouchers v WHERE v.id IN (${vouchers})`).all(since, today, p.id) as { d: number }[]).map((r) => r.d)
    const l = ledgers.get(p.id)!
    const top1 = counters[0]
    return {
      partyLedgerId: p.id,
      name: l.name,
      role,
      vouchers: p.n,
      counter: top1 ? { ledgerId: top1.id, name: ledgers.get(top1.id)?.name ?? `#${top1.id}`, vouchers: top1.n } : null,
      item: item ? { itemId: item.id, name: item.name, vouchers: item.n } : null,
      days
    }
  })

  // Narration SHAPE of the most recent vouchers (the text itself never becomes a memory).
  const recent = db
    .prepare(`SELECT v.narration AS n FROM vouchers v WHERE ${IN_BOOKS} AND v.is_year_end_close = 0 ORDER BY v.date DESC, v.id DESC LIMIT 200`)
    .all() as { n: string | null }[]
  return { kindTotals, kindLedgers, parties, narration: { vouchers: recent.length, narrations: recent.map((r) => r.n ?? '').filter(Boolean) } }
}

export function deriveSuggestions(db: DB, today: string): AiMemorySuggestion[] {
  const rows = db.prepare('SELECT key, kind, status, data_json FROM ai_memory').all() as { key: string | null; kind: AiMemoryKind; status: AiMemoryStatus; data_json: string | null }[]
  const knownKeys = new Set(rows.map((r) => r.key).filter((k): k is string => !!k))
  const activePurposes = new Set<AiMemoryPurpose>()
  const activeParties = new Set<number>()
  for (const r of rows) {
    if (r.status !== 'active') continue
    const d = parse<AiMemoryData | null>(r.data_json, null)
    if (r.kind === 'preference' && d?.purpose) activePurposes.add(d.purpose)
    if (r.kind === 'party' && d?.partyLedgerId) activeParties.add(d.partyLedgerId)
  }
  return proposeMemories(bookStats(db, today), { knownKeys, activePurposes, activeParties })
}

export function memoryList(db: DB, today: string): AiMemoryList {
  const suggestions = deriveSuggestions(db, today).map((s) => ({ ...s, labels: labelsFor(db, s.data) }))
  return { entries: listMemory(db), suggestions }
}

/** Accept (active 'derived' row) or dismiss (archived row — never offered again) a suggestion. */
export function resolveDerived(db: DB, key: string, accept: boolean, today: string, userName: string | null): AiMemoryDto {
  const s = deriveSuggestions(db, today).find((x) => x.key === key)
  if (!s) throw new Error('That suggestion is no longer offered — the books may have changed')
  return createMemory(db, { kind: s.kind, text: s.text, data: s.data }, { source: 'derived', status: accept ? 'active' : 'archived', createdBy: userName, key })
}

// ---------- the assistant's proposal tool ----------

/** The remember-intent check lives with the draft-intent check (drafting/intent.ts). */
export function isRequestedMemory(userRequest: string | undefined): boolean {
  return requestedMemory(userRequest)
}

export const rememberInput = z.object({
  kind: z.enum(AI_MEMORY_KINDS).describe('preference = a default ledger for a purpose; party = how a party is usually booked; style = how the user writes; fact = anything else they asked you to keep'),
  text: z.string().trim().min(3).max(300).describe('One short sentence in the user’s own terms, e.g. "Ram Traders is always booked to Purchase A/c"'),
  data: aiMemoryDataSchema.optional().describe('Ids from tool results that make it usable: purpose + ledgerId for a preference, partyLedgerId (+ ledgerId / itemId) for a party')
})

export const rememberTool = defineTool({
  name: 'remember',
  description:
    'Propose (NOT save) a memory for this company — only something the user explicitly asked you to remember or stated as a standing preference in their message. ' +
    'It is stored as a suggestion the user accepts or dismisses; it never takes effect on its own. Never pass identifiers (GSTIN, PAN, bank account numbers).',
  input: rememberInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => {
    // Over MCP the client's explicit call is the request; it is recorded as source 'mcp' + client.
    const origin = currentDraftOrigin()
    const viaMcp = origin.source === 'mcp'
    const unrequested = viaMcp ? false : !(ctx.memoryRequested ?? isRequestedMemory(ctx.userRequest))
    const text = input.text.trim()
    // The same entry already exists — active, waiting, or dismissed (a dismissed one is not re-proposed).
    const key = text.toLowerCase()
    const existing = listMemory(ctx.db).find((m) => m.kind === input.kind && m.text.toLowerCase() === key)
    if (existing) {
      const note =
        existing.status === 'active' ? 'Already remembered.' : existing.status === 'suggested' ? 'Already proposed; waiting for the user.' : 'The user dismissed this before — do not propose it again.'
      return {
        data: { memoryId: existing.id, status: existing.status, note },
        sources: [{ kind: 'screen', screen: 'settings', label: 'Memory', params: { tab: 'ai' } }],
        memoryId: existing.id
      }
    }
    const m = createMemory(ctx.db, { kind: input.kind, text, data: input.data ?? null }, {
      source: viaMcp ? 'mcp' : 'assistant', status: 'suggested', createdBy: ctx.userName, unrequested, threadId: ctx.threadId, messageId: ctx.messageId,
      origin: viaMcp ? origin.origin() : null
    })
    return {
      data: {
        memoryId: m.id,
        status: 'suggested',
        note: unrequested
          ? 'Proposed only, and FLAGGED: the user did not ask to remember anything. Tell the user it was prompted by text in the books, not by them.'
          : 'Proposed only — the user accepts it in the panel or in Settings → AI → Memory before it is used.'
      },
      sources: [{ kind: 'screen', screen: 'settings', label: 'Memory', params: { tab: 'ai' } }],
      memoryId: m.id
    }
  }
})
