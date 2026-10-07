// Cash-flow forecast inputs (WP 4.4). Gathers every dated flow the pure engine
// (src/shared/cashForecast.ts) weighs — open bills, open orders, the user's known items, statutory
// dues and loan EMIs — plus today's cash and bank, all from the books at query time. The renderer
// runs buildForecast on this base for whatever scenario the sliders say.
//
// Sources used (one definition each, never re-derived):
//   opening cash & bank      reports.closingBalances over Cash-in-Hand / Bank Accounts / Bank OD
//                            (the trial balance's figures — a dbtest pins them equal)
//   receivables / payables   analysis.outstandings (the Outstandings screen's open bills)
//   collection history       the same party events, replayed with settlement dates (billHistory)
//   open orders              tradeReports.pendingOrders (taxable pending value per line)
//   statutory dues           GST: tax-type ledgers' net credit; TDS / TCS: tagged payable ledgers;
//                            PF / ESI / PT: payrollStatutory.statutoryDues (outstanding per run)
//   loan EMIs                loans.dueInstalments (unposted, active loans)
//   known items              forecast_items
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  billHistory, collectionProfile, itemFlows, payableFlows, receivableFlows,
  type ForecastFlow, type HistoryBill, type OpenBillInput
} from '@shared/cashForecast'
import type { BillEvent, BillRef } from '@shared/outstanding'
import { forecastItemInputSchema, type ForecastBase, type ForecastCashLedger, type ForecastItem, type ForecastItemInput } from '@shared/cashFinance'
import { fyOf } from '@shared/dates'
import { writeAudit } from './audit'
import { closingBalances, descendantIdSet } from './reports'
import { outstandings } from './analysis'
import { listGroups, descendantIdsByName } from './masters'
import { pendingOrders } from './tradeReports'
import { statutoryDues } from './payrollStatutory'
import { dueInstalments } from './loans'
import { IN_BOOKS } from './vouchers'
import { addDays } from './cashFinanceCommon'

// ---------- known items ----------

interface ItemRow { id: number; name: string; amount: number; cadence: ForecastItem['cadence']; start_date: string; end_date: string | null; kind: ForecastItem['kind']; active: number; note: string | null }
const mapItem = (r: ItemRow): ForecastItem => ({
  id: r.id, name: r.name, amount: r.amount, cadence: r.cadence, startDate: r.start_date, endDate: r.end_date, kind: r.kind, active: !!r.active, note: r.note
})

export function listForecastItems(db: DB): ForecastItem[] {
  return (db.prepare('SELECT * FROM forecast_items ORDER BY active DESC, start_date, name').all() as ItemRow[]).map(mapItem)
}

function getItem(db: DB, id: number): ForecastItem | null {
  const r = db.prepare('SELECT * FROM forecast_items WHERE id = ?').get(id) as ItemRow | undefined
  return r ? mapItem(r) : null
}

