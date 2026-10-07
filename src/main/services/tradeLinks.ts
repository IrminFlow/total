import { randomUUID } from 'crypto'
import type { DB } from '../db/connection'
import type { LineSource, LinkType, TradeDocKind, Voucher, VoucherKind } from '@shared/domain'
import { fyOf, toDisplayDate } from '@shared/dates'
import {
  linkRuleFor, sourceKindsFor, SHARED_CAPACITY_SOURCES, isTradeDocKind, type LinkRule, type TradeSideKind
} from '@shared/tradeCycle/rules'
import type { OpenSourceLine, VoucherLinkRow, VoucherLinks } from '@shared/tradeCycle/types'
import { getLockDate } from './vouchers'
import { parseLineSerials } from './serials'

/**
 * Trade-cycle line links (WP 2.5a, design §2.4). A link joins one SOURCE line (an order line, a
 * challan / GRN line, an invoice line) to one TARGET line that fulfils or returns it. The TARGET
 * owns its links: they ride on its input lines (`source`), and its save rewrites them inside the
 * save transaction (syncVoucherLinks) — so every throw here rolls the whole save back.
 *
 * Invariants (each throws):
 *  I1 capacity — Σ live fulfil + Σ live return ≤ source qty for challans / GRNs; for orders and
 *     invoices Σ live fulfil ≤ qty and Σ live return ≤ qty separately. Live target = a voucher
 *     not binned and not optional (post-dated counts: it reserves), or a trade doc not binned
 *     and not cancelled.
 *  I2 same party and same item on both sides.
 *  I3 same physical goods when the target line doesn't move stock: same godown and batch, and
 *     its serials are a subset of the source line's.
 *  I4 link qty = target line qty (over-delivery is a separate, unlinked line).
 *  I5 a NEW link needs an open source (not binned, not optional, not cancelled / short-closed);
 *     links that already existed survive a later close.
 *  I6 no links on optional vouchers, stock journals or physical stock (posting.ts + here).
 *  I7 a target dated before its source saves with a warning.
 * Plus the source-side rules (assertSourceEditable / assertBinnable) and the §3.4 lock rule for
 * GRN re-pricing links (repricingGuard).
 */

// ---------- schema guard ----------

const tradeSchemaSeen = new WeakSet<DB>()

/** Migrations 024–025 applied? Only data-migration tests ever save vouchers on an older schema
 *  (a partially migrated fixture); there the line-uid / link steps are skipped. Cached. */
export function hasTradeSchema(db: DB): boolean {
  if (tradeSchemaSeen.has(db)) return true
  const uid = (db.prepare('PRAGMA table_info(inventory_lines)').all() as { name: string }[]).some((c) => c.name === 'line_uid')
  const links = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'line_links'").get()
  const ok = uid && links
  if (ok) tradeSchemaSeen.add(db)
  return ok
}

/** A fresh stable line uid: 32 lowercase hex chars (same shape as the migration 024 backfill). */
export function newLineUid(): string {
  return randomUUID().replace(/-/g, '')
}

// ---------- source lines ----------

/** A line a link can draw on, with the facts the invariants need. */
export interface LinkLine {
  uid: string
  side: 'voucher' | 'doc'
  voucherId: number | null
  docId: number | null
  kind: TradeSideKind
  stockItemId: number
  godownId: number | null
  batchId: number | null
  qtyMilli: number
  amount: number
  serials: string[]
  movesStock: boolean
  partyLedgerId: number | null
  date: string
  binned: boolean
  optional: boolean
  /** Short-closed (challan / GRN) or closed / cancelled (trade doc): no NEW links. */
  closed: boolean
  cancelled: boolean
  /** "Delivery Note 12 line 2" — for messages. */
  label: string
}

interface VoucherLineRow {
  uid: string; voucherId: number; stockItemId: number; godownId: number | null; batchId: number | null
  qtyMilli: number; amount: number; serials: string | null; movesStock: number; partyLedgerId: number | null
  date: string; deletedAt: string | null; isOptional: number; kind: VoucherKind; typeName: string; number: string
  lineOrder: number; closedAt: string | null
}

