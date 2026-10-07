import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear, gstPeriodOf } from '@shared/dates'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { toUqc } from '@shared/gst/uqc'
import {
  buildGstr9, gstr1JsonTotals, gstr9Csv, gstr9Json,
  type Gstr3bFigures, type Gstr9HsnInLine, type Gstr9ItcDoc, type Gstr9Month, type ItcBucket, type ReversalSplit
} from '@shared/gst/gstr9'
import { buildItc04, itc04Csv, itc04Json, itc04Periodicity, itc04Periods, type Itc04Periodicity, type Itc04PeriodKind, type Itc04SupplyFact } from '@shared/gst/itc04'
import { GSTR9_RULES } from '@shared/gst/sources'
import {
  bookedItcByVoucher, extractAdvanceAdjustments, extractAdvances, extractOutwardDocs, gstr1, gstr3b, rcmInwardByVoucher, turnover, type Gstr3bView
} from './gst'
import { itc04Data } from './jobWork'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import type { Gstr9View, Itc04View } from '@shared/gst/views'
import { companyExportsDir } from '../paths'

/**
 * GSTR-9 workings and ITC-04 (WP 3.4) — the main-process side: extraction from the vouchers and
 * the monthly returns, export snapshots, file exports. The table logic is pure
 * (shared/gst/gstr9.ts, shared/gst/itc04.ts).
 */

// ---------- export snapshots (the "as filed" side of the GSTR-9 comparison) ----------

interface Snapshot<T> {
  at: string
  data: T
}

const snapKey = (form: 'gstr1' | 'gstr3b', period: string): string => `gst.exported.${form}.${period}`

function readSnap<T>(db: DB, key: string): Snapshot<T> | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as Snapshot<T>
  } catch {
    return null
  }
}

function writeSnap(db: DB, key: string, data: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify({ at: new Date().toISOString(), data })
  )
}

/** The GSTR-3B figures GSTR-9 keeps for a month. */
export function gstr3bFigures(v: Gstr3bView): Gstr3bFigures {
  return {
    outward: v.outward, zeroRated: v.zeroRated, nilExempt: v.nilExempt, rcm: v.rcm, itcParts: v.itcParts,
    manual: v.circular170.entered, blocked175: v.circular170.blocked, netPayable: v.netPayable, rcmPayable: v.rcmPayable
  }
}

/** Called by the gst:exportGstr1 / gst:exportGstr3b handlers: what was exported for the period
 *  becomes the "as filed" side GSTR-9 compares the year's books against. */
export function recordGstr1Export(db: DB, period: string, json: Record<string, unknown>): void {
  writeSnap(db, snapKey('gstr1', period), json)
}
export function recordGstr3bExport(db: DB, period: string, v: Gstr3bView): void {
  writeSnap(db, snapKey('gstr3b', period), gstr3bFigures(v))
}

const REV_SPLIT_KEY = (period: string): string => `gst.itcRev.applied.${period}`
export function readReversalSplit(db: DB, period: string): ReversalSplit | null {
  return readSnap<ReversalSplit>(db, REV_SPLIT_KEY(period))?.data ?? null
}
export function writeReversalSplit(db: DB, period: string, split: ReversalSplit): void {
  writeSnap(db, REV_SPLIT_KEY(period), split)
}

// ---------- GSTR-9 ----------

const monthEnd = (y: number, m: number): string => `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`

export function fyMonths(fyStartYear: number): { from: string; to: string; period: string; key: string }[] {
  const out: { from: string; to: string; period: string; key: string }[] = []
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1
    const y = m >= 4 ? fyStartYear : fyStartYear + 1
    const from = `${y}-${String(m).padStart(2, '0')}-01`
    out.push({ from, to: monthEnd(y, m), period: gstPeriodOf(from), key: from.slice(0, 7) })
  }
  return out
}

