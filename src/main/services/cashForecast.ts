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
//   MSME s.15 / s.16         shared/payables/msme.ts s15Deadline / s16Interest on each open payable
//                            bill of a covered supplier (payables.listBankRates; read by the
//                            engine only with `msmeDue` — off by default)
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
import { NOT_FX_REVALUATION, openingBillsByParty, openingEvents, outstandings } from './analysis'
import { listGroups, descendantIdsByName } from './masters'
import { pendingOrders, pendingStockNotes } from './tradeReports'
import { statutoryDues } from './payrollStatutory'
import { dueInstalments } from './loans'
import { listBankRates } from './payables'
import { daysBetween, isMsmeCovered, s15Deadline, s16Interest, type MsmeCategory } from '@shared/payables/msme'
import { IN_BOOKS, NOT_DELETED } from './vouchers'
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

// ---------- pending post-dated cheques ----------

/** Pending post-dated receipts / payments (not in the books yet, not binned, not optional): the
 *  net on cash + bank is the cheque (Dr = received → in, Cr = issued → out), on the voucher's
 *  date; the party is the voucher's party, else its largest other line. One statement. */
export function pdcFlows(db: DB): ForecastFlow[] {
  const groups = listGroups(db)
  const cashBank = descendantIdSet(groups, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])
  const ledgers = db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as { id: number; name: string; groupId: number }[]
  const names = new Map(ledgers.map((l) => [l.id, l.name]))
  const isCashBank = new Set(ledgers.filter((l) => cashBank.has(l.groupId)).map((l) => l.id))
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, v.instrument_no AS instrumentNo, v.party_ledger_id AS partyId,
              vl.ledger_id AS ledgerId, vl.dr_cr AS drCr, vl.amount
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id
       WHERE v.post_dated = 1 AND v.is_optional = 0 AND ${NOT_DELETED} AND vt.kind IN ('receipt', 'payment')
       ORDER BY v.date, v.id, vl.line_order, vl.id`
    )
    .all() as { voucherId: number; date: string; number: string; instrumentNo: string | null; partyId: number | null; ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  const byVoucher = new Map<number, typeof rows>()
  for (const r of rows) byVoucher.set(r.voucherId, [...(byVoucher.get(r.voucherId) ?? []), r])
  const out: ForecastFlow[] = []
  for (const lines of byVoucher.values()) {
    const v = lines[0]!
    const net = lines.filter((l) => isCashBank.has(l.ledgerId)).reduce((sum, l) => sum + (l.drCr === 'dr' ? l.amount : -l.amount), 0)
    if (net === 0) continue
    const other = lines.filter((l) => !isCashBank.has(l.ledgerId)).sort((a, b) => b.amount - a.amount)[0]
    const party = v.partyId ?? other?.ledgerId ?? null
    out.push({
      source: 'pdc', direction: net > 0 ? 'in' : 'out', date: v.date, amount: Math.abs(net), probabilityBp: 10_000,
      label: `${party != null ? `${names.get(party) ?? ''} · ` : ''}cheque ${v.instrumentNo ?? v.number}`, ledgerId: party, voucherId: v.voucherId
    })
  }
  return out
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
       WHERE vl.ledger_id IN (${ph}) AND v.date <= ? AND ${IN_BOOKS} AND ${NOT_FX_REVALUATION}
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
  const openingBills = openingBillsByParty(db, parties.map((p) => p.id))
  for (const p of parties) {
    // WP 8.7: the opening through the one reader (its bills, or the single unnamed opening).
    const opening = openingEvents(asOn, p.ob, 1, openingBills.get(p.id), p.creditDays)
    const events: BillEvent[] = [...opening, ...(byParty.get(p.id) ?? [])]
    // Opening bills aren't sales the customer paid on our terms — leave them out of the learned
    // shares (billHistory emits one record per bill opened, in order: the openings come first).
    const openingCount = opening.filter((e) => e.amount > 0).length
    out.push(...billHistory(events, p.creditDays).slice(openingCount))
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

/**
 * Goods delivered on a challan (purpose supply) or received on a GRN (purpose purchase) but not
 * yet invoiced / billed: the pending taxable value is a receivable / payable in waiting, expected
 * on the note's date + the party's credit days (receivables also get the median delay and the
 * first bucket's collection probability). Orders already fulfilled by a challan are not counted
 * again — tradeReports.pendingOrders treats them as done.
 */
function unbilledNoteFlows(db: DB, asOn: string, profile: ReturnType<typeof collectionProfile>): ForecastFlow[] {
  const creditDays = new Map((db.prepare('SELECT id, credit_days AS d FROM ledgers').all() as { id: number; d: number | null }[]).map((l) => [l.id, l.d ?? 0]))
  const out: ForecastFlow[] = []
  for (const stage of ['delivery_note', 'receipt_note'] as const) {
    const purpose = stage === 'delivery_note' ? 'supply' : 'purchase'
    const byNote = new Map<number, { number: string; date: string; party: string | null; partyId: number | null; amount: number }>()
    for (const l of pendingStockNotes(db, stage, asOn)) {
      if (l.purpose !== purpose) continue
      const n = byNote.get(l.voucherId) ?? { number: l.number, date: l.date, party: l.partyName, partyId: l.partyLedgerId, amount: 0 }
      n.amount += l.pendingValue
      byNote.set(l.voucherId, n)
    }
    for (const [voucherId, n] of byNote) {
      if (n.amount <= 0) continue
      const due = addDays(n.date, n.partyId != null ? (creditDays.get(n.partyId) ?? 0) : 0)
      out.push(stage === 'delivery_note'
        ? { source: 'receivable', direction: 'in', date: addDays(due, profile.medianDelayDays), amount: n.amount, probabilityBp: profile.bucketProbabilityBp[0], label: `${n.party ?? 'Challan'} · challan ${n.number} (not invoiced)`, ledgerId: n.partyId, voucherId, bucket: 0 }
        : { source: 'payable', direction: 'out', date: due, amount: n.amount, probabilityBp: 10_000, label: `${n.party ?? 'GRN'} · GRN ${n.number} (not billed)`, ledgerId: n.partyId, voucherId })
    }
  }
  return out
}

// ---------- MSME s.15 deadlines ----------

/**
 * Attaches the MSMED Act facts to every payable bill flow of a covered supplier (registered
 * micro / small — s.2(n), `isMsmeCovered`) accepted on or after its `msme_registered_from`
 * (payables.ts `coveredOn`, the same rule): the s.15 pay-by date (`s15Deadline` on the bill date
 * with the WRITTEN agreed credit days) and, once past it, the indicative s.16 interest up to
 * `asOn` (`s16Interest` with the editable bank rates — as payablesPlan computes it). Read always;
 * the engine uses it only with `msmeDue`. Bills of other suppliers are returned untouched.
 */
export function withMsmeFacts(db: DB, bills: readonly OpenBillInput[], flows: ForecastFlow[], asOn: string): ForecastFlow[] {
  const terms = new Map(
    (db.prepare('SELECT id, msme_registered AS registered, msme_category AS category, msme_registered_from AS registeredFrom, agreed_credit_days AS agreedDays FROM ledgers WHERE msme_registered = 1').all() as {
      id: number; registered: number; category: MsmeCategory | null; registeredFrom: string | null; agreedDays: number | null
    }[]).filter((r) => isMsmeCovered({ registered: !!r.registered, category: r.category })).map((r) => [r.id, r])
  )
  if (terms.size === 0) return flows
  const rates = listBankRates(db)
  // payableFlows maps the bills with pending > 0 one to one, in order.
  const open = bills.filter((b) => b.pending > 0)
  return flows.map((f, i) => {
    const b = open[i]
    const t = b ? terms.get(b.ledgerId) : undefined
    if (!b || !t || (t.registeredFrom != null && b.date < t.registeredFrom)) return f
    const s15 = s15Deadline(b.date, t.agreedDays)
    const interestPaise = asOn >= s15.interestFrom ? s16Interest(b.pending, s15.interestFrom, asOn, rates).interestPaise : 0
    return { ...f, msme: { payBy: s15.payBy, daysLate: Math.max(0, daysBetween(s15.payBy, asOn)), interestPaise, pending: b.pending } }
  })
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
    // The s.15 facts ride along on MSME bills; counted only when the screen turns on msmeDue.
    flows.push(...withMsmeFacts(db, bills, payableFlows(bills), asOn))
  })
  attempt('Open orders', () => flows.push(...orderFlows(db, asOn)))
  attempt('Unbilled challans and GRNs', () => flows.push(...unbilledNoteFlows(db, asOn, profile)))
  attempt('Known items', () => flows.push(...itemFlows(listForecastItems(db), asOn, to)))
  attempt('Statutory dues', () => flows.push(...statutoryFlows(db, company, asOn)))
  // Read always, counted only when the screen turns them on (buildForecast's includePdc).
  attempt('Post-dated cheques', () => flows.push(...pdcFlows(db)))
  attempt('Loan EMIs', () => {
    for (const e of dueInstalments(db, '0000-01-01', to)) {
      flows.push({ source: 'emi', direction: 'out', date: e.dueDate, amount: e.payment, probabilityBp: 10_000, label: `${e.loanName} · EMI`, loanId: e.loanId })
    }
  })
  return { asOn, openingCash: opening.total, cashLedgers: opening.ledgers, flows, receivableProfile: profile, warnings }
}
