/**
 * Loads sales / receipts + ledger and goods facts for the TCS event walk (WP 3.3) — the TCS twin
 * of tdsEvents.ts. A SALE debiting the buyer is the "credit" event and a RECEIPT from the buyer
 * the "payment" event of src/shared/tdsEligibility.ts's walkTdsEvents (first-of-debit-or-receipt,
 * s.206C(1) / 2025 s.394(1)(c) — citations in migration 027); classification and the base are
 * src/shared/tcs.ts. Used by the threshold base (tds.resolveTds for a TCS section), the TCS
 * Eligible tab, the suggestion and tcs:applyToVoucher.
 */
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { walkTdsEvents, type TdsVoucherClass, type WalkEvent, type WalkResult } from '@shared/tdsEligibility'
import { classifyTcsVoucher, tcsBasePaise, TCS_KINDS, type TcsLedgerFacts, type TcsVoucherClass } from '@shared/tcs'
import { rateRowOn, resolveDeducteeType, type DeducteeType, type WithholdingRateRow } from '@shared/withholding'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { IN_BOOKS, NOT_YEAR_END_CLOSE } from './vouchers'
import { ratesBySection } from './tdsEvents'

export interface LedgerTcsFacts extends TcsLedgerFacts {
  id: number
  name: string
  pan: string | null
  deducteeType: DeducteeType | null
}

/** Every ledger's TCS-relevant facts, by id. */
export function ledgerTcsFacts(db: DB): Map<number, LedgerTcsFacts> {
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const cashBank = cashBankGroupIds(db)
  const rows = db
    .prepare(
      `SELECT id, name, group_id, pan, deductee_type, tcs_section_id, tcs_default_section_id, tcs_payable_section_id, tax_type
       FROM ledgers`
    )
    .all() as {
      id: number; name: string; group_id: number; pan: string | null; deductee_type: DeducteeType | null
      tcs_section_id: number | null; tcs_default_section_id: number | null; tcs_payable_section_id: number | null; tax_type: string | null
    }[]
  const out = new Map<number, LedgerTcsFacts>()
  for (const r of rows) {
    out.set(r.id, {
      id: r.id, name: r.name, pan: r.pan, deducteeType: resolveDeducteeType(r.deductee_type, r.pan),
      isCollecteeCandidate: debtors.has(r.group_id) || r.tcs_section_id != null,
      tcsSectionId: r.tcs_section_id,
      defaultSectionId: r.tcs_default_section_id,
      isTax: r.tax_type != null,
      isTcsPayable: r.tcs_payable_section_id != null,
      isCashBank: cashBank.has(r.group_id)
    })
  }
  return out
}

/** Stock item id → its TCS goods section (only flagged items). */
export function itemTcsSections(db: DB): Map<number, { sectionId: number; name: string }> {
  const rows = db.prepare('SELECT id, name, tcs_section_id AS s FROM stock_items WHERE tcs_section_id IS NOT NULL').all() as { id: number; name: string; s: number }[]
  return new Map(rows.map((r) => [r.id, { sectionId: r.s, name: r.name }]))
}

export interface LoadedTcsVoucher {
  id: number
  date: string
  number: string
  kind: VoucherKind
  partyLedgerId: number | null
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  inventory: { stockItemId: number; amount: number; direction: 'in' | 'out' }[]
  entry: { id: number; sectionId: number; partyLedgerId: number; baseAmount: number; tcsAmount: number } | null
  exemptReason: string | null
}

/** Sales / receipts in the books (not binned, optional, unmatured post-dated, never a closing
 *  journal) dated in [from, to] — optionally only those touching `partyLedgerId`. */