/** The year's purchase-side ITC per voucher, classified for GSTR-9 Table 6. */
export function itcDocsFor(db: DB, company: CompanyInfo, from: string, to: string): Gstr9ItcDoc[] {
  const head = db.prepare(
    `SELECT v.id, v.number, v.date, vt.kind, v.party_ledger_id AS partyLedgerId, p.name AS partyName,
            p.state_code AS partyState, COALESCE(p.itc_eligibility, 'eligible') AS itcEligibility
     FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
     WHERE v.id = ?`
  )
  const hasInventory = db.prepare('SELECT 1 FROM inventory_lines WHERE voucher_id = ? LIMIT 1')
  const fixedAssetIds = descendantIdsByName(db, ['Fixed Assets'])
  const expenseIds = descendantIdsByName(db, ['Direct Expenses', 'Indirect Expenses'])
  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])
  const lines = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  )
  const invTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM inventory_lines WHERE voucher_id = ?')
  type Head = { id: number; number: string; date: string; kind: 'purchase' | 'debit_note'; partyLedgerId: number | null; partyName: string | null; partyState: string | null; itcEligibility: string }

  const describe = (voucherId: number): { h: Head; bucket: ItcBucket; taxable: number } => {
    const h = head.get(voucherId) as Head
    const ls = lines.all(voucherId) as { amount: number; drCr: 'dr' | 'cr'; groupId: number }[]
    const side = h.kind === 'debit_note' ? 'cr' : 'dr'
    const sign = h.kind === 'debit_note' ? -1 : 1
    const inv = hasInventory.get(voucherId) != null
    const taxable = sign * (inv ? (invTotal.get(voucherId) as { t: number }).t : ls.filter((l) => l.drCr === side && purchaseGroupIds.has(l.groupId)).reduce((t, l) => t + l.amount, 0))
    // Party flag first (Masters → ITC eligibility), else what the voucher bought: fixed-asset
    // ledgers → capital goods, stock / purchase accounts → inputs, expense ledgers → services.
    const bucket: ItcBucket =
      h.itcEligibility === 'capital_goods' ? 'capital_goods'
        : h.itcEligibility === 'input_services' ? 'input_services'
          : ls.some((l) => l.drCr === side && fixedAssetIds.has(l.groupId)) ? 'capital_goods'
            : inv ? 'inputs'
              : ls.some((l) => l.drCr === side && expenseIds.has(l.groupId)) ? 'input_services'
                : 'inputs'
    return { h, bucket, taxable }
  }

  const out: Gstr9ItcDoc[] = []
  for (const r of bookedItcByVoucher(db, from, to)) {
    const { h, bucket, taxable } = describe(r.voucherId)
    out.push({
      voucherId: r.voucherId, number: h.number, date: h.date, kind: h.kind, partyName: h.partyName, partyLedgerId: h.partyLedgerId,
      taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess, bucket,
      source: r.bucket === 'blocked' ? 'blocked' : r.bucket === 'impg' ? 'import' : 'domestic'
    })
  }
  for (const r of rcmInwardByVoucher(db, company, from, to)) {
    const { h, bucket } = describe(r.voucherId)
    out.push({
      voucherId: r.voucherId, number: h.number, date: h.date, kind: h.kind, partyName: h.partyName, partyLedgerId: h.partyLedgerId,
      taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess, bucket,
      source: r.partyGstin ? 'rcm_registered' : 'rcm_unregistered'
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
}

/** Inward HSN lines (Table 18): purchase inventory lines, tax at the item master rate. */
function hsnInward(db: DB, company: CompanyInfo, from: string, to: string): Gstr9HsnInLine[] {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, vt.kind, il.qty_milli AS qtyMilli, il.amount, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate,
              u.uqc, u.symbol, p.state_code AS partyState
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN stock_items si ON si.id = il.stock_item_id
       JOIN units u ON u.id = si.unit_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = 'purchase' AND si.hsn IS NOT NULL AND si.hsn <> '' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as { voucherId: number; kind: string; qtyMilli: number; amount: number; hsn: string; gstRate: number | null; cessRate: number | null; uqc: string | null; symbol: string; partyState: string | null }[]
  return rows.map((r) => {
    const g = computeGst(r.amount, r.gstRate ?? 0, supplyTypeFor(company.stateCode, r.partyState ?? company.stateCode), r.cessRate ?? 0)
    const mapped = toUqc(r.uqc ?? r.symbol)
    return {
      voucherId: r.voucherId, hsn: r.hsn, uqc: mapped.fallback ? (r.uqc ?? r.symbol) : mapped.uqc, qtyMilli: r.qtyMilli, rate: r.gstRate ?? 0,
      amounts: { taxable: r.amount, igst: g.igst, cgst: g.cgst, sgst: g.sgst, cess: g.cess }
    }
  })
}

export function gstr9(db: DB, company: CompanyInfo, fyStartYear: number): Gstr9View {
  const fy = fyFromStartYear(fyStartYear)
  const months: Gstr9Month[] = fyMonths(fyStartYear).map((m) => {
    const g1Snap = readSnap<Record<string, unknown>>(db, snapKey('gstr1', m.period))
    const g3Snap = readSnap<Gstr3bFigures>(db, snapKey('gstr3b', m.period))
    const g1json = g1Snap?.data ?? gstr1(db, company, m.from, m.to, m.period).json
    const g3 = g3Snap?.data ?? gstr3bFigures(gstr3b(db, company, m.from, m.to, m.period))
    const source = g1Snap || g3Snap ? 'exported' : 'books'
    return {
      period: m.period,
      source,
      exportedAt: g3Snap?.at ?? g1Snap?.at ?? null,
      gstr1: gstr1JsonTotals(g1json),
      // Older snapshots predate these fields — default them so sums never see undefined.
      gstr3b: { ...g3, blocked175: g3.blocked175 ?? { igst: 0, cgst: 0, sgst: 0, cess: 0 } },
      reversalSplit: readReversalSplit(db, m.period)
    }
  })
  const result = buildGstr9({
    fyLabel: fy.label,
    gstin: company.gstin ?? '',
    docs: extractOutwardDocs(db, company, fy.from, fy.to),
    advances: extractAdvances(db, company, fy.from, fy.to),
    advanceAdjustments: extractAdvanceAdjustments(db, company, fy.from, fy.to),
    itcDocs: itcDocsFor(db, company, fy.from, fy.to),
    hsnInward: hsnInward(db, company, fy.from, fy.to),
    months
  })
  const t = turnover(db, fy.from, fy.to)
  return {
    ...result,
    fyStartYear,
    from: fy.from,
    to: fy.to,
    dueDate: `${fyStartYear + 1}-${GSTR9_RULES.due}`,
    turnover: t,
    optional: t <= GSTR9_RULES.exemptUptoPaise,
    gstr9cApplies: t > GSTR9_RULES.gstr9cAbovePaise
  }
}

export function exportGstr9(db: DB, company: CompanyInfo, slug: string, fyStartYear: number): { jsonPath: string; csvPath: string } {
  const r = gstr9(db, company, fyStartYear)
  const dir = companyExportsDir(slug)
  const base = `gstr9-workings-${r.fyLabel}`
  const jsonPath = join(dir, `${base}.json`)
  const csvPath = join(dir, `${base}.csv`)
  writeFileSync(jsonPath, JSON.stringify(gstr9Json(r), null, 2))
  writeFileSync(csvPath, gstr9Csv(r))
  return { jsonPath, csvPath }
}

// ---------- ITC-04 ----------

/** Sales whose stock left from a job-worker godown (Table 5C). */
function suppliesFromJobWorkers(db: DB, from: string, to: string): Itc04SupplyFact[] {
  return (db
    .prepare(
      `SELECT v.id AS voucherId, v.number AS invoiceNo, v.date AS invoiceDate, il.stock_item_id AS stockItemId, si.name AS itemName,
              si.hsn, u.symbol AS unit, il.qty_milli AS qtyMilli, il.amount AS amountPaise,
              l.id AS partyLedgerId, l.name AS jwName, l.gstin AS jwGstin, l.state_code AS jwStateCode
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN godowns g ON g.id = il.godown_id
       JOIN stock_items si ON si.id = il.stock_item_id
       JOIN units u ON u.id = si.unit_id
       LEFT JOIN ledgers l ON l.id = g.party_ledger_id
       WHERE vt.kind = 'sales' AND g.kind = 'job_worker' AND il.direction = 'out' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, il.line_order`
    )
    .all(from, to) as (Itc04SupplyFact & { jwName: string | null })[])
    .map((r) => ({ ...r, jwName: r.jwName ?? '', jwStateCode: r.jwGstin ? r.jwGstin.slice(0, 2) : r.jwStateCode }))
}

export function itc04(
  db: DB,
  company: CompanyInfo,
  q: { fyStartYear: number; kind: Itc04PeriodKind; periodicity?: Itc04Periodicity }
): Itc04View {
  const prev = fyFromStartYear(q.fyStartYear - 1)
  const precedingTurnover = turnover(db, prev.from, prev.to)
  const derivedPeriodicity = itc04Periodicity(precedingTurnover)
  const periodicity = q.periodicity ?? derivedPeriodicity
  const periods = itc04Periods(q.fyStartYear, periodicity)
  const period = periods.find((p) => p.kind === q.kind) ?? periods[0]!
  const data = itc04Data(db, period.from, period.to)
  const itemIds = new Set<number>([
    ...data.sent.map((s) => s.stockItemId), ...data.returned.map((s) => s.stockItemId),
    ...data.received.flatMap((r) => [...r.goods, ...r.inputs].map((g) => g.stockItemId))
  ])
  const rateStmt = db.prepare('SELECT gst_rate AS gstRate, cess_rate AS cessRate FROM stock_items WHERE id = ?')
  const itemRates: Record<number, { gstRate: number; cessRate: number }> = {}
  for (const id of itemIds) {
    const r = rateStmt.get(id) as { gstRate: number | null; cessRate: number | null } | undefined
    itemRates[id] = { gstRate: r?.gstRate ?? 0, cessRate: r?.cessRate ?? 0 }
  }
  // Party ledger ids for LedgerLink.
  const partyByVoucher = new Map(
    (db.prepare('SELECT voucher_id AS v, party_ledger_id AS p FROM job_work_challans').all() as { v: number; p: number }[]).map((r) => [r.v, r.p])
  )
  const withParty = <T extends { voucherId: number }>(xs: T[]): (T & { partyLedgerId: number | null })[] => xs.map((x) => ({ ...x, partyLedgerId: partyByVoucher.get(x.voucherId) ?? null }))
  const result = buildItc04({
    period,
    data: { sent: withParty(data.sent), received: withParty(data.received), returned: withParty(data.returned), itemRates },
    supplies: suppliesFromJobWorkers(db, period.from, period.to),
    companyStateCode: company.stateCode
  })
  return { result, periodicity, derivedPeriodicity, precedingTurnover, periods }
}

export function exportItc04(
  db: DB, company: CompanyInfo, slug: string, q: { fyStartYear: number; kind: Itc04PeriodKind; periodicity?: Itc04Periodicity }
): { jsonPath: string; csvPath: string } {
  const { result } = itc04(db, company, q)
  const dir = companyExportsDir(slug)
  const base = `itc04-${result.period.fyStartYear}-${result.period.kind}`
  const jsonPath = join(dir, `${base}.json`)
  const csvPath = join(dir, `${base}.csv`)
  writeFileSync(jsonPath, JSON.stringify(itc04Json(result, company.gstin ?? ''), null, 2))
  writeFileSync(csvPath, itc04Csv(result))
  return { jsonPath, csvPath }
}

