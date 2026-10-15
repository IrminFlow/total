// WP 7.1 — the outputs that must stay byte-identical through performance work: every read-only
// budgeted case plus the same reports over other periods / ledgers / sides. Hashed (SHA-256 of a
// canonical JSON) so the expectations file stays small; reportEquality.dbtest.ts compares them.
import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import * as reports from '../services/reports'
import { outstandingsWithAdvances, registerByMonth } from '../services/analysis'
import { stockSummary } from '../services/stockAnalysis'
import { gstr1, gstr3b } from '../services/gst'
import { owedList, byMonth } from '../services/simpleReports'
import { billsToPay } from '../services/simplePeople'
import { PERF_CASES, perfContext } from './bench'
import { closeFacts } from '../services/assistants'
import { negativeStock } from '../services/stockAnalysis'
import { checkStock, listVouchers } from '../services/vouchers'
import { gstValidate } from '../services/gst'
import { gstr9 } from '../services/gstAnnual'
import { search } from '../services/search'
import { purchasesList, purchaseView } from '../services/simpleBuy'
import { salesList, saleView } from '../services/simpleSell'
import { returnBills } from '../services/simpleReturns'
import { lowStockCount } from '../services/simpleStock'
import { dashboardSeries } from '../services/dashboard'
import { addDaysISO, fyOf } from '@shared/dates'

