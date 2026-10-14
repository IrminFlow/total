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
  return out
}

export async function reportHashes(db: DB, info: CompanyInfo, today: string): Promise<Record<string, string>> {
  const outputs = await reportOutputs(db, info, today)
  return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, hashOf(v)]))
}
