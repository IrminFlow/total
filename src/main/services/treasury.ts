import type { DB } from '../db/connection'
import type {
  DailyCashPosition, LiquidityScenario, LiquidityScenarioInput, TreasuryAccountBalance,
  TreasuryAlert, TreasuryAlertSettings, TreasuryForecast, TreasuryForecastEvent
} from '@shared/treasury'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import { outstandings } from './analysis'
import { writeAudit } from './audit'

const DAY = 86_400_000
const SETTINGS_KEY = 'treasury.alerts.v1'

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

/** Advance by one calendar month while preserving the intended day where possible.
 *  31 January becomes 28/29 February, then 28/29 March rather than drifting by 28 days. */
function addMonth(date: string, anchoredDay?: number | null): string {
  const current = new Date(`${date}T00:00:00Z`)
  const intendedDay = anchoredDay ?? current.getUTCDate()
  const year = current.getUTCFullYear()
  const month = current.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(intendedDay, lastDay))).toISOString().slice(0, 10)
}

function accountBalances(db: DB, asOn: string): TreasuryAccountBalance[] {
  const cashGroups = descendantIdsByName(db, ['Cash-in-Hand'])
  const bankGroups = descendantIdsByName(db, ['Bank Accounts', 'Bank OD A/c'])
  const ledgers = db.prepare('SELECT id, name, group_id AS groupId, opening_balance AS openingBalance FROM ledgers ORDER BY name').all() as { id: number; name: string; groupId: number; openingBalance: number }[]
  const movement = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS amount
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
  )
  return ledgers.flatMap((ledger) => {
    const kind = cashGroups.has(ledger.groupId) ? 'cash' : bankGroups.has(ledger.groupId) ? 'bank' : null
    if (!kind) return []
    const row = movement.get(ledger.id, asOn) as { amount: number }
    return [{ ledgerId: ledger.id, name: ledger.name, kind, balance: ledger.openingBalance + row.amount }]
  })
}

function scenarioRow(row: Record<string, unknown>): LiquidityScenario {
  const assumptions = JSON.parse(String(row.assumptionsJson)) as LiquidityScenarioInput
  return { id: Number(row.id), ...assumptions, createdBy: String(row.createdBy), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) }
}

export function listScenarios(db: DB): LiquidityScenario[] {
  return (db.prepare(
    `SELECT id, assumptions_json AS assumptionsJson, created_by AS createdBy,
            created_at AS createdAt, updated_at AS updatedAt FROM liquidity_scenarios ORDER BY name COLLATE NOCASE`
  ).all() as Record<string, unknown>[]).map(scenarioRow)
}

export function saveScenario(db: DB, input: LiquidityScenarioInput, actor: string, id?: number): LiquidityScenario {
  const payload = JSON.stringify(input)
  if (id != null) {
    const before = listScenarios(db).find((row) => row.id === id)
    if (!before) throw new Error('Liquidity scenario not found')
    db.prepare("UPDATE liquidity_scenarios SET name = ?, assumptions_json = ?, updated_at = datetime('now') WHERE id = ?").run(input.name, payload, id)
    const after = listScenarios(db).find((row) => row.id === id)!
    writeAudit(db, 'liquidity_scenario', id, 'update', before, after)
    return after
  }
  const result = db.prepare('INSERT INTO liquidity_scenarios (name, assumptions_json, created_by) VALUES (?, ?, ?)').run(input.name, payload, actor)
  const created = listScenarios(db).find((row) => row.id === Number(result.lastInsertRowid))!
  writeAudit(db, 'liquidity_scenario', created.id, 'create', null, created)
  return created
}

export function deleteScenario(db: DB, id: number): void {
  const before = listScenarios(db).find((row) => row.id === id)
  if (!before) throw new Error('Liquidity scenario not found')
  db.prepare('DELETE FROM liquidity_scenarios WHERE id = ?').run(id)
  writeAudit(db, 'liquidity_scenario', id, 'delete', before, null)
}

function recurringEvents(db: DB, from: string, to: string): TreasuryForecastEvent[] {
  const rows = db.prepare(
    `SELECT rt.id, rt.name, rt.voucher_json AS voucherJson, rt.cadence, rt.day_of_month AS dayOfMonth,
            rt.next_due AS nextDue, vt.kind
     FROM recurring_templates rt JOIN voucher_types vt ON vt.id = rt.voucher_type_id
     WHERE rt.active = 1 AND vt.kind IN ('payment','receipt')`
  ).all() as { id: number; name: string; voucherJson: string; cadence: 'weekly' | 'monthly'; dayOfMonth: number | null; nextDue: string; kind: 'payment' | 'receipt' }[]
  const events: TreasuryForecastEvent[] = []
  for (const row of rows) {
    const voucher = JSON.parse(row.voucherJson) as { lines?: { drCr: 'dr' | 'cr'; amount: number }[] }
    const amount = (voucher.lines ?? []).filter((line) => line.drCr === 'dr').reduce((sum, line) => sum + line.amount, 0)
    if (amount <= 0) continue
    let date = row.nextDue
    while (date < from) date = row.cadence === 'weekly' ? addDays(date, 7) : addMonth(date, row.dayOfMonth)
    while (date <= to) {
      events.push({ date, label: row.name, direction: row.kind === 'receipt' ? 'inflow' : 'outflow', amount, source: 'recurring', sourceId: row.id })
      date = row.cadence === 'weekly' ? addDays(date, 7) : addMonth(date, row.dayOfMonth)
    }
  }
  return events
}