/** Canonical JSON: keys sorted; per-run identifiers (line uids) dropped. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (/uid$/i.test(key)) return undefined
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    }
    return v
  })
}

export const hashOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

/** Every output by name, as on `today`. */
export async function reportOutputs(db: DB, info: CompanyInfo, today: string): Promise<Record<string, unknown>> {
  const ctx = perfContext(db, info, today)
  const out: Record<string, unknown> = {}
  for (const c of PERF_CASES) if (!c.writes) out[c.id] = await c.run(ctx)
  const fyStarts = [info.booksFrom, info.booksFrom + 1, info.booksFrom + 2].filter((y) => `${y}-04-01` <= today)
  for (const y of fyStarts) {
    const from = `${y}-04-01`
    const to = `${y + 1}-03-31` < today ? `${y + 1}-03-31` : today
    out[`tb:${to}`] = reports.trialBalance(db, to)
    out[`pnl:${from}`] = reports.profitAndLoss(db, from, to, { comparePrior: true })
    out[`bs:${to}`] = reports.balanceSheet(db, ctx.booksFrom, to, true)
    out[`stock:${to}`] = stockSummary(db, to)
    out[`register:sales:${from}`] = registerByMonth(db, 'sales', from, to)
    out[`register:purchase:${from}`] = registerByMonth(db, 'purchase', from, to)
    out[`ledger:bank:${from}`] = reports.ledgerStatement(db, ctx.ids.bank, from, to, 'month')
    out[`ledger:party:${from}`] = reports.ledgerStatement(db, ctx.ids.party, from, to)
    out[`daybook:${from}:q1`] = reports.dayBook(db, from, `${y}-06-30`)
    for (const m of ['05', '11']) {
      const mf = `${y}-${m}-01`
      if (mf > today) continue
      const mt = m === '05' ? `${y}-05-31` : `${y}-11-30`
      out[`gstr1:${mf}`] = gstr1(db, info, mf, mt, `${m}${y}`)
      out[`gstr3b:${mf}`] = gstr3b(db, info, mf, mt, `${m}${y}`)
    }
  }
  out.owedReceivable = owedList(db, 'receivable', today)
  out.owedPayable = owedList(db, 'payable', today)
  out.withAdvancesPayable = outstandingsWithAdvances(db, 'payable', today)
  out.byMonth = byMonth(db, today)
  out.billsToPay = billsToPay(db, today)
  // WP 7.1 review: every other reader of the rewritten queries — the close checklist's facts
  // (one Outstandings run per side, the in-books ledger set), the stock check on many / few items,
  // all-type voucher lists and the Gateway's recent entries on other days, search pages past the
  // first, the purchase side of the returns lookup, the low-stock count, GSTR-9 / validation over
  // the chunked outward documents, the Gateway series a year back.
  for (let k = 0; k < 13; k++) {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() - k)
    const period = d.toISOString().slice(0, 7)
    if (`${period}-01` < ctx.booksFrom) break
    out[`closeFacts:${period}`] = closeFacts(db, info, period, today)
  }
  const itemIds = (db.prepare('SELECT id FROM stock_items ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  for (const d of [today, addDaysISO(today, -200), addDaysISO(today, -400)]) {
    out[`negativeStock:${d}`] = negativeStock(db, d)
    out[`checkStock:few:${d}`] = checkStock(db, itemIds.slice(0, 5), d)
    out[`dashboardRecent:${d}`] = reports.dashboard(db, d, fyOf(d).from)
    out[`lowStock:${d}`] = lowStockCount(db, d)
  }
  out['voucherList:all:month'] = listVouchers(db, ctx.month.from, ctx.month.to)
  out['voucherList:all:fy'] = listVouchers(db, ctx.fy.from, ctx.fy.to)
  for (const q of [ctx.ids.partyName, ctx.ids.partyName.slice(0, 3), ctx.ids.voucherNumber]) {
    for (const offset of [0, 20, 40, 100_000]) out[`search:${q}:${offset}`] = search(db, q, { today, offset, kind: 'voucher' })
  }
  const prevFy = { from: addDaysISO(ctx.fy.from, -365), to: addDaysISO(ctx.fy.from, -1) }
  out['sales:prevFy'] = salesList(db, prevFy.from, prevFy.to, today)
  out['purchases:fy'] = purchasesList(db, ctx.fy.from, today, today)
  out['purchases:prevFy'] = purchasesList(db, prevFy.from, prevFy.to, today)
  out['returnBills:sale'] = returnBills(db, info, 'sale', today)
  out['returnBills:purchase'] = returnBills(db, info, 'purchase', today)
  const returned = db
    .prepare(
      `SELECT DISTINCT ll.from_voucher_id AS id, vt.kind FROM line_links ll JOIN vouchers v ON v.id = ll.from_voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE ll.link_type = 'return' ORDER BY ll.from_voucher_id LIMIT 40`
    )
    .all() as { id: number; kind: string }[]
  for (const r of returned) {
    if (r.kind === 'sales') out[`saleView:${r.id}`] = saleView(db, r.id, today)
    if (r.kind === 'purchase') out[`purchaseView:${r.id}`] = purchaseView(db, r.id, today)
  }
  for (const y of fyStarts) {
    out[`gstr9:${y}`] = gstr9(db, info, y)
    out[`gstValidate:${y}`] = gstValidate(db, info, `${y}-04-01`, `${y + 1}-03-31` < today ? `${y + 1}-03-31` : today)
  }
  out['gateway:prevFy'] = dashboardSeries(db, info, { today: prevFy.to, from: prevFy.from, to: prevFy.to, backups: [] })
  out['pnl:month'] = reports.profitAndLoss(db, ctx.month.from, today)
  return out
}

/** Fields added to an output AFTER the expectations were generated (from origin/main's code),
 *  per output id. Left out of the hash only while they hold the given neutral value, so the
 *  expectations are never regenerated for an additive field, and a seed where the field carries
 *  a figure (which then also moves the figures beside it) still fails. Review of the gate-polish
 *  PR: `rounding` (doingLines' own Rounding line) is 0 on both seeds; with it left out the new
 *  outputs hash to the fixture origin/main's code wrote. */
export const ADDITIVE_FIELDS: Record<string, Record<string, unknown>> = {
  home: { rounding: 0 },
  doing: { rounding: 0 }
}

/** `value` without the additive fields still at their neutral value (anywhere in the tree). */
export function withoutAdditive(id: string, value: unknown): unknown {
  const fields = ADDITIVE_FIELDS[id]
  if (!fields) return value
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k, x]) => !(Object.prototype.hasOwnProperty.call(fields, k) && Object.is(fields[k], x)))
          .map(([k, x]) => [k, strip(x)])
      )
    }
    return v
  }
  return strip(value)
}

export async function reportHashes(db: DB, info: CompanyInfo, today: string): Promise<Record<string, string>> {
  const outputs = await reportOutputs(db, info, today)
  return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, hashOf(withoutAdditive(k, v))]))
}