const VOUCHER_LINE_SQL = `
  SELECT il.line_uid AS uid, il.voucher_id AS voucherId, il.stock_item_id AS stockItemId, il.godown_id AS godownId,
         il.batch_id AS batchId, il.qty_milli AS qtyMilli, il.amount, il.serials, il.moves_stock AS movesStock,
         v.party_ledger_id AS partyLedgerId, v.date, v.deleted_at AS deletedAt, v.is_optional AS isOptional,
         vt.kind, vt.name AS typeName, v.number, il.line_order AS lineOrder, tvd.closed_at AS closedAt
  FROM inventory_lines il
  JOIN vouchers v ON v.id = il.voucher_id
  JOIN voucher_types vt ON vt.id = v.voucher_type_id
  LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id`

const fromVoucherRow = (r: VoucherLineRow): LinkLine => ({
  uid: r.uid, side: 'voucher', voucherId: r.voucherId, docId: null, kind: r.kind, stockItemId: r.stockItemId,
  godownId: r.godownId, batchId: r.batchId, qtyMilli: r.qtyMilli, amount: r.amount, serials: parseLineSerials(r.serials),
  movesStock: r.movesStock === 1, partyLedgerId: r.partyLedgerId, date: r.date, binned: r.deletedAt != null,
  optional: r.isOptional === 1, closed: r.closedAt != null, cancelled: false,
  label: `${r.typeName} ${r.number} line ${r.lineOrder + 1}`
})

interface DocLineRow {
  uid: string; docId: number; stockItemId: number; godownId: number | null; qtyMilli: number; amount: number
  partyLedgerId: number; date: string; deletedAt: string | null; status: 'open' | 'closed' | 'cancelled'
  kind: TradeDocKind; typeName: string; number: string; lineOrder: number
}

const DOC_LINE_SQL = `
  SELECT tl.line_uid AS uid, tl.doc_id AS docId, tl.stock_item_id AS stockItemId, tl.godown_id AS godownId,
         tl.qty_milli AS qtyMilli, tl.amount, td.party_ledger_id AS partyLedgerId, td.date, td.deleted_at AS deletedAt,
         td.status, tt.kind, tt.name AS typeName, td.number, tl.line_order AS lineOrder
  FROM trade_doc_lines tl
  JOIN trade_docs td ON td.id = tl.doc_id
  JOIN trade_doc_types tt ON tt.id = td.doc_type_id`

const fromDocRow = (r: DocLineRow): LinkLine => ({
  uid: r.uid, side: 'doc', voucherId: null, docId: r.docId, kind: r.kind, stockItemId: r.stockItemId,
  godownId: r.godownId, batchId: null, qtyMilli: r.qtyMilli, amount: r.amount, serials: [], movesStock: false,
  partyLedgerId: r.partyLedgerId, date: r.date, binned: r.deletedAt != null, optional: false,
  closed: r.status !== 'open', cancelled: r.status === 'cancelled',
  label: `${r.typeName} ${r.number} line ${r.lineOrder + 1}`
})

/** The line carrying `uid` — an inventory line or a trade-doc line — or null. */
export function findLinkLine(db: DB, uid: string): LinkLine | null {
  const v = db.prepare(`${VOUCHER_LINE_SQL} WHERE il.line_uid = ?`).get(uid) as VoucherLineRow | undefined
  if (v) return fromVoucherRow(v)
  const d = db.prepare(`${DOC_LINE_SQL} WHERE tl.line_uid = ?`).get(uid) as DocLineRow | undefined
  return d ? fromDocRow(d) : null
}

// ---------- live quantities ----------

/** SQL predicate: the link's target counts (I1 "live"). Aliases: ll (line_links). */
const LIVE_TARGET = `(
  (ll.to_voucher_id IS NOT NULL AND EXISTS (SELECT 1 FROM vouchers tv WHERE tv.id = ll.to_voucher_id AND tv.deleted_at IS NULL AND tv.is_optional = 0))
  OR (ll.to_trade_doc_id IS NOT NULL AND EXISTS (SELECT 1 FROM trade_docs td WHERE td.id = ll.to_trade_doc_id AND td.deleted_at IS NULL AND td.status <> 'cancelled'))
)`