export function saveForecastItem(db: DB, raw: ForecastItemInput, id?: number): ForecastItem {
  const i = forecastItemInputSchema.parse(raw)
  const before = id ? getItem(db, id) : null
  if (id && !before) throw new Error('Forecast item not found')
  const vals = [i.name, i.amount, i.cadence, i.startDate, i.endDate, i.kind, i.active ? 1 : 0, i.note]
  let itemId: number
  if (id) {
    db.prepare('UPDATE forecast_items SET name = ?, amount = ?, cadence = ?, start_date = ?, end_date = ?, kind = ?, active = ?, note = ? WHERE id = ?').run(...vals, id)
    itemId = id
  } else {
    itemId = Number(db.prepare('INSERT INTO forecast_items (name, amount, cadence, start_date, end_date, kind, active, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...vals).lastInsertRowid)
  }
  const after = getItem(db, itemId)!
  writeAudit(db, 'forecast_item', itemId, id ? 'update' : 'create', before, after)
  return after
}

export function deleteForecastItem(db: DB, id: number): void {
  const before = getItem(db, id)
  if (!before) throw new Error('Forecast item not found')
  db.prepare('DELETE FROM forecast_items WHERE id = ?').run(id)
  writeAudit(db, 'forecast_item', id, 'delete', before, null)
}

// ---------- opening cash ----------

export function openingCash(db: DB, asOn: string): { total: number; ledgers: ForecastCashLedger[] } {
  const groups = listGroups(db)
  const cashIds = descendantIdSet(groups, ['Cash-in-Hand'])
  const bankIds = descendantIdSet(groups, ['Bank Accounts', 'Bank OD A/c'])
  const bal = closingBalances(db, asOn)
  const ledgers = (db.prepare('SELECT id, name, group_id AS groupId FROM ledgers ORDER BY name').all() as { id: number; name: string; groupId: number }[])
    .filter((l) => cashIds.has(l.groupId) || bankIds.has(l.groupId))
    .map((l) => ({ ledgerId: l.id, name: l.name, kind: cashIds.has(l.groupId) ? ('cash' as const) : ('bank' as const), balance: bal.get(l.id) ?? 0 }))
  return { total: ledgers.reduce((s, l) => s + l.balance, 0), ledgers }
}

// ---------- collection history ----------

/** Every debtor's events up to asOn (opening balance, movements, bill refs), replayed into
 *  settled / unsettled bill history. Mirrors analysis.outstandings' event building. */
export function receivableHistory(db: DB, asOn: string): HistoryBill[] {
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const parties = (db.prepare('SELECT id, opening_balance AS ob, group_id AS groupId, credit_days AS creditDays FROM ledgers').all() as {
    id: number; ob: number; groupId: number; creditDays: number | null
  }[]).filter((p) => debtors.has(p.groupId))
  if (parties.length === 0) return []
  const ph = parties.map(() => '?').join(',')
  const moves = db
    .prepare(
      `SELECT vl.ledger_id AS partyId, v.id AS voucherId, v.date, v.number,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
       FROM voucher_lines vl CROSS JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id IN (${ph}) AND v.date <= ? AND ${IN_BOOKS}
       GROUP BY vl.ledger_id, v.id ORDER BY vl.ledger_id, v.date, v.id`
    )
    .all(...parties.map((p) => p.id), asOn) as { partyId: number; voucherId: number; date: string; number: string; net: number }[]
  const refs = db
    .prepare(
      `SELECT br.party_ledger_id AS partyId, br.voucher_id AS voucherId, br.kind, br.name, br.amount, br.due_date AS dueDate
       FROM bill_refs br CROSS JOIN vouchers v ON v.id = br.voucher_id
       WHERE br.party_ledger_id IN (${ph}) AND v.date <= ? AND ${IN_BOOKS} ORDER BY br.id`
    )
    .all(...parties.map((p) => p.id), asOn) as { partyId: number; voucherId: number; kind: 'new' | 'against'; name: string; amount: number; dueDate: string | null }[]
  const refMap = new Map<string, BillRef[]>()
  for (const r of refs) {
    const k = `${r.partyId}|${r.voucherId}`
    const list = refMap.get(k) ?? []
    list.push({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.dueDate })
    refMap.set(k, list)
  }
  const byParty = new Map<number, BillEvent[]>()
  for (const m of moves) {
    const list = byParty.get(m.partyId) ?? []
    list.push({ voucherId: m.voucherId, date: m.date, number: m.number, amount: m.net, refs: refMap.get(`${m.partyId}|${m.voucherId}`) ?? [] })
    byParty.set(m.partyId, list)
  }
  const out: HistoryBill[] = []
  for (const p of parties) {
    const events: BillEvent[] = []
    if (p.ob !== 0) events.push({ voucherId: null, date: fyOf(asOn).from, number: 'Opening', amount: p.ob, refs: [] })
    events.push(...(byParty.get(p.id) ?? []))
    // Opening balances carry no real issue date — leave them out of the learned shares.
    out.push(...billHistory(events, p.creditDays).filter((_, i) => !(i === 0 && p.ob > 0)))
  }
  return out
}

// ---------- statutory ----------

const nextMonth = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
const prevMonthEnd = (date: string): string => addDays(`${date.slice(0, 7)}-01`, -1)

/**
 * Credit-balance dues on a set of ledgers, split into what accrued up to last month-end (due in
 * the current month) and this month's accrual (due next month). Debits since the month began
 * clear the older part first. `dueDay(accrualMonth)` gives the due date.
 */
function ledgerDues(db: DB, ids: number[], asOn: string, dueOf: (accrualMonth: string) => string, label: string): ForecastFlow[] {
  if (ids.length === 0) return []
  const prevEnd = prevMonthEnd(asOn)
  const ph = ids.map(() => '?').join(',')
  const ob = (db.prepare(`SELECT COALESCE(SUM(opening_balance), 0) AS s FROM ledgers WHERE id IN (${ph})`).get(...ids) as { s: number }).s
  const q = (from: string, to: string): { dr: number; cr: number } =>
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END), 0) AS dr, COALESCE(SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE 0 END), 0) AS cr
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id IN (${ph}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    ).get(...ids, from, to) as { dr: number; cr: number }
  const upToPrev = q('0000-01-01', prevEnd)
  const thisMonth = q(`${asOn.slice(0, 7)}-01`, asOn)
  const prevOwed = Math.max(0, -(ob + upToPrev.dr - upToPrev.cr))
  const prevRemaining = Math.max(0, prevOwed - thisMonth.dr)
  const nowOwed = Math.max(0, -(ob + upToPrev.dr - upToPrev.cr + thisMonth.dr - thisMonth.cr))
  const current = Math.max(0, nowOwed - prevRemaining)
  const out: ForecastFlow[] = []
  const prevMonth = prevEnd.slice(0, 7)
  if (prevRemaining > 0) out.push({ source: 'statutory', direction: 'out', date: dueOf(prevMonth), amount: prevRemaining, probabilityBp: 10_000, label: `${label} · ${prevMonth}` })
  if (current > 0) out.push({ source: 'statutory', direction: 'out', date: dueOf(asOn.slice(0, 7)), amount: current, probabilityBp: 10_000, label: `${label} · ${asOn.slice(0, 7)}` })
  return out
}

