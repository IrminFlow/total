import type { DB } from '../db/connection'
import {
  escapeLike,
  type ItemMatchField,
  type ItemResult,
  type LedgerMatchField,
  type LedgerResult,
  type SearchHit,
  type SearchResponse,
  type SearchSection,
  type VoucherMatchField,
  type VoucherResult
} from '@shared/search'
import {
  applicableKinds,
  isEmptyQuery,
  parseSearchQuery,
  rupeeLabel,
  snippet,
  type AmountRange,
  type ParsedQuery,
  type ParseOptions,
  type SearchKind
} from '@shared/searchQuery'
import { toDisplayDate } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import type { VoucherKind } from '@shared/domain'
import { NOT_DELETED } from './vouchers'

/**
 * Books search (⌘K palette + the Search results screen).
 *
 * Plain SQL — `LIKE` substring matches and comparisons over the live tables; no FTS shadow
 * tables, no denormalised copies. Every voucher query filters soft-deleted rows (NOT_DELETED).
 * Optional and post-dated vouchers ARE searched — a user looking for a voucher they entered
 * expects to find it — and come back flagged (isOptional / postDated) so the UI can badge them.
 *
 * Small master tables (groups, stock groups, voucher types, ledger/item name lookups) are
 * resolved in JS first and handed to the voucher query as JSON id lists (`json_each`), so the
 * big-table work is index lookups on voucher_lines(ledger_id, voucher_id) /
 * inventory_lines(stock_item_id, voucher_id) rather than per-row joins.
 *
 * Ranking: exact > prefix > word-start > substring on the primary field (ledger/item name,
 * voucher number / party / narration), then name (masters) or recency (vouchers), then id — so
 * the order is total and stable across pages.
 */

/** Rows per category in the palette. */
export const SEARCH_LIMIT = 20
export const SEARCH_MAX_LIMIT = 200

export interface SearchOptions extends ParseOptions {
  limitPerKind?: number
  offset?: number
  /** Restrict the response to one kind (load-more on the results screen); others come back null. */
  kind?: SearchKind
}

const ESC = `ESCAPE '\\'`
/** Characters that start a "word" for word-start ranking ("Acme (Pune)", "INV-12", "A/B"). */
const WORD_SEPS = [' ', '(', '-', '/']

const contains = (t: string): string => `%${escapeLike(t)}%`
const startsWith = (t: string): string => `${escapeLike(t)}%`
const json = (ids: (number | string)[]): string => JSON.stringify(ids)
const IN_JSON = 'IN (SELECT value FROM json_each(?))'

/** WHERE fragments + their positional params, kept in lockstep. */
class Where {
  parts: string[] = []
  params: unknown[] = []
  add(sql: string, ...params: unknown[]): void {
    this.parts.push(sql)
    this.params.push(...params)
  }
  sql(): string {
    return this.parts.length ? this.parts.join(' AND ') : '1'
  }
}

/** `(c1 OR c2 …)` builder. */
class AnyOf {
  parts: string[] = []
  params: unknown[] = []
  add(sql: string, ...params: unknown[]): void {
    this.parts.push(sql)
    this.params.push(...params)
  }
  sql(): string {
    return this.parts.length ? `(${this.parts.join(' OR ')})` : '0'
  }
}

/** Rank tiers 0 (exact) … 3 (substring) for `col` against the phrase / first term. */
function tierSql(
  exact: { cols: string[]; value: string },
  prefix: { cols: string[]; value: string },
  word: { cols: string[]; value: string }
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const exactSql = exact.cols.map((c) => `${c} = ? COLLATE NOCASE`).join(' OR ')
  exact.cols.forEach(() => params.push(exact.value))
  const prefixSql = prefix.cols.map((c) => `${c} LIKE ? ${ESC}`).join(' OR ')
  prefix.cols.forEach(() => params.push(startsWith(prefix.value)))
  const wordParts: string[] = []
  for (const c of word.cols) {
    for (const sep of WORD_SEPS) {
      wordParts.push(`${c} LIKE ? ${ESC}`)
      params.push(`%${sep}${escapeLike(word.value)}%`)
    }
  }
  return {
    sql: `CASE WHEN ${exactSql} THEN 0 WHEN ${prefixSql} THEN 1 WHEN ${wordParts.join(' OR ')} THEN 2 ELSE 3 END`,
    params
  }
}