function forecastEvents(db: DB, asOn: string, to: string, scenario: LiquidityScenario | null): TreasuryForecastEvent[] {
  const delayReceipts = scenario?.collectionDelayDays ?? 0
  const realizeBp = scenario?.collectionRealizationBp ?? 10000
  const delayPayments = scenario?.paymentDelayDays ?? 0
  const events: TreasuryForecastEvent[] = []
  for (const party of outstandings(db, 'receivable', asOn)) for (const bill of party.bills) {
    const date = addDays(bill.dueDate && bill.dueDate > asOn ? bill.dueDate : asOn, delayReceipts)
    const amount = Math.round((bill.pending * realizeBp) / 10000)
    if (date <= to && amount > 0) events.push({ date, label: party.name, direction: 'inflow', amount, source: 'receivable', sourceId: bill.voucherId })
  }
  for (const party of outstandings(db, 'payable', asOn)) for (const bill of party.bills) {
    const date = addDays(bill.dueDate && bill.dueDate > asOn ? bill.dueDate : asOn, delayPayments)
    if (date <= to) events.push({ date, label: party.name, direction: 'outflow', amount: bill.pending, source: 'payable', sourceId: bill.voucherId })
  }
  events.push(...recurringEvents(db, asOn, to))
  for (const event of scenario?.events ?? []) if (event.date >= asOn && event.date <= to) {
    events.push({ date: event.date, label: event.label, direction: event.direction, amount: event.amount, source: 'scenario', sourceId: scenario?.id ?? null })
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
}

export function forecast(db: DB, asOn: string, scenarioId?: number | null): TreasuryForecast {
  const scenario = scenarioId == null ? null : listScenarios(db).find((row) => row.id === scenarioId) ?? null
  if (scenarioId != null && !scenario) throw new Error('Liquidity scenario not found')
  const accounts = accountBalances(db, asOn)
  const openingLiquidity = accounts.reduce((sum, account) => sum + account.balance, 0)
  const to = addDays(asOn, 90)
  const events = forecastEvents(db, asOn, to, scenario)
  let closing = openingLiquidity
  const weeks = Array.from({ length: 13 }, (_, index) => {
    const from = addDays(asOn, index * 7)
    const weekTo = index === 12 ? to : addDays(from, 6)
    const rows = events.filter((event) => event.date >= from && event.date <= weekTo)
    const inflows = rows.filter((event) => event.direction === 'inflow').reduce((sum, event) => sum + event.amount, 0)
    const outflows = rows.filter((event) => event.direction === 'outflow').reduce((sum, event) => sum + event.amount, 0)
    closing += inflows - outflows
    return { week: index + 1, from, to: weekTo, inflows, outflows, net: inflows - outflows, closing, events: rows }
  })
  const lowest = weeks.reduce((best, week) => week.closing < best.closing ? week : best, weeks[0]!)
  return { asOn, scenarioId: scenario?.id ?? null, scenarioName: scenario?.name ?? 'Base case', accounts, openingLiquidity, weeks, lowestClosing: lowest.closing, lowestWeek: lowest.week }
}

export function dailyPosition(db: DB, asOn: string): DailyCashPosition {
  const full = forecast(db, asOn)
  const first = full.weeks[0]!
  return {
    asOn, horizonTo: first.to, accounts: full.accounts, availableNow: full.openingLiquidity,
    expectedReceipts: first.inflows, expectedPayments: first.outflows,
    projectedAvailable: first.closing, events: first.events
  }
}

export function getAlertSettings(db: DB): TreasuryAlertSettings {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
  if (!row) return { minimumLiquidity: 0, idleCashThreshold: 0, sustainedWeeks: 3 }
  try { return JSON.parse(row.value) as TreasuryAlertSettings } catch { return { minimumLiquidity: 0, idleCashThreshold: 0, sustainedWeeks: 3 } }
}

export function setAlertSettings(db: DB, settings: TreasuryAlertSettings): TreasuryAlertSettings {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

export function liquidityAlerts(db: DB, asOn: string, scenarioId?: number | null): TreasuryAlert[] {
  const settings = getAlertSettings(db)
  const result = forecast(db, asOn, scenarioId)
  const alerts: TreasuryAlert[] = []
  const runs = (predicate: (closing: number) => boolean): { first: number; length: number; extreme: number }[] => {
    const found: { first: number; length: number; extreme: number }[] = []
    let current: { first: number; length: number; extreme: number } | null = null
    for (const week of result.weeks) {
      if (predicate(week.closing)) {
        if (!current) current = { first: week.week, length: 0, extreme: week.closing }
        current.length++; current.extreme = week.closing
      } else if (current) { found.push(current); current = null }
    }
    if (current) found.push(current)
    return found
  }
  const shortfall = runs((closing) => closing < settings.minimumLiquidity)[0]
  if (shortfall) alerts.push({ kind: 'shortfall', title: 'Projected liquidity shortfall', detail: `Cash falls below the configured operating minimum in week ${shortfall.first}.`, amount: shortfall.extreme, firstWeek: shortfall.first, sustainedWeeks: shortfall.length })
  if (settings.idleCashThreshold > 0) {
    const idle = runs((closing) => closing > settings.idleCashThreshold).find((run) => run.length >= settings.sustainedWeeks)
    if (idle) alerts.push({ kind: 'idle_cash', title: 'Sustained excess cash', detail: `Projected cash remains above your internal threshold for ${idle.length} weeks. This is a planning alert, not investment advice.`, amount: idle.extreme, firstWeek: idle.first, sustainedWeeks: idle.length })
  }
  return alerts
}