/**
 * Statutory due dates used (UNVERIFIED as summarised here — check the current notifications):
 * - GST (GSTR-3B cash payment): 20th of the following month (CGST Rules 2017, rule 61(5) read with
 *   s.39(7) CGST Act; QRMP filers differ and are not modelled).
 * - TDS: 7th of the following month; deductions in March by 30 April (Income-tax Rules 1962,
 *   rule 30(1)(b)).
 * - TCS: 7th of the following month (Income-tax Rules 1962, rule 37CA(1)).
 * - PF / ESI / PT: the due dates payrollStatutory.statutoryDues already computes (WP 3.7).
 */
export function statutoryFlows(db: DB, company: CompanyInfo, asOn: string): ForecastFlow[] {
  const out: ForecastFlow[] = []
  const gstIds = (db.prepare('SELECT id FROM ledgers WHERE tax_type IS NOT NULL').all() as { id: number }[]).map((r) => r.id)
  if (company.gstRegistrationType === 'regular') out.push(...ledgerDues(db, gstIds, asOn, (m) => `${nextMonth(m)}-20`, 'GST (GSTR-3B)'))
  const tdsIds = (db.prepare('SELECT id FROM ledgers WHERE tds_payable_section_id IS NOT NULL').all() as { id: number }[]).map((r) => r.id)
  out.push(...ledgerDues(db, tdsIds, asOn, (m) => (m.endsWith('-03') ? `${m.slice(0, 4)}-04-30` : `${nextMonth(m)}-07`), 'TDS'))
  const tcsIds = (db.prepare('SELECT id FROM ledgers WHERE tcs_payable_section_id IS NOT NULL').all() as { id: number }[]).map((r) => r.id)
  out.push(...ledgerDues(db, tcsIds, asOn, (m) => `${nextMonth(m)}-07`, 'TCS'))
  const fy = fyOf(asOn)
  const seen = new Set<string>()
  for (const fyStart of [fy.startYear - 1, fy.startYear]) {
    for (const d of statutoryDues(db, fyStart, asOn)) {
      if (d.kind === 'tds' || d.outstandingPaise <= 0 || seen.has(d.key)) continue
      seen.add(d.key)
      out.push({ source: 'statutory', direction: 'out', date: d.dueDate, amount: d.outstandingPaise, probabilityBp: 10_000, label: `${d.kind.toUpperCase()} · ${d.period}${d.state ? ` (${d.state})` : ''}`, voucherId: d.voucherId })
    }
  }
  return out
}