/** Ids of rows in a parent-linked tree (groups / stock_groups) whose own name or any ancestor's
 *  name contains a needle — "sundry" finds Sundry Debtors and every sub-group under it. */
function treeMatcher(db: DB, table: 'groups' | 'stock_groups'): (needle: string) => { ids: number[]; nameOf: Map<number, string> } {
  const rows = db.prepare(`SELECT id, name, parent_id AS parentId FROM ${table}`).all() as { id: number; name: string; parentId: number | null }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  // Lineage per node, self first; cycle-safe.
  const lineage = new Map<number, { id: number; name: string }[]>()
  for (const r of rows) {
    const chain: { id: number; name: string }[] = []
    const seen = new Set<number>()
    let cur: typeof r | undefined = r
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.push({ id: cur.id, name: cur.name })
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined
    }
    lineage.set(r.id, chain)
  }
  const cache = new Map<string, { ids: number[]; nameOf: Map<number, string> }>()
  return (needle) => {
    const n = needle.toLowerCase()
    const hit = cache.get(n)
    if (hit) return hit
    const ids: number[] = []
    const nameOf = new Map<number, string>()
    for (const [id, chain] of lineage) {
      const m = chain.find((g) => g.name.toLowerCase().includes(n))
      if (m) {
        ids.push(id)
        nameOf.set(id, m.name)
      }
    }
    const out = { ids, nameOf }
    cache.set(n, out)
    return out
  }
}

/** GST state codes whose state name contains the needle (≥3 chars, to keep "a" from matching all). */
function stateCodesMatching(needle: string): string[] {
  if (needle.length < 3) return []
  const n = needle.toLowerCase()
  return Object.entries(GST_STATES).filter(([, name]) => name.toLowerCase().includes(n)).map(([code]) => code)
}

const clampLimit = (n: number | undefined): number => Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(n ?? SEARCH_LIMIT)))
const clampOffset = (n: number | undefined): number => Math.max(0, Math.floor(n ?? 0))

/** The phrase (all terms joined) and the first term — what ranking compares against. */
function rankTexts(q: ParsedQuery): { phrase: string; first: string } | null {
  if (q.terms.length === 0) return null
  return { phrase: q.terms.map((t) => t.text).join(' '), first: q.terms[0]!.text }
}

// ---------------------------------------------------------------- ledgers

interface LedgerRow {
  id: number; name: string; groupId: number; groupName: string; gstin: string | null; pan: string | null
  address: string | null; stateCode: string | null; hsn: string | null
}