export function loadTcsVouchers(db: DB, from: string, to: string, opts: { partyLedgerId?: number; excludeVoucherId?: number } = {}): LoadedTcsVoucher[] {
  const kinds = TCS_KINDS.map(() => '?').join(',')
  const partyClause = opts.partyLedgerId != null ? 'AND v.id IN (SELECT voucher_id FROM voucher_lines WHERE ledger_id = ?)' : ''
  const params: unknown[] = [from, to, ...TCS_KINDS, opts.excludeVoucherId ?? -1]
  if (opts.partyLedgerId != null) params.push(opts.partyLedgerId)
  const heads = db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.kind, v.party_ledger_id AS partyLedgerId, x.reason AS exemptReason
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN tds_exemptions x ON x.voucher_id = v.id AND x.kind = 'tcs'
       WHERE v.date BETWEEN ? AND ? AND vt.kind IN (${kinds}) AND v.id <> ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       ${partyClause}
       ORDER BY v.date, v.id`
    )
    .all(...params) as { id: number; date: string; number: string; kind: VoucherKind; partyLedgerId: number | null; exemptReason: string | null }[]
  if (heads.length === 0) return []
  const byId = new Map<number, LoadedTcsVoucher>(heads.map((h) => [h.id, { ...h, lines: [], inventory: [], entry: null }]))
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const ph = chunk.map(() => '?').join(',')
    const lines = db
      .prepare(`SELECT voucher_id AS vid, ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id IN (${ph}) ORDER BY line_order, id`)
      .all(...chunk) as { vid: number; ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
    for (const l of lines) byId.get(l.vid)!.lines.push({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })
    const inv = db
      .prepare(`SELECT voucher_id AS vid, stock_item_id AS stockItemId, amount, direction FROM inventory_lines WHERE voucher_id IN (${ph}) AND is_absolute = 0 ORDER BY line_order, id`)
      .all(...chunk) as { vid: number; stockItemId: number; amount: number; direction: 'in' | 'out' }[]
    for (const l of inv) byId.get(l.vid)!.inventory.push({ stockItemId: l.stockItemId, amount: l.amount, direction: l.direction })
    const entries = db
      .prepare(
        `SELECT te.id, te.voucher_id AS vid, te.section_id AS sectionId, te.party_ledger_id AS partyLedgerId,
                te.base_amount AS baseAmount, te.tds_amount AS tcsAmount
         FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id
         WHERE te.voucher_id IN (${ph}) AND ts.kind = 'tcs' ORDER BY te.id`
      )
      .all(...chunk) as { id: number; vid: number; sectionId: number; partyLedgerId: number; baseAmount: number; tcsAmount: number }[]
    for (const e of entries) {
      const v = byId.get(e.vid)!
      if (!v.entry) v.entry = { id: e.id, sectionId: e.sectionId, partyLedgerId: e.partyLedgerId, baseAmount: e.baseAmount, tcsAmount: e.tcsAmount }
    }
  }
  return [...byId.values()]
}

export interface TcsEventGroup {
  partyLedgerId: number
  sectionId: number
  events: WalkEvent[]
  classes: Map<number, TcsVoucherClass>
}

const groupKey = (party: number, section: number): string => `${party}|${section}`

export interface TcsContext {
  facts: Map<number, LedgerTcsFacts>
  items: Map<number, { sectionId: number; name: string }>
  rates: Map<number, WithholdingRateRow[]>
}

export function tcsContext(db: DB): TcsContext {
  return { facts: ledgerTcsFacts(db), items: itemTcsSections(db), rates: ratesBySection(db) }
}

/** Classify a loaded voucher (optionally forcing a section). */
export function classifyLoaded(v: LoadedTcsVoucher, ctx: TcsContext, sectionOverride?: number | null): TcsVoucherClass | null {
  return classifyTcsVoucher(v, (id) => ctx.facts.get(id) ?? null, (id) => ctx.items.get(id)?.sectionId ?? null, sectionOverride)
}

/** The base of a classified event under the rate row in force for the buyer on the date. */
export function eventBase(cls: TcsVoucherClass, sectionId: number, date: string, ctx: TcsContext): number {
  const row = rateRowOn(ctx.rates.get(sectionId) ?? [], date, ctx.facts.get(cls.partyLedgerId)?.deducteeType ?? null)
  return tcsBasePaise(cls, row)
}

/**
 * Classify every voucher and group the events per buyer × section (the TCS mirror of
 * tdsEvents.buildEventGroups: a voucher with a recorded entry joins the entry's group; a receipt
 * from a buyer with no section of its own joins the section that buyer's sales use).
 */
export function buildTcsEventGroups(vouchers: readonly LoadedTcsVoucher[], ctx: TcsContext): Map<string, TcsEventGroup> {
  const groups = new Map<string, TcsEventGroup>()
  const add = (party: number, section: number, v: LoadedTcsVoucher, cls: TcsVoucherClass): void => {
    const key = groupKey(party, section)
    let g = groups.get(key)
    if (!g) {
      g = { partyLedgerId: party, sectionId: section, events: [], classes: new Map() }
      groups.set(key, g)
    }
    g.classes.set(v.id, cls)
    const base = cls.eventKind === 'payment' ? cls.taxablePaise : eventBase(cls, section, v.date, ctx)
    g.events.push({
      voucherId: v.id, date: v.date, kind: cls.eventKind, basePaise: base, grossPaise: cls.grossPaise,
      entryBasePaise: v.entry && v.entry.sectionId === section && v.entry.partyLedgerId === party ? v.entry.baseAmount : null,
      exempt: v.exemptReason != null
    })
  }
  const unsectioned: { v: LoadedTcsVoucher; cls: TcsVoucherClass }[] = []
  for (const v of vouchers) {
    let cls = classifyLoaded(v, ctx, v.entry?.sectionId ?? null)
    if (v.entry) {
      if (!cls || cls.partyLedgerId !== v.entry.partyLedgerId) {
        cls = {
          eventKind: v.kind === 'receipt' ? 'payment' : 'credit', partyLedgerId: v.entry.partyLedgerId, sectionId: v.entry.sectionId,
          sectionFrom: 'party', taxablePaise: v.entry.baseAmount, gstPaise: 0, grossPaise: v.entry.baseAmount, salesLedgerId: null, stockItemId: null
        }
      }
      add(v.entry.partyLedgerId, v.entry.sectionId, v, cls)
      continue
    }
    if (!cls) continue
    if (cls.sectionId == null) unsectioned.push({ v, cls })
    else add(cls.partyLedgerId, cls.sectionId, v, cls)
  }
  for (const { v, cls } of unsectioned) {
    const target = [...groups.values()].filter((g) => g.partyLedgerId === cls.partyLedgerId).sort((a, b) => b.events.length - a.events.length)[0]
    if (target) add(cls.partyLedgerId, target.sectionId, v, { ...cls, sectionId: target.sectionId, sectionFrom: 'credits' })
  }
  return groups
}

/** Walk one group with the buyer's rate rows. */
export function walkTcsGroup(group: TcsEventGroup, ctx: TcsContext): WalkResult[] {
  const rows = ctx.rates.get(group.sectionId) ?? []
  const type = ctx.facts.get(group.partyLedgerId)?.deducteeType ?? null
  return walkTdsEvents(group.events, (d) => rateRowOn(rows, d, type))
}

/** The walk for one buyer × section over [from, to] (vouchers touching the buyer only). */
export function tcsPartySectionWalk(
  db: DB, partyLedgerId: number, sectionId: number, from: string, to: string, excludeVoucherId?: number
): { results: WalkResult[]; group: TcsEventGroup | null; ctx: TcsContext } {
  const ctx = tcsContext(db)
  const vouchers = loadTcsVouchers(db, from, to, { partyLedgerId, excludeVoucherId })
  const group = buildTcsEventGroups(vouchers, ctx).get(groupKey(partyLedgerId, sectionId)) ?? null
  if (!group) return { results: [], group: null, ctx }
  return { results: walkTcsGroup(group, ctx), group, ctx }
}

// The shared walk types, re-exported for the workbench.
export type { TdsVoucherClass, WalkResult }