export interface LinkedQty {
  fulfilMilli: number
  returnMilli: number
}

/** Live linked quantity per source uid (fulfil and return separately). `excludeVoucherId`
 *  leaves one target voucher's links out (pricing an alteration of it). */
export function liveLinkQty(db: DB, sourceUids: readonly string[], excludeVoucherId?: number): Map<string, LinkedQty> {
  const out = new Map<string, LinkedQty>()
  const unique = [...new Set(sourceUids)]
  if (unique.length === 0 || !hasTradeSchema(db)) return out
  const stmt = db.prepare(
    `SELECT ll.link_type AS linkType, COALESCE(SUM(ll.qty_milli), 0) AS q FROM line_links ll
     WHERE ll.from_line_uid = ? AND ll.to_voucher_id IS NOT ? AND ${LIVE_TARGET} GROUP BY ll.link_type`
  )
  for (const uid of unique) {
    const rows = stmt.all(uid, excludeVoucherId ?? -1) as { linkType: LinkType; q: number }[]
    out.set(uid, {
      fulfilMilli: rows.find((r) => r.linkType === 'fulfil')?.q ?? 0,
      returnMilli: rows.find((r) => r.linkType === 'return')?.q ?? 0
    })
  }
  return out
}

/** I1 for one source line: the error message, or null when within capacity. */
function capacityError(src: LinkLine, q: LinkedQty): string | null {
  const shared = SHARED_CAPACITY_SOURCES.includes(src.kind)
  const unit = (m: number): string => String(m / 1000)
  if (shared) {
    const used = q.fulfilMilli + q.returnMilli
    if (used > src.qtyMilli) return `${src.label}: only ${unit(src.qtyMilli)} on the line, ${unit(used)} already linked (invoiced / returned)`
    return null
  }
  if (q.fulfilMilli > src.qtyMilli) return `${src.label}: only ${unit(src.qtyMilli)} on the line, ${unit(q.fulfilMilli)} would be fulfilled`
  if (q.returnMilli > src.qtyMilli) return `${src.label}: only ${unit(src.qtyMilli)} on the line, ${unit(q.returnMilli)} would be returned`
  return null
}

function assertCapacity(db: DB, sources: readonly LinkLine[]): void {
  const qty = liveLinkQty(db, sources.map((s) => s.uid))
  for (const s of sources) {
    const e = capacityError(s, qty.get(s.uid) ?? { fulfilMilli: 0, returnMilli: 0 })
    if (e) throw new Error(e)
  }
}

// ---------- stored links ----------

export interface StoredLink {
  id: number
  linkType: LinkType
  fromTradeDocId: number | null
  fromVoucherId: number | null
  fromLineUid: string
  toTradeDocId: number | null
  toVoucherId: number | null
  toLineUid: string
  qtyMilli: number
  reprices: boolean
}

const LINK_COLS = `ll.id, ll.link_type AS linkType, ll.from_trade_doc_id AS fromTradeDocId, ll.from_voucher_id AS fromVoucherId,
  ll.from_line_uid AS fromLineUid, ll.to_trade_doc_id AS toTradeDocId, ll.to_voucher_id AS toVoucherId,
  ll.to_line_uid AS toLineUid, ll.qty_milli AS qtyMilli, ll.reprices`

const mapLink = (r: Omit<StoredLink, 'reprices'> & { reprices: number }): StoredLink => ({ ...r, reprices: r.reprices === 1 })

/** Links a voucher owns as the target. */
export function targetLinksOf(db: DB, voucherId: number): StoredLink[] {
  if (!hasTradeSchema(db)) return []
  return (db.prepare(`SELECT ${LINK_COLS} FROM line_links ll WHERE ll.to_voucher_id = ? ORDER BY ll.id`).all(voucherId) as Parameters<typeof mapLink>[0][]).map(mapLink)
}