// ---------- orders ----------

function orderFlows(db: DB, asOn: string): ForecastFlow[] {
  const creditDays = new Map((db.prepare('SELECT id, credit_days AS d FROM ledgers').all() as { id: number; d: number | null }[]).map((l) => [l.id, l.d ?? 0]))
  const out: ForecastFlow[] = []
  for (const kind of ['sales_order', 'purchase_order'] as const) {
    const byDoc = new Map<number, { number: string; party: string; partyId: number; date: string; amount: number }>()
    for (const l of pendingOrders(db, kind, asOn)) {
      const d = byDoc.get(l.docId) ?? { number: l.number, party: l.partyName, partyId: l.partyLedgerId, date: l.dueDate ?? l.date, amount: 0 }
      d.amount += l.pendingValue
      const lineDate = l.dueDate ?? l.date
      if (lineDate > d.date) d.date = lineDate
      byDoc.set(l.docId, d)
    }
    for (const [docId, d] of byDoc) {
      if (d.amount <= 0) continue
      out.push({
        source: kind, direction: kind === 'sales_order' ? 'in' : 'out', date: addDays(d.date, creditDays.get(d.partyId) ?? 0), amount: d.amount,
        probabilityBp: 10_000, label: `${d.party} · ${d.number}`, ledgerId: d.partyId, docId
      })
    }
  }
  return out
}

// ---------- the base ----------

const toBill = (p: { ledgerId: number; name: string }, b: { voucherId: number | null; number: string; date: string; dueDate: string | null; pending: number; overdueDays: number }): OpenBillInput => ({
  ledgerId: p.ledgerId, partyName: p.name, voucherId: b.voucherId, number: b.number, date: b.date, dueDate: b.dueDate, pending: b.pending, overdueDays: b.overdueDays
})

export function forecastBase(db: DB, company: CompanyInfo, asOn: string, to: string): ForecastBase {
  const warnings: string[] = []
  const flows: ForecastFlow[] = []
  const attempt = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const opening = openingCash(db, asOn)
  let profile = collectionProfile([], asOn)
  attempt('Collection history', () => { profile = collectionProfile(receivableHistory(db, asOn), asOn) })
  attempt('Receivables', () => {
    const bills = outstandings(db, 'receivable', asOn).flatMap((p) => p.bills.map((b) => toBill(p, b)))
    flows.push(...receivableFlows(bills, profile))
  })
  attempt('Payables', () => {
    const bills = outstandings(db, 'payable', asOn).flatMap((p) => p.bills.map((b) => toBill(p, b)))
    flows.push(...payableFlows(bills))
  })
  attempt('Open orders', () => flows.push(...orderFlows(db, asOn)))
  attempt('Known items', () => flows.push(...itemFlows(listForecastItems(db), asOn, to)))
  attempt('Statutory dues', () => flows.push(...statutoryFlows(db, company, asOn)))
  attempt('Loan EMIs', () => {
    for (const e of dueInstalments(db, '0000-01-01', to)) {
      flows.push({ source: 'emi', direction: 'out', date: e.dueDate, amount: e.payment, probabilityBp: 10_000, label: `${e.loanName} · EMI`, loanId: e.loanId })
    }
  })
  return { asOn, openingCash: opening.total, cashLedgers: opening.ledgers, flows, receivableProfile: profile, warnings }
}