function searchLedgers(db: DB, q: ParsedQuery, limit: number, offset: number, groupsOf: ReturnType<typeof treeMatcher>): SearchSection<LedgerResult> {
  const w = new Where()
  for (const t of q.terms) {
    const any = new AnyOf()
    const like = contains(t.text)
    any.add(`l.name LIKE ? ${ESC}`, like)
    any.add(`l.gstin LIKE ? ${ESC}`, like)
    any.add(`l.pan LIKE ? ${ESC}`, like)
    any.add(`l.address LIKE ? ${ESC}`, like)
    const g = groupsOf(t.text).ids
    if (g.length) any.add(`l.group_id ${IN_JSON}`, json(g))
    const states = stateCodesMatching(t.text)
    if (states.length) any.add(`l.state_code ${IN_JSON}`, json(states))
    w.add(any.sql(), ...any.params)
  }
  for (const v of q.gstins) w.add(`l.gstin LIKE ? ${ESC}`, contains(v))
  for (const v of q.pans) w.add(`l.pan LIKE ? ${ESC}`, contains(v))
  for (const v of q.hsns) w.add(`l.hsn LIKE ? ${ESC}`, startsWith(v))
  for (const v of q.groups) w.add(`l.group_id ${IN_JSON}`, json(groupsOf(v).ids))

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ledgers l WHERE ${w.sql()}`).get(...w.params) as { n: number }).n
  if (total === 0 || offset >= total) return { rows: [], total, offset }

  const rt = rankTexts(q)
  const rank = rt
    ? tierSql(
        { cols: ['l.name', 'l.gstin', 'l.pan'], value: rt.phrase },
        { cols: ['l.name'], value: rt.first },
        { cols: ['l.name'], value: rt.first }
      )
    : { sql: 'NULL', params: [] }
  const rows = db
    .prepare(
      `SELECT l.id, l.name, l.group_id AS groupId, g.name AS groupName, l.gstin, l.pan, l.address,
              l.state_code AS stateCode, l.hsn
       FROM ledgers l JOIN groups g ON g.id = l.group_id
       WHERE ${w.sql()}
       ORDER BY ${rank.sql}, l.name COLLATE NOCASE, l.id
       LIMIT ? OFFSET ?`
    )
    .all(...w.params, ...rank.params, limit, offset) as LedgerRow[]

  return {
    total,
    offset,
    rows: rows.map((r) => {
      const m = ledgerMatch(r, q, groupsOf)
      return { kind: 'ledger', id: r.id, name: r.name, groupName: r.groupName, gstin: r.gstin, pan: r.pan, matchField: m?.[0] ?? null, matchText: m?.[1] ?? null }
    })
  }
}

function ledgerMatch(r: LedgerRow, q: ParsedQuery, groupsOf: ReturnType<typeof treeMatcher>): [LedgerMatchField, string] | null {
  const t = q.terms[0]?.text
  const has = (s: string | null, n: string): boolean => !!s && s.toLowerCase().includes(n.toLowerCase())
  if (t) {
    if (has(r.name, t)) return ['name', r.name]
    if (has(r.gstin, t)) return ['gstin', r.gstin!]
    if (has(r.pan, t)) return ['pan', r.pan!]
    const g = groupsOf(t).nameOf.get(r.groupId)
    if (g) return ['group', g]
    if (has(r.address, t)) return ['address', snippet(r.address!, t, 60)]
    if (r.stateCode && stateCodesMatching(t).includes(r.stateCode)) return ['state', GST_STATES[r.stateCode]!]
  }
  if (q.gstins.length && r.gstin) return ['gstin', r.gstin]
  if (q.pans.length && r.pan) return ['pan', r.pan]
  if (q.hsns.length && r.hsn) return ['hsn', r.hsn]
  if (q.groups.length) {
    const g = groupsOf(q.groups[0]!).nameOf.get(r.groupId)
    if (g) return ['group', g]
  }
  return null
}

// ---------------------------------------------------------------- stock items

interface ItemRow { id: number; name: string; hsn: string | null; barcode: string | null; groupId: number | null; groupName: string | null }

function searchItems(db: DB, q: ParsedQuery, limit: number, offset: number, stockGroupsOf: ReturnType<typeof treeMatcher>): SearchSection<ItemResult> {
  const w = new Where()
  for (const t of q.terms) {
    const any = new AnyOf()
    const like = contains(t.text)
    any.add(`s.name LIKE ? ${ESC}`, like)
    any.add(`s.hsn LIKE ? ${ESC}`, like)
    any.add(`s.barcode LIKE ? ${ESC}`, like)
    const g = stockGroupsOf(t.text).ids
    if (g.length) any.add(`s.group_id ${IN_JSON}`, json(g))
    w.add(any.sql(), ...any.params)
  }
  for (const v of q.hsns) w.add(`s.hsn LIKE ? ${ESC}`, startsWith(v))
  for (const v of q.groups) w.add(`s.group_id ${IN_JSON}`, json(stockGroupsOf(v).ids))

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM stock_items s WHERE ${w.sql()}`).get(...w.params) as { n: number }).n
  if (total === 0 || offset >= total) return { rows: [], total, offset }

  const rt = rankTexts(q)
  const rank = rt
    ? tierSql(
        { cols: ['s.name', 's.barcode', 's.hsn'], value: rt.phrase },
        { cols: ['s.name'], value: rt.first },
        { cols: ['s.name'], value: rt.first }
      )
    : { sql: 'NULL', params: [] }
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.hsn, s.barcode, s.group_id AS groupId, sg.name AS groupName
       FROM stock_items s LEFT JOIN stock_groups sg ON sg.id = s.group_id
       WHERE ${w.sql()}
       ORDER BY ${rank.sql}, s.name COLLATE NOCASE, s.id
       LIMIT ? OFFSET ?`
    )
    .all(...w.params, ...rank.params, limit, offset) as ItemRow[]

  return {
    total,
    offset,
    rows: rows.map((r) => {
      const m = itemMatch(r, q, stockGroupsOf)
      return { kind: 'item', id: r.id, name: r.name, hsn: r.hsn, barcode: r.barcode, groupName: r.groupName, matchField: m?.[0] ?? null, matchText: m?.[1] ?? null }
    })
  }
}

function itemMatch(r: ItemRow, q: ParsedQuery, stockGroupsOf: ReturnType<typeof treeMatcher>): [ItemMatchField, string] | null {
  const t = q.terms[0]?.text
  const has = (s: string | null, n: string): boolean => !!s && s.toLowerCase().includes(n)
  if (t) {
    if (has(r.name, t)) return ['name', r.name]
    if (has(r.hsn, t)) return ['hsn', r.hsn!]
    if (has(r.barcode, t)) return ['barcode', r.barcode!]
    const g = r.groupId != null ? stockGroupsOf(t).nameOf.get(r.groupId) : undefined
    if (g) return ['group', g]
  }
  if (q.hsns.length && r.hsn) return ['hsn', r.hsn]
  if (q.groups.length && r.groupId != null) {
    const g = stockGroupsOf(q.groups[0]!).nameOf.get(r.groupId)
    if (g) return ['group', g]
  }
  return null
}

// ---------------------------------------------------------------- vouchers

const BIG = Number.MAX_SAFE_INTEGER

/** Voucher total (Σ debit lines) OR any single line amount within [min, max]. */
function amountClause(a: AmountRange): { sql: string; params: unknown[] } {
  const min = a.min ?? 0
  const max = a.max ?? BIG
  return {
    sql: `(v.id IN (SELECT voucher_id FROM voucher_lines WHERE amount BETWEEN ? AND ?)
           OR v.id IN (SELECT voucher_id FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id HAVING SUM(amount) BETWEEN ? AND ?))`,
    params: [min, max, min, max]
  }
}

/** The voucher's party is one of `ids`, or any of its lines posts to one of them. */
function partyOrLine(ids: number[]): { sql: string; params: unknown[] } {
  if (ids.length === 0) return { sql: '0', params: [] }
  const j = json(ids)
  return {
    sql: `(v.party_ledger_id ${IN_JSON} OR v.id IN (SELECT voucher_id FROM voucher_lines WHERE ledger_id ${IN_JSON}))`,
    params: [j, j]
  }
}

function itemLine(ids: number[]): { sql: string; params: unknown[] } {
  if (ids.length === 0) return { sql: '0', params: [] }
  return { sql: `v.id IN (SELECT voucher_id FROM inventory_lines WHERE stock_item_id ${IN_JSON})`, params: [json(ids)] }
}

interface VoucherDetailRow {
  id: number; date: string; number: string; narration: string | null; reference: string | null
  isOptional: number; postDated: number; typeName: string; voucherKind: VoucherKind
  partyLedgerId: number | null; partyName: string | null; partyGstin: string | null; partyPan: string | null
}

interface VoucherLineRow { voucherId: number; ledgerId: number; amount: number; drCr: 'dr' | 'cr'; name: string; gstin: string | null; pan: string | null; groupId: number; hsn: string | null }

function searchVouchers(db: DB, q: ParsedQuery, limit: number, offset: number, groupsOf: ReturnType<typeof treeMatcher>): SearchSection<VoucherResult> {
  const ledgerIdsWhere = (sql: string, param: string): number[] =>
    (db.prepare(`SELECT id FROM ledgers WHERE ${sql}`).all(param) as { id: number }[]).map((r) => r.id)
  const itemIdsWhere = (sql: string, param: string): number[] =>
    (db.prepare(`SELECT id FROM stock_items WHERE ${sql}`).all(param) as { id: number }[]).map((r) => r.id)

  const w = new Where()
  w.add(NOT_DELETED)
  const termLedgers = new Map<string, Set<number>>()
  for (const t of q.terms) {
    const any = new AnyOf()
    const like = contains(t.text)
    any.add(`v.number LIKE ? ${ESC}`, like)
    any.add(`v.narration LIKE ? ${ESC}`, like)
    any.add(`v.reference LIKE ? ${ESC}`, like)
    const lids = ledgerIdsWhere(`name LIKE ? ${ESC}`, like)
    termLedgers.set(t.text, new Set(lids))
    if (lids.length) {
      const c = partyOrLine(lids)
      any.add(c.sql, ...c.params)
    }
    const iids = itemIdsWhere(`name LIKE ? ${ESC}`, like)
    if (iids.length) {
      const c = itemLine(iids)
      any.add(c.sql, ...c.params)
    }
    if (t.amount != null) {
      const c = amountClause({ min: t.amount, max: t.amount })
      any.add(c.sql, ...c.params)
    }
    w.add(any.sql(), ...any.params)
  }
  for (const a of q.amounts) {
    const c = amountClause(a)
    w.add(c.sql, ...c.params)
  }
  for (const d of q.dates) {
    if (d.from) w.add('v.date >= ?', d.from)
    if (d.to) w.add('v.date <= ?', d.to)
  }
  if (q.types.length) {
    const vts = db.prepare('SELECT id, name, kind FROM voucher_types').all() as { id: number; name: string; kind: VoucherKind }[]
    const ids = vts
      .filter((vt) => q.typeKinds.includes(vt.kind) || q.types.some((t) => vt.name.toLowerCase().startsWith(t)))
      .map((vt) => vt.id)
    w.add(`v.voucher_type_id ${IN_JSON}`, json(ids))
  }
  for (const n of q.numbers) w.add(`v.number LIKE ? ${ESC}`, contains(n))
  for (const g of q.gstins) {
    const c = partyOrLine(ledgerIdsWhere(`gstin LIKE ? ${ESC}`, contains(g)))
    w.add(c.sql, ...c.params)
  }
  for (const pn of q.pans) {
    const c = partyOrLine(ledgerIdsWhere(`pan LIKE ? ${ESC}`, contains(pn)))
    w.add(c.sql, ...c.params)
  }
  for (const pt of q.parties) {
    const c = partyOrLine(ledgerIdsWhere(`name LIKE ? ${ESC}`, contains(pt)))
    w.add(c.sql, ...c.params)
  }
  for (const h of q.hsns) {
    const items = itemLine(itemIdsWhere(`hsn LIKE ? ${ESC}`, startsWith(h)))
    const ledgers = partyOrLine(ledgerIdsWhere(`hsn LIKE ? ${ESC}`, startsWith(h)))
    w.add(`(${items.sql} OR ${ledgers.sql})`, ...items.params, ...ledgers.params)
  }
  for (const g of q.groups) {
    const ids = groupsOf(g).ids
    const lids = ids.length
      ? (db.prepare(`SELECT id FROM ledgers WHERE group_id ${IN_JSON}`).all(json(ids)) as { id: number }[]).map((r) => r.id)
      : []
    const c = partyOrLine(lids)
    w.add(c.sql, ...c.params)
  }

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${w.sql()}`).get(...w.params) as { n: number }).n
  if (total === 0 || offset >= total) return { rows: [], total, offset }

  // Phase 1 — the page of ids, ranked. Display columns (totals, first ledger) are computed only
  // for these rows in phase 2, never for every match.
  const rt = rankTexts(q)
  let rank: { sql: string; params: unknown[] } = { sql: 'NULL', params: [] }
  if (rt) {
    const tiers = tierSql(
      { cols: ['v.number'], value: rt.phrase },
      { cols: ['v.number', 'pl.name'], value: rt.first },
      { cols: ['v.number', 'pl.name', 'v.narration'], value: rt.first }
    )
    const firstAmount = q.terms[0]!.amount
    if (firstAmount != null) {
      // A bare number that equals the voucher's amount ranks with exact number matches.
      const c = amountClause({ min: firstAmount, max: firstAmount })
      rank = { sql: `CASE WHEN ${c.sql} THEN 0 ELSE ${tiers.sql} END`, params: [...c.params, ...tiers.params] }
    } else {
      rank = tiers
    }
  }
  const ids = (
    db
      .prepare(
        `SELECT v.id FROM vouchers v LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
         WHERE ${w.sql()}
         ORDER BY ${rank.sql}, v.date DESC, v.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...w.params, ...rank.params, limit, offset) as { id: number }[]
  ).map((r) => r.id)

  // Phase 2 — details for the page.
  const pageJson = json(ids)
  const details = new Map(
    (
      db
        .prepare(
          `SELECT v.id, v.date, v.number, v.narration, v.reference, v.is_optional AS isOptional, v.post_dated AS postDated,
                  vt.name AS typeName, vt.kind AS voucherKind, pl.id AS partyLedgerId, pl.name AS partyName, pl.gstin AS partyGstin, pl.pan AS partyPan
           FROM vouchers v
           JOIN voucher_types vt ON vt.id = v.voucher_type_id
           LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
           WHERE v.id ${IN_JSON}`
        )
        .all(pageJson) as VoucherDetailRow[]
    ).map((r) => [r.id, r])
  )
  const linesBy = new Map<number, VoucherLineRow[]>()
  for (const l of db
    .prepare(
      `SELECT vl.voucher_id AS voucherId, vl.ledger_id AS ledgerId, vl.amount, vl.dr_cr AS drCr, l.name, l.gstin, l.pan, l.group_id AS groupId, l.hsn
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id ${IN_JSON}
       ORDER BY vl.voucher_id, vl.line_order, vl.id`
    )
    .all(pageJson) as VoucherLineRow[]) {
    const arr = linesBy.get(l.voucherId) ?? []
    arr.push(l)
    linesBy.set(l.voucherId, arr)
  }
  const itemsBy = new Map<number, { name: string; hsn: string | null }[]>()
  const needItems = q.terms.length > 0 || q.hsns.length > 0
  if (needItems) {
    for (const r of db
      .prepare(
        `SELECT il.voucher_id AS voucherId, s.name, s.hsn FROM inventory_lines il JOIN stock_items s ON s.id = il.stock_item_id
         WHERE il.voucher_id ${IN_JSON} ORDER BY il.voucher_id, il.line_order, il.id`
      )
      .all(pageJson) as { voucherId: number; name: string; hsn: string | null }[]) {
      const arr = itemsBy.get(r.voucherId) ?? []
      arr.push({ name: r.name, hsn: r.hsn })
      itemsBy.set(r.voucherId, arr)
    }
  }

  const rows: VoucherResult[] = []
  for (const id of ids) {
    const d = details.get(id)
    if (!d) continue
    const lines = linesBy.get(id) ?? []
    const total = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const m = voucherMatch(d, lines, itemsBy.get(id) ?? [], total, q, groupsOf)
    const firstTerm = q.terms[0]?.text ?? null
    rows.push({
      kind: 'voucher',
      id,
      typeName: d.typeName,
      voucherKind: d.voucherKind,
      number: d.number,
      date: d.date,
      party: d.partyName ?? lines[0]?.name ?? null,
      partyLedgerId: d.partyName != null ? d.partyLedgerId : (lines[0]?.ledgerId ?? null),
      amount: total,
      narration: d.narration ? snippet(d.narration, m?.[0] === 'narration' ? firstTerm : null, 90) : null,
      isOptional: d.isOptional === 1,
      postDated: d.postDated === 1,
      matchField: m?.[0] ?? null,
      matchText: m?.[1] ?? null
    })
  }
  return { rows, total, offset }
}

function inRange(n: number, a: AmountRange): boolean {
  return (a.min == null || n >= a.min) && (a.max == null || n <= a.max)
}

function voucherMatch(
  d: VoucherDetailRow,
  lines: VoucherLineRow[],
  items: { name: string; hsn: string | null }[],
  total: number,
  q: ParsedQuery,
  groupsOf: ReturnType<typeof treeMatcher>
): [VoucherMatchField, string] | null {
  const has = (s: string | null, n: string): boolean => !!s && s.toLowerCase().includes(n)
  const amountHit = (a: AmountRange): [VoucherMatchField, string] | null => {
    if (inRange(total, a)) return ['amount', rupeeLabel(total)]
    const l = lines.find((x) => inRange(x.amount, a))
    return l ? ['amount', `${rupeeLabel(l.amount)} · ${l.name}`] : null
  }
  const t = q.terms[0]
  if (t) {
    if (t.amount != null) {
      const a = amountHit({ min: t.amount, max: t.amount })
      if (a) return a
    }
    if (has(d.number, t.text)) return ['number', d.number]
    if (has(d.partyName, t.text)) return ['party', d.partyName!]
    if (has(d.narration, t.text)) return ['narration', snippet(d.narration!, t.text, 60)]
    if (has(d.reference, t.text)) return ['reference', d.reference!]
    const l = lines.find((x) => has(x.name, t.text))
    if (l) return ['ledger', l.name]
    const i = items.find((x) => has(x.name, t.text))
    if (i) return ['item', i.name]
  }
  if (q.amounts.length) {
    const a = amountHit(q.amounts[0]!)
    if (a) return a
  }
  if (q.gstins.length) {
    const g = q.gstins[0]!.toLowerCase()
    const gstin = has(d.partyGstin, g) ? d.partyGstin : lines.find((x) => has(x.gstin, g))?.gstin
    if (gstin) return ['gstin', gstin]
  }
  if (q.pans.length) {
    const p = q.pans[0]!.toLowerCase()
    const pan = has(d.partyPan, p) ? d.partyPan : lines.find((x) => has(x.pan, p))?.pan
    if (pan) return ['pan', pan]
  }
  if (q.parties.length) {
    const p = q.parties[0]!
    const name = has(d.partyName, p) ? d.partyName : lines.find((x) => has(x.name, p))?.name
    if (name) return ['party', name]
  }
  if (q.numbers.length) return ['number', d.number]
  if (q.hsns.length) {
    const h = q.hsns[0]!
    const hit = items.find((x) => x.hsn?.toLowerCase().startsWith(h)) ?? lines.find((x) => x.hsn?.toLowerCase().startsWith(h))
    if (hit) return ['hsn', `${hit.hsn} · ${hit.name}`]
  }
  if (q.groups.length) {
    const nameOf = groupsOf(q.groups[0]!).nameOf
    const l = lines.find((x) => nameOf.has(x.groupId))
    if (l) return ['group', `${nameOf.get(l.groupId)} · ${l.name}`]
  }
  if (q.types.length) return ['type', d.typeName]
  if (q.dates.length) return ['date', toDisplayDate(d.date)]
  return null
}

// ---------------------------------------------------------------- entry points

/** Search the books with the query language (see src/shared/searchQuery.ts). `query` may be the
 *  raw string or an already-parsed query. */
export function search(db: DB, query: string | ParsedQuery, opts: SearchOptions = {}): SearchResponse {
  const q = typeof query === 'string' ? parseSearchQuery(query, opts) : query
  const limit = clampLimit(opts.limitPerKind)
  const offset = clampOffset(opts.offset)
  const kinds = isEmptyQuery(q) ? [] : applicableKinds(q)
  const wanted = (k: SearchKind): boolean => !opts.kind || opts.kind === k
  const empty = { rows: [], total: 0, offset }

  const groupsOf = treeMatcher(db, 'groups')
  const response: SearchResponse = {
    chips: q.chips,
    unknown: q.unknown,
    terms: q.terms.map((t) => t.text),
    kinds,
    ledgers: null,
    items: null,
    vouchers: null
  }
  if (wanted('ledger')) response.ledgers = kinds.includes('ledger') ? searchLedgers(db, q, limit, offset, groupsOf) : empty
  if (wanted('item')) response.items = kinds.includes('item') ? searchItems(db, q, limit, offset, treeMatcher(db, 'stock_groups')) : empty
  if (wanted('voucher')) response.vouchers = kinds.includes('voucher') ? searchVouchers(db, q, limit, offset, groupsOf) : empty
  return response
}

/** Legacy ⌘K search shape (`search:global`) — now backed by `search`, so the query language
 *  works here too. SEARCH_LIMIT rows per kind. */
export function globalSearch(db: DB, q: string): SearchHit[] {
  const r = search(db, q, { limitPerKind: SEARCH_LIMIT })
  const hits: SearchHit[] = []
  for (const l of r.ledgers?.rows ?? []) hits.push({ kind: 'ledger', id: l.id, label: l.name, sub: l.groupName })
  for (const i of r.items?.rows ?? []) hits.push({ kind: 'item', id: i.id, label: i.name, sub: 'Stock item' })
  for (const v of r.vouchers?.rows ?? []) {
    hits.push({ kind: 'voucher', id: v.id, label: `${v.typeName} ${v.number}`, sub: `${toDisplayDate(v.date)} · ${v.narration ?? ''}` })
  }
  return hits
}