/** Links that draw on a voucher's lines (it is the source), live or binned targets alike. */
export function sourceLinksOf(db: DB, voucherId: number): StoredLink[] {
  if (!hasTradeSchema(db)) return []
  return (db.prepare(`SELECT ${LINK_COLS} FROM line_links ll WHERE ll.from_voucher_id = ? ORDER BY ll.id`).all(voucherId) as Parameters<typeof mapLink>[0][]).map(mapLink)
}

/** The source of each of a voucher's lines, by target line uid (getVoucher's `source`). */
export function lineSourcesOf(db: DB, voucherId: number): Map<string, LineSource> {
  return new Map(targetLinksOf(db, voucherId).map((l) => [l.toLineUid, { lineUid: l.fromLineUid, linkType: l.linkType }]))
}

/** "Sales 40" for a link's target (voucher or trade doc). */
function targetLabel(db: DB, l: StoredLink): string {
  if (l.toVoucherId != null) {
    const r = db.prepare('SELECT vt.name, v.number FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?').get(l.toVoucherId) as
      | { name: string; number: string }
      | undefined
    return r ? `${r.name} ${r.number}` : 'another voucher'
  }
  const d = db.prepare('SELECT tt.name, td.number FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id WHERE td.id = ?').get(l.toTradeDocId) as
    | { name: string; number: string }
    | undefined
  return d ? `${d.name} ${d.number}` : 'another document'
}

function isLiveTarget(db: DB, l: StoredLink): boolean {
  return !!db.prepare(`SELECT 1 FROM line_links ll WHERE ll.id = ? AND ${LIVE_TARGET}`).get(l.id)
}

// ---------- GRN re-pricing under the lock (§3.4) ----------

/** A GRN dated on/before the books lock, or in an FY with a live year-end closing journal: its
 *  stock value is frozen, so a new bill link to it does not re-price (reprices = 0). */
export function repricingFrozen(db: DB, grnDate: string): boolean {
  const lock = getLockDate(db)
  if (lock && grnDate <= lock) return true
  const fy = fyOf(grnDate)
  return !!db
    .prepare(`SELECT 1 FROM vouchers v WHERE v.deleted_at IS NULL AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
    .get(fy.from, fy.to)
}

/** Re-pricing links of `links` whose GRN is frozen now — they must not move. */
function frozenRepricingLinks(db: DB, links: readonly StoredLink[]): { link: StoredLink; grn: LinkLine }[] {
  const out: { link: StoredLink; grn: LinkLine }[] = []
  for (const l of links) {
    if (!l.reprices) continue
    const grn = findLinkLine(db, l.fromLineUid)
    if (grn && repricingFrozen(db, grn.date)) out.push({ link: l, grn })
  }
  return out
}

const lockedRepricingMessage = (grn: LinkLine, what: string): string =>
  `${grn.label} (${toDisplayDate(grn.date)}) is in a locked period or closed year and is priced by this bill — ${what}`

// ---------- the target's save ----------

/** One input line, after uid assignment and source resolution (before it is inserted). */
export interface ResolvedLine {
  uid: string
  movesStock: boolean
  link: { source: LinkLine; rule: LinkRule } | null
}

export interface LinkInputLine {
  stockItemId: number
  godownId: number | null
  batchId?: number | null
  qtyMilli: number
  amount: number
  direction: 'in' | 'out'
  isAbsolute?: boolean
  serials?: readonly string[]
  lineUid?: string
  source?: LineSource | null
}

/**
 * Assign each input line its uid (kept only when it belonged to this voucher's saved lines — a
 * payload can't adopt another voucher's line) and resolve its source: unknown sources,
 * self-links and pairs outside the rules are refused here, before anything is inserted.
 */
export function resolveVoucherLines(
  db: DB,
  lines: readonly LinkInputLine[],
  ctx: { kind: VoucherKind; before: Voucher | null }
): ResolvedLine[] {
  const own = new Set((ctx.before?.inventory ?? []).map((l) => l.lineUid).filter((u): u is string => !!u))
  const used = new Set<string>()
  return lines.map((l, i) => {
    const uid = l.lineUid && own.has(l.lineUid) && !used.has(l.lineUid) ? l.lineUid : newLineUid()
    used.add(uid)
    if (!l.source) return { uid, movesStock: true, link: null }
    const source = findLinkLine(db, l.source.lineUid)
    if (!source) throw new Error(`Line ${i + 1}: the line it was drawn from no longer exists`)
    if (ctx.before && source.voucherId === ctx.before.id) throw new Error(`Line ${i + 1}: a voucher can't be linked to its own lines`)
    if (l.isAbsolute) throw new Error(`Line ${i + 1}: a physical-count line can't be linked`)
    const rule = linkRuleFor(source.kind, ctx.kind, l.source.linkType)
    if (!rule) {
      throw new Error(`Line ${i + 1}: a ${ctx.kind.replace('_', ' ')} line can't ${l.source.linkType === 'fulfil' ? 'fulfil' : 'return'} ${source.label}`)
    }
    return { uid, movesStock: !rule.nonMoving, link: { source, rule } }
  })
}

export interface LinkWarnings {
  linkDates: string[]
  frozenRepricing: string[]
}

export interface SyncLinksContext {
  voucherId: number
  kind: VoucherKind
  date: string
  partyLedgerId: number | null
  isOptional: boolean
  lines: readonly LinkInputLine[]
  resolved: readonly ResolvedLine[]
  before: Voucher | null
}

/**
 * The saveVoucher step (inside its transaction, after the new lines are inserted): rewrite the
 * voucher's own links from its input, re-check I1–I7 on them, and check the voucher's role as a
 * SOURCE of other documents' links (assertSourceEditable).
 */
export function syncVoucherLinks(db: DB, ctx: SyncLinksContext): LinkWarnings {
  const warnings: LinkWarnings = { linkDates: [], frozenRepricing: [] }
  if (!hasTradeSchema(db)) return warnings
  const previous = targetLinksOf(db, ctx.voucherId)
  const prevByTarget = new Map(previous.map((l) => [l.toLineUid, l]))
  const beforeLine = new Map((ctx.before?.inventory ?? []).map((l) => [l.lineUid, l]))

  // §3.4 (2): re-pricing links into a now-frozen GRN must survive unchanged (qty and amount).
  for (const { link, grn } of frozenRepricingLinks(db, previous)) {
    const i = ctx.resolved.findIndex((r) => r.uid === link.toLineUid)
    const was = beforeLine.get(link.toLineUid)
    const now = i >= 0 ? ctx.lines[i] : undefined
    const same =
      !!now && !!was && !ctx.isOptional && ctx.resolved[i]!.link?.source.uid === link.fromLineUid &&
      now.qtyMilli === link.qtyMilli && now.amount === was.amount
    if (!same) throw new Error(lockedRepricingMessage(grn, "its quantity and amount can't change"))
  }

  db.prepare('DELETE FROM line_links WHERE to_voucher_id = ?').run(ctx.voucherId)
  const insert = db.prepare(
    `INSERT INTO line_links (link_type, from_trade_doc_id, from_voucher_id, from_line_uid, to_voucher_id, to_line_uid, qty_milli, reprices)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const sources: LinkLine[] = []
  ctx.resolved.forEach((r, i) => {
    if (!r.link) return
    const line = ctx.lines[i]!
    const { source, rule } = r.link
    const n = `Line ${i + 1}`
    // I6 — memorandum vouchers never link (posting.ts checks the payload flag; this is the stored one).
    if (ctx.isOptional) throw new Error('An optional (memorandum) voucher cannot be linked to other documents')
    // I2
    if (source.partyLedgerId !== ctx.partyLedgerId) throw new Error(`${n}: ${source.label} belongs to another party`)
    if (source.stockItemId !== line.stockItemId) throw new Error(`${n}: ${source.label} is for a different item`)
    // I3 — the goods moved on the source: they must be the same goods.
    if (!r.movesStock) {
      if ((source.godownId ?? null) !== (line.godownId ?? null)) throw new Error(`${n}: the godown must match ${source.label}`)
      if ((source.batchId ?? null) !== (line.batchId ?? null)) throw new Error(`${n}: the batch must match ${source.label}`)
      const have = new Set(source.serials)
      const extra = (line.serials ?? []).find((s) => !have.has(s))
      if (extra !== undefined) throw new Error(`${n}: serial ${extra} is not on ${source.label}`)
    }
    // I5 — new links need an open source; a link that already existed survives a later close.
    const prev = prevByTarget.get(r.uid)
    const existed = !!prev && prev.fromLineUid === source.uid && prev.linkType === rule.linkType
    if (source.binned) throw new Error(`${n}: ${source.label} is in the bin`)
    if (source.optional) throw new Error(`${n}: ${source.label} is an optional (memorandum) voucher`)
    if (source.cancelled) throw new Error(`${n}: ${source.label} is cancelled`)
    if (source.closed && !existed) throw new Error(`${n}: ${source.label} is closed`)
    // I7 — dated before its source: allowed, with a warning.
    if (ctx.date < source.date) warnings.linkDates.push(`${n} is dated before ${source.label} (${toDisplayDate(source.date)})`)
    // §3.4 (1): reprices is an entry fact fixed when the link is made.
    let reprices = false
    if (rule.reprices) {
      if (existed) reprices = prev!.reprices
      else if (repricingFrozen(db, source.date)) {
        warnings.frozenRepricing.push(`${n}: price difference not loaded into stock — ${source.label} is in a locked period`)
      } else reprices = true
    }
    // I4 — the link quantity is the target line's.
    insert.run(rule.linkType, source.docId, source.voucherId, source.uid, ctx.voucherId, r.uid, line.qtyMilli, reprices ? 1 : 0)
    sources.push(source)
  })
  // I1, with this voucher's new links in place.
  assertCapacity(db, sources)
  assertSourceEditable(db, ctx)
  return warnings
}

/**
 * This voucher as a SOURCE: every line other documents still link to (live or binned targets)
 * must remain with the same item — and the same godown, batch and serials when a non-moving
 * target relies on them — with enough quantity for the live links; party, kind and "optional"
 * must not change underneath live links.
 */
export function assertSourceEditable(db: DB, ctx: SyncLinksContext): void {
  const links = sourceLinksOf(db, ctx.voucherId)
  if (links.length === 0) return
  const lineByUid = new Map(ctx.resolved.map((r, i) => [r.uid, ctx.lines[i]!]))
  const checked = new Set<string>()
  for (const l of links) {
    const target = targetLabel(db, l)
    const was = ctx.before?.inventory.find((x) => x.lineUid === l.fromLineUid)
    const where = was ? `line ${ctx.before!.inventory.indexOf(was) + 1}` : 'a line'
    const refuse = (why: string): never => {
      throw new Error(`${where} is linked to ${target} — ${why}; bin that first`)
    }
    const now = lineByUid.get(l.fromLineUid)
    if (!now) refuse("it can't be removed")
    if (was && now!.stockItemId !== was.stockItemId) refuse("its item can't change")
    const targetLine = db.prepare('SELECT moves_stock AS m, serials FROM inventory_lines WHERE line_uid = ?').get(l.toLineUid) as
      | { m: number; serials: string | null }
      | undefined
    if (targetLine && targetLine.m === 0 && was) {
      if ((now!.godownId ?? null) !== (was.godownId ?? null)) refuse("its godown can't change")
      if ((now!.batchId ?? null) !== (was.batchId ?? null)) refuse("its batch can't change")
      const have = new Set(now!.serials ?? [])
      if (parseLineSerials(targetLine.serials).some((s) => !have.has(s))) refuse('its serials are on the linked line')
    }
    const live = isLiveTarget(db, l)
    if (live) {
      if (ctx.isOptional) refuse("it can't become optional")
      if (ctx.partyLedgerId !== (ctx.before?.partyLedgerId ?? ctx.partyLedgerId)) refuse("its party can't change")
      const targetKind = l.toVoucherId != null
        ? (db.prepare('SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?').get(l.toVoucherId) as { kind: VoucherKind }).kind
        : (db.prepare('SELECT tt.kind FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id WHERE td.id = ?').get(l.toTradeDocId) as { kind: TradeDocKind }).kind
      if (!linkRuleFor(ctx.kind, targetKind, l.linkType)) refuse("its voucher type can't change")
    }
    if (checked.has(l.fromLineUid)) continue
    checked.add(l.fromLineUid)
    const src = findLinkLine(db, l.fromLineUid)
    if (src) {
      const e = capacityError(src, liveLinkQty(db, [src.uid]).get(src.uid)!)
      if (e) refuse(`${e.replace(`${src.label}: `, '')}`)
    }
  }
}

// ---------- bin / restore ----------

/** Binning `voucherId`: refused while a live document draws on its lines, or when it re-prices a
 *  GRN that is now frozen (§3.4). Its own links simply go dormant (not live). */
export function assertBinnable(db: DB, voucherId: number): void {
  if (!hasTradeSchema(db)) return
  for (const l of sourceLinksOf(db, voucherId)) {
    if (isLiveTarget(db, l)) {
      const src = findLinkLine(db, l.fromLineUid)
      throw new Error(`${src?.label ?? 'A line'} is linked to ${targetLabel(db, l)}; bin that first`)
    }
  }
  const frozen = frozenRepricingLinks(db, targetLinksOf(db, voucherId))
  if (frozen.length > 0) throw new Error(lockedRepricingMessage(frozen[0]!.grn, "this bill can't be moved to the bin"))
}

/** Restoring `voucherId` (call AFTER it is un-binned, inside the restore transaction): every
 *  source it links to must still be there and open enough for its quantity again. */
export function assertRestorable(db: DB, voucherId: number): void {
  if (!hasTradeSchema(db)) return
  const links = targetLinksOf(db, voucherId)
  if (links.length === 0) return
  const sources: LinkLine[] = []
  const v = db.prepare('SELECT party_ledger_id AS p, is_optional AS o FROM vouchers WHERE id = ?').get(voucherId) as { p: number | null; o: number }
  for (const l of links) {
    const src = findLinkLine(db, l.fromLineUid)
    if (!src) throw new Error('A line it was drawn from no longer exists — it cannot be restored')
    if (src.binned) throw new Error(`${src.label} is in the bin — restore it first`)
    if (src.optional) throw new Error(`${src.label} is now an optional (memorandum) voucher`)
    if (src.cancelled) throw new Error(`${src.label} is cancelled`)
    if (src.partyLedgerId !== v.p) throw new Error(`${src.label} now belongs to another party`)
    sources.push(src)
  }
  if (v.o === 0) {
    const qty = liveLinkQty(db, sources.map((s) => s.uid))
    for (const s of sources) {
      const e = capacityError(s, qty.get(s.uid)!)
      if (e) throw new Error(`${e} — another document has taken that quantity since`)
    }
  }
  const frozen = frozenRepricingLinks(db, links)
  if (frozen.length > 0) throw new Error(lockedRepricingMessage(frozen[0]!.grn, "this bill can't be restored"))
}

// ---------- queries (IPC) ----------

export type { OpenSourceLine, VoucherLinkRow, VoucherLinks }

/** links:forVoucher — both directions of a voucher's links. */
export function linksForVoucher(db: DB, voucherId: number): VoucherLinks {
  if (!hasTradeSchema(db)) return { upstream: [], downstream: [] }
  const upstream = targetLinksOf(db, voucherId).map((l): VoucherLinkRow => {
    const src = findLinkLine(db, l.fromLineUid)
    return {
      linkId: l.id, linkType: l.linkType, qtyMilli: l.qtyMilli, reprices: l.reprices, lineUid: l.toLineUid,
      otherLineUid: l.fromLineUid, otherVoucherId: l.fromVoucherId, otherTradeDocId: l.fromTradeDocId,
      otherLabel: src?.label ?? 'a removed line', otherDate: src?.date ?? null, live: !!src && !src.binned
    }
  })
  const downstream = sourceLinksOf(db, voucherId).map((l): VoucherLinkRow => {
    const tgt = findLinkLine(db, l.toLineUid)
    return {
      linkId: l.id, linkType: l.linkType, qtyMilli: l.qtyMilli, reprices: l.reprices, lineUid: l.fromLineUid,
      otherLineUid: l.toLineUid, otherVoucherId: l.toVoucherId, otherTradeDocId: l.toTradeDocId,
      otherLabel: tgt?.label ?? targetLabel(db, l), otherDate: tgt?.date ?? null, live: isLiveTarget(db, l)
    }
  })
  return { upstream, downstream }
}

/** links:openSourceLines — a party's lines a `targetKind` line could draw on with `linkType`
 *  (open sources only, pending > 0). The "Add from…" drawer of WP 2.5b reads this. */
export function openSourceLines(
  db: DB,
  q: { partyLedgerId: number; targetKind: TradeSideKind; linkType: LinkType; excludeVoucherId?: number }
): OpenSourceLine[] {
  if (!hasTradeSchema(db)) return []
  const kinds = sourceKindsFor(q.targetKind, q.linkType)
  if (kinds.length === 0) return []
  const voucherKinds = kinds.filter((k) => !isTradeDocKind(k))
  const docKinds = kinds.filter(isTradeDocKind)
  const rows: { line: LinkLine; ratePaise: number }[] = []
  if (voucherKinds.length > 0) {
    const vr = db
      .prepare(
        `${VOUCHER_LINE_SQL.replace('il.line_order AS lineOrder', 'il.line_order AS lineOrder, il.rate_paise AS ratePaise')}
         WHERE v.party_ledger_id = ? AND vt.kind IN (${voucherKinds.map(() => '?').join(',')})
           AND v.deleted_at IS NULL AND v.is_optional = 0 AND tvd.closed_at IS NULL AND il.is_absolute = 0
         ORDER BY v.date, v.id, il.line_order`
      )
      .all(q.partyLedgerId, ...voucherKinds) as (VoucherLineRow & { ratePaise: number })[]
    for (const r of vr) rows.push({ line: fromVoucherRow(r), ratePaise: r.ratePaise })
  }
  if (docKinds.length > 0) {
    const dr = db
      .prepare(
        `${DOC_LINE_SQL.replace('tl.line_order AS lineOrder', 'tl.line_order AS lineOrder, tl.rate_paise AS ratePaise')}
         WHERE td.party_ledger_id = ? AND tt.kind IN (${docKinds.map(() => '?').join(',')})
           AND td.deleted_at IS NULL AND td.status = 'open'
         ORDER BY td.date, td.id, tl.line_order`
      )
      .all(q.partyLedgerId, ...docKinds) as (DocLineRow & { ratePaise: number })[]
    for (const r of dr) rows.push({ line: fromDocRow(r), ratePaise: r.ratePaise })
  }
  const qty = liveLinkQty(db, rows.map((r) => r.line.uid), q.excludeVoucherId)
  const out: OpenSourceLine[] = []
  for (const { line, ratePaise } of rows) {
    const used = qty.get(line.uid) ?? { fulfilMilli: 0, returnMilli: 0 }
    const done = SHARED_CAPACITY_SOURCES.includes(line.kind)
      ? used.fulfilMilli + used.returnMilli
      : q.linkType === 'fulfil' ? used.fulfilMilli : used.returnMilli
    const pending = line.qtyMilli - done
    if (pending <= 0) continue
    out.push({
      lineUid: line.uid, voucherId: line.voucherId, tradeDocId: line.docId, kind: line.kind, label: line.label, date: line.date,
      stockItemId: line.stockItemId, godownId: line.godownId, batchId: line.batchId, serials: line.serials,
      qtyMilli: line.qtyMilli, doneMilli: done, pendingMilli: pending, ratePaise, amount: line.amount
    })
  }
  return out
}
