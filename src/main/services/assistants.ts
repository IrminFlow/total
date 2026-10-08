// The assistants (WP 5.5): month-end close checklist, GSTR-2B mismatch resolution and anomaly
// detection — deterministic services over the existing ones. Each gathers facts from the books at
// query time (voucher lines are the source of truth; every voucher query filters IN_BOOKS) and
// hands them to a pure engine (src/shared/closeChecklist.ts, anomalies.ts, gst/mismatch2b.ts).
// Only the user's decisions (assistant_marks) and the imported 2B statement (gst2b_statements)
// are stored, each change audited. The AI tools (src/main/ai/tools/assistantTools.ts) call these
// same functions, so the screen and the assistant always agree.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyOf, gstPeriodOf } from '@shared/dates'
import { formatQtyMilli } from '@shared/money'
import { buildCloseChecklist, missingRegulars, monthBounds, addMonths, type CloseChecklist, type CloseFacts, type CloseMark, type CloseCheckKey } from '@shared/closeChecklist'
import { findAnomalies, type AnomalyVoucher, type LedgerRole } from '@shared/anomalies'
import { categoriseMismatches, summariseMismatches, type Mismatch } from '@shared/gst/mismatch2b'
import { parseGstr2b, reconcile2b, recon2bOptionsFrom } from '@shared/gst/recon2b'
import {
  DEFAULT_ASSISTANT_SETTINGS, type AnomalyReport, type AnomalyRow, type AssistantKind, type AssistantSettings, type Gst2bMismatchReport, type Gst2bStatementInfo
} from '@shared/assistants'
import { IN_BOOKS, NOT_DELETED, NOT_YEAR_END_CLOSE, getLockDate } from './vouchers'
import { listGroups, listLedgers, descendantIdsByName } from './masters'
import { closingBalances, descendantIdSet, exceptions } from './reports'
import { outstandings, partyAllocation } from './analysis'
import { bankLedgers, brs } from './banking'
import { tdsEligible } from './tdsWorkbench'
import { negativeStock } from './stockAnalysis'
import { pendingStockNotes } from './tradeReports'
import { GDNI_PURPOSES, GRNI_PURPOSES } from './tradeAnalysis'
import { pdcRegisterFull } from './pdc'
import { yearStatus } from './fixedAssets'
import { extractPurchaseDocs } from './gst'
import { getRecon2bTolerances } from './gstIms'
import { writeAudit } from './audit'
import { listDrafts } from '../ai/store'

// ---------------------------------------------------------------- marks

export interface MarkRow {
  status: string
  note: string | null
  by: string | null
  at: string
}

export function listMarks(db: DB, assistant: AssistantKind, scope: string): Map<string, MarkRow> {
  const rows = db
    .prepare('SELECT item_key AS k, status, note, user_name AS by, at FROM assistant_marks WHERE assistant = ? AND scope = ?')
    .all(assistant, scope) as { k: string; status: string; note: string | null; by: string | null; at: string }[]
  return new Map(rows.map((r) => [r.k, { status: r.status, note: r.note, by: r.by, at: r.at }]))
}

/** Set or clear (status null) one mark; audited with the whole before / after. */
export function setMark(
  db: DB,
  m: { assistant: AssistantKind; scope: string; key: string; status: 'done' | 'na' | 'dismissed' | 'resolved' | null; note?: string | null },
  user: string | null
): MarkRow | null {
  return db.transaction(() => {
    const before = listMarks(db, m.assistant, m.scope).get(m.key) ?? null
    const rowIdOf = (): number | null =>
      (db.prepare('SELECT rowid AS id FROM assistant_marks WHERE assistant = ? AND scope = ? AND item_key = ?').get(m.assistant, m.scope, m.key) as { id: number } | undefined)?.id ?? null
    const beforeId = rowIdOf()
    if (m.status === null) {
      if (!before) return null
      db.prepare('DELETE FROM assistant_marks WHERE assistant = ? AND scope = ? AND item_key = ?').run(m.assistant, m.scope, m.key)
    } else {
      db.prepare(
        `INSERT INTO assistant_marks (assistant, scope, item_key, status, note, user_name, at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (assistant, scope, item_key) DO UPDATE SET status = excluded.status, note = excluded.note, user_name = excluded.user_name, at = excluded.at`
      ).run(m.assistant, m.scope, m.key, m.status, m.note?.trim() || null, user)
    }
    const after = m.status === null ? null : (listMarks(db, m.assistant, m.scope).get(m.key) ?? null)
    const rowId = rowIdOf() ?? beforeId ?? 0
    writeAudit(
      db,
      'assistant_mark',
      rowId,
      before && after ? 'update' : after ? 'create' : 'delete',
      before ? { assistant: m.assistant, scope: m.scope, key: m.key, ...before } : null,
      after ? { assistant: m.assistant, scope: m.scope, key: m.key, ...after } : null,
      { user: user ?? undefined }
    )
    return after
  })()
}

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = 'assistants'

export function getAssistantSettings(db: DB): AssistantSettings {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
  try {
    return { ...DEFAULT_ASSISTANT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<AssistantSettings>) : {}) }
  } catch {
    return { ...DEFAULT_ASSISTANT_SETTINGS }
  }
}

export function setAssistantSettings(db: DB, patch: Partial<AssistantSettings>): AssistantSettings {
  return db.transaction(() => {
    const before = getAssistantSettings(db)
    const after: AssistantSettings = { ...before, ...patch, holidays: [...new Set(patch.holidays ?? before.holidays)].sort(), weekendDays: [...new Set(patch.weekendDays ?? before.weekendDays)].sort() }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTINGS_KEY, JSON.stringify(after))
    writeAudit(db, 'assistant_settings', 0, 'update', before, after)
    return after
  })()
}

// ---------------------------------------------------------------- close checklist

type VRow = { voucherId: number; label: string; date: string; amount: number; ledgerId?: number; detail?: string }

const exceptionRows = (rows: { label: string; detail: string; voucherId?: number; amount?: number }[]): VRow[] =>
  rows.filter((r) => r.voucherId).map((r) => ({ voucherId: r.voucherId!, label: r.label, date: r.detail.slice(0, 10), amount: r.amount ?? 0 }))

/** Monthly net (dr − cr) per ledger in [from, to], P&L ledgers only (closing journals out). */
function monthlyNets(db: DB, ledgerIds: ReadonlySet<number>, from: string, to: string): Map<number, Map<string, number>> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, substr(v.date, 1, 7) AS ym, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       GROUP BY vl.ledger_id, ym`
    )
    .all(from, to) as { id: number; ym: string; net: number }[]
  const out = new Map<number, Map<string, number>>()
  for (const r of rows) {
    if (!ledgerIds.has(r.id)) continue
    const m = out.get(r.id) ?? new Map<string, number>()
    m.set(r.ym, r.net)
    out.set(r.id, m)
  }
  return out
}

export function closeFacts(db: DB, company: CompanyInfo, period: string, today: string): CloseFacts {
  const { from, to } = monthBounds(period)
  const groups = listGroups(db)
  const ledgers = listLedgers(db)
  const name = new Map(ledgers.map((l) => [l.id, l.name]))
  const balances = closingBalances(db, to)

  // Banking: book entries without a bank date as on the month end; statement lines not matched.
  const openLines = db.prepare(
    `SELECT l.date, l.description, l.deposit + l.withdrawal AS amount FROM bank_statement_lines l
     WHERE l.bank_ledger_id = ? AND l.date <= ? AND l.ignored_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM bank_statement_matches m JOIN vouchers v ON v.id = m.voucher_id WHERE m.statement_line_id = l.id AND ${IN_BOOKS})
     ORDER BY l.date, l.id`
  )
  const bank = bankLedgers(db).map((b) => {
    const r = brs(db, b.id, to)
    return {
      ledgerId: b.id,
      name: b.name,
      unreconciled: [...r.uncredited, ...r.unpresented].map((i) => ({ voucherId: i.voucherId, label: `${i.voucherType} ${i.number}`, date: i.date, amount: i.amount, detail: i.particulars })),
      openStatementLines: openLines.all(b.id, to) as { date: string; description: string; amount: number }[]
    }
  })

  // Parties: unallocated settlements and overdue bills (as on the month end).
  const partyGroups = descendantIdSet(groups, ['Sundry Debtors', 'Sundry Creditors'])
  const debtorGroups = descendantIdSet(groups, ['Sundry Debtors'])
  const used = new Set((db.prepare(`SELECT DISTINCT vl.ledger_id AS id FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE v.date <= ? AND ${IN_BOOKS}`).all(to) as { id: number }[]).map((r) => r.id))
  const unallocated: CloseFacts['unallocated'] = []
  for (const l of ledgers) {
    if (!partyGroups.has(l.groupId) || !used.has(l.id)) continue
    const a = partyAllocation(db, l.id, to)
    if (a.unappliedCredit > 0) unallocated.push({ ledgerId: l.id, name: l.name, side: debtorGroups.has(l.groupId) ? 'receivable' : 'payable', amount: a.unappliedCredit })
  }
  const overdue: CloseFacts['overdue'] = []
  for (const side of ['receivable', 'payable'] as const) {
    for (const p of outstandings(db, side, to)) {
      for (const b of p.bills) if (b.overdueDays > 0 && b.pending > 0) overdue.push({ ledgerId: p.ledgerId, name: p.name, side, voucherId: b.voucherId, bill: b.number, date: b.date, pending: b.pending, overdueDays: b.overdueDays })
    }
  }
  overdue.sort((a, b) => b.overdueDays - a.overdueDays || b.pending - a.pending)

  // GST: a return counts as prepared once its JSON was exported (gstAnnual snapshot meta keys).
  const snapAt = (form: 'gstr1' | 'gstr3b'): string | null => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`gst.exported.${form}.${gstPeriodOf(from)}`) as { value: string } | undefined
    try {
      return row ? ((JSON.parse(row.value) as { at?: string }).at ?? null) : null
    } catch {
      return null
    }
  }
  const gst = company.gstRegistrationType === 'regular' && company.gstin ? { gstr1ExportedAt: snapAt('gstr1'), gstr3bExportedAt: snapAt('gstr3b') } : null

  // TDS / TCS: credit balance left on the tagged payable ledgers at the month end.
  const withholding: CloseFacts['withholding'] = []
  for (const l of ledgers) {
    const kind = l.tdsPayableSectionId != null ? 'tds' : l.tcsPayableSectionId != null ? 'tcs' : null
    if (!kind) continue
    const bal = balances.get(l.id) ?? 0
    withholding.push({ kind, ledgerId: l.id, name: l.name, outstanding: bal < 0 ? -bal : 0 })
  }
  const withholdingMissed = tdsEligible(db, from, to).map((r) => ({
    voucherId: r.voucherId, label: `${r.partyName} — ${r.voucherNumber}`, date: r.date, amount: r.basePaise, ledgerId: r.partyLedgerId, detail: `section ${r.sectionCode}: TDS looks applicable but none was deducted`
  }))

  const negStock = negativeStock(db, to).map((s) => ({ itemId: s.stockItemId, name: s.name, qtyText: `${formatQtyMilli(s.closingQtyMilli)} ${s.unitSymbol}`.trim() }))

  // Unbilled goods: the same pending-note lines the year-end GRNI / GDNI warning totals.
  const unbilledMap = new Map<number, CloseFacts['unbilled'][number]>()
  for (const [stage, kind, purposes] of [['GDNI', 'delivery_note', GDNI_PURPOSES], ['GRNI', 'receipt_note', GRNI_PURPOSES]] as const) {
    for (const r of pendingStockNotes(db, kind, to)) {
      if (!(purposes as readonly string[]).includes(r.purpose)) continue
      const u = unbilledMap.get(r.voucherId) ?? { stage, voucherId: r.voucherId, label: `${stage === 'GDNI' ? 'Delivery challan' : 'GRN'} ${r.number}`, date: r.date, ledgerId: r.partyLedgerId ?? null, party: r.partyName ?? null, value: 0 }
      u.value += r.pendingValue
      unbilledMap.set(r.voucherId, u)
    }
  }

  const suspenseGroups = descendantIdSet(groups, ['Suspense A/c'])
  const suspense = ledgers.filter((l) => suspenseGroups.has(l.groupId) && (balances.get(l.id) ?? 0) !== 0).map((l) => ({ ledgerId: l.id, name: l.name, balance: balances.get(l.id)! }))

  const pdcs = pdcRegisterFull(db, today)
    .filter((p) => (p.status === 'pending' || p.status === 'due') && p.date <= to)
    .map((p) => ({ voucherId: p.voucherId, label: `${p.voucherTypeName} ${p.number}`, date: p.date, ledgerId: p.partyLedgerId ?? null, party: p.partyName ?? null, amount: p.amount, direction: p.direction }))

  const ys = yearStatus(db, fyOf(to).startYear)
  const depreciation = { assetsInService: ys.assetsInService, coveredThrough: ys.coveredThrough }

  // Regular P&L ledgers (indirect / direct expenses and incomes) with nothing this month.
  const pnlGroups = descendantIdsByName(db, ['Indirect Expenses', 'Direct Expenses', 'Indirect Incomes', 'Direct Incomes'])
  const pnlLedgers = new Set(ledgers.filter((l) => pnlGroups.has(l.groupId)).map((l) => l.id))
  const accruals = missingRegulars(period, monthlyNets(db, pnlLedgers, monthBounds(addMonths(period, -3)).from, to), name)

  const ex = exceptions(db, from, to)
  const section = (key: string): VRow[] => exceptionRows(ex.sections.find((s) => s.key === key)?.rows ?? [])

  const roundOff = (db
    .prepare(
      `SELECT v.id AS voucherId, vt.name || ' ' || v.number AS label, v.date, vl.amount
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN ledgers l ON l.id = vl.ledger_id
       WHERE lower(l.name) = 'round off' AND vl.amount > 100 AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as VRow[])

  const drafts = listDrafts(db, 'open').map((d) => ({ draftId: d.id, summary: d.summary, date: d.payload.date ?? null }))
  const optionalVouchers = db
    .prepare(
      `SELECT v.id AS voucherId, vt.name || ' ' || v.number AS label, v.date,
              COALESCE((SELECT SUM(amount) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr'), 0) AS amount
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ${NOT_DELETED} AND v.is_optional = 1 AND v.date BETWEEN ? AND ? ORDER BY v.date, v.id`
    )
    .all(from, to) as VRow[]

  return {
    bank,
    unallocated,
    overdue,
    gst,
    withholding,
    withholdingMissed,
    negativeStock: negStock,
    unbilled: [...unbilledMap.values()],
    suspense,
    pdcs,
    depreciation,
    accruals,
    blankNarration: section('missingNarration'),
    roundOff,
    unbalanced: section('unbalanced'),
    drafts,
    optionalVouchers,
    lockDate: getLockDate(db)
  }
}

export function closeChecklist(db: DB, company: CompanyInfo, period: string, today: string): CloseChecklist {
  const marks = new Map<string, CloseMark>()
  for (const [k, m] of listMarks(db, 'close', period)) if (m.status === 'done' || m.status === 'na') marks.set(k, { status: m.status, note: m.note, by: m.by, at: m.at })
  return buildCloseChecklist(closeFacts(db, company, period, today), { period, today }, marks)
}

export function markCloseCheck(db: DB, period: string, key: CloseCheckKey, status: 'done' | 'na' | null, note: string | null, user: string | null): MarkRow | null {
  return setMark(db, { assistant: 'close', scope: period, key, status, note }, user)
}

// ---------------------------------------------------------------- anomalies

/** The history window baselines are taken from: twelve months before `from`. */
export const ANOMALY_HISTORY_MONTHS = 12

export function anomalyInput(db: DB, from: string, to: string): { vouchers: AnomalyVoucher[]; historyFrom: string; ledgers: Map<number, { name: string; role: LedgerRole }> } {
  const historyFrom = `${addMonths(from.slice(0, 7), -ANOMALY_HISTORY_MONTHS)}-01`
  const groups = listGroups(db)
  const partyGroups = descendantIdSet(groups, ['Sundry Debtors', 'Sundry Creditors'])
  const cashBank = descendantIdSet(groups, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])
  const ledgers = new Map(
    listLedgers(db).map((l): [number, { name: string; role: LedgerRole }] => [
      l.id,
      { name: l.name, role: l.taxType || l.tdsPayableSectionId != null || l.tcsPayableSectionId != null ? 'tax' : cashBank.has(l.groupId) ? 'cashBank' : partyGroups.has(l.groupId) ? 'party' : 'other' }
    ])
  )
  const vs = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, vt.kind, vt.name AS typeName, v.number, v.party_ledger_id AS partyLedgerId, p.name AS partyName,
              v.narration, v.reference, substr(v.created_at, 1, 10) AS createdOn
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       ORDER BY v.date, v.id`
    )
    .all(historyFrom, to) as Omit<AnomalyVoucher, 'lines' | 'amount'>[]
  const lines = db
    .prepare(
      `SELECT vl.voucher_id AS v, vl.ledger_id AS ledgerId, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE} ORDER BY vl.voucher_id, vl.line_order, vl.id`
    )
    .all(historyFrom, to) as { v: number; ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  const gstIds = new Set((db.prepare('SELECT id FROM ledgers WHERE tax_type IS NOT NULL').all() as { id: number }[]).map((r) => r.id))
  const byVoucher = new Map<number, AnomalyVoucher['lines']>()
  for (const l of lines) {
    const list = byVoucher.get(l.v) ?? []
    list.push({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })
    byVoucher.set(l.v, list)
  }
  // GST rate check: the invoice ITEMS of the period's sales / purchases (wherever the goods moved).
  const stock = db
    .prepare(
      `SELECT il.voucher_id AS v, il.stock_item_id AS itemId, si.name AS itemName, si.hsn, si.gst_rate AS rate, il.amount
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN stock_items si ON si.id = il.stock_item_id
       WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { v: number; itemId: number; itemName: string; hsn: string | null; rate: number | null; amount: number }[]
  const stockBy = new Map<number, NonNullable<AnomalyVoucher['stockLines']>>()
  for (const s of stock) {
    const list = stockBy.get(s.v) ?? []
    list.push({ itemId: s.itemId, itemName: s.itemName, hsn: s.hsn, amount: s.amount, rateBp: s.rate == null ? null : Math.round(s.rate * 100) })
    stockBy.set(s.v, list)
  }
  const vouchers = vs.map((v) => {
    const ls = byVoucher.get(v.voucherId) ?? []
    const sl = stockBy.get(v.voucherId)
    const tax = sl ? ls.filter((l) => gstIds.has(l.ledgerId)).reduce((s, l) => s + l.amount, 0) : undefined
    return { ...v, amount: ls.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0), lines: ls, ...(sl ? { stockLines: sl, taxPaise: tax } : {}) }
  })
  return { vouchers, historyFrom, ledgers }
}

export function anomalies(db: DB, from: string, to: string, opts: { includeDismissed?: boolean } = {}): AnomalyReport {
  const settings = getAssistantSettings(db)
  const { vouchers, historyFrom, ledgers } = anomalyInput(db, from, to)
  const items = (db.prepare('SELECT id AS itemId, name, hsn, gst_rate AS rate FROM stock_items').all() as { itemId: number; name: string; hsn: string | null; rate: number | null }[]).map((i) => ({
    itemId: i.itemId, name: i.name, hsn: i.hsn, rateBp: i.rate == null ? null : Math.round(i.rate * 100)
  }))
  const closedPeriods = (db.prepare("SELECT scope, at FROM assistant_marks WHERE assistant = 'close' AND item_key = 'lock' AND status = 'done'").all() as { scope: string; at: string }[]).map((r) => ({
    period: r.scope, closedOn: r.at.slice(0, 10)
  }))
  const found = findAnomalies(
    { from, to, vouchers, ledgers, items },
    {
      duplicateWindowDays: settings.duplicateWindowDays,
      backdatedDays: settings.backdatedDays,
      roundMinPaise: settings.roundMinPaise,
      zThresholdMilli: settings.zThresholdMilli,
      weekendDays: settings.weekendDays,
      holidays: settings.holidays,
      lockDate: getLockDate(db),
      closedPeriods
    }
  )
  const dismissed = listMarks(db, 'anomaly', '')
  const all: AnomalyRow[] = found.map((a) => {
    const m = dismissed.get(a.key)
    return { ...a, dismissed: m ? { note: m.note, by: m.by, at: m.at } : null }
  })
  const rows = opts.includeDismissed ? all : all.filter((r) => !r.dismissed)
  const open = all.filter((r) => !r.dismissed)
  return {
    from,
    to,
    historyFrom,
    rows,
    counts: { high: open.filter((r) => r.severity === 'high').length, medium: open.filter((r) => r.severity === 'medium').length, low: open.filter((r) => r.severity === 'low').length, dismissed: all.length - open.length },
    settings
  }
}

export function dismissAnomaly(db: DB, key: string, dismissed: boolean, note: string | null, user: string | null): MarkRow | null {
  return setMark(db, { assistant: 'anomaly', scope: '', key, status: dismissed ? 'dismissed' : null, note }, user)
}

// ---------------------------------------------------------------- GSTR-2B

export function getStatement(db: DB, returnPeriod: string): (Gst2bStatementInfo & { jsonText: string }) | null {
  const r = db
    .prepare('SELECT period, file_name AS fileName, documents, imported_at AS importedAt, imported_by AS importedBy, json_text AS jsonText FROM gst2b_statements WHERE period = ?')
    .get(returnPeriod) as (Gst2bStatementInfo & { jsonText: string }) | undefined
  return r ?? null
}

/** Keep a GSTR-2B JSON for its return period (its rtnprd, else the month it was imported for). */
export function store2bStatement(db: DB, input: { jsonText: string; fileName?: string; period: string }, user: string | null): Gst2bStatementInfo {
  const parsed = parseGstr2b(input.jsonText)
  if (!parsed.invoices.length && parsed.errors.length) throw new Error(`Not a GSTR-2B JSON: ${parsed.errors[0]}`)
  const returnPeriod = parsed.period && /^(0[1-9]|1[0-2])\d{4}$/.test(parsed.period) ? parsed.period : gstPeriodOf(`${input.period}-01`)
  return db.transaction(() => {
    const before = getStatement(db, returnPeriod)
    db.prepare(
      `INSERT INTO gst2b_statements (period, file_name, json_text, documents, imported_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (period) DO UPDATE SET file_name = excluded.file_name, json_text = excluded.json_text, documents = excluded.documents,
         imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), imported_by = excluded.imported_by`
    ).run(returnPeriod, input.fileName ?? null, input.jsonText, parsed.invoices.length, user)
    const after = getStatement(db, returnPeriod)!
    const id = (db.prepare('SELECT id FROM gst2b_statements WHERE period = ?').get(returnPeriod) as { id: number }).id
    const strip = (s: (Gst2bStatementInfo & { jsonText: string }) | null): Gst2bStatementInfo | null => (s ? { period: s.period, fileName: s.fileName, documents: s.documents, importedAt: s.importedAt, importedBy: s.importedBy } : null)
    writeAudit(db, 'gst2b_statement', id, before ? 'update' : 'create', strip(before), strip(after), { user: user ?? undefined })
    return strip(after)!
  })()
}

/** The month (YYYY-MM) a MMYYYY return period stands for. */
const monthOfReturn = (rp: string): string => `${rp.slice(2)}-${rp.slice(0, 2)}`

export function gst2bMismatches(db: DB, period: string, opts: { includeResolved?: boolean } = {}): Gst2bMismatchReport {
  const { from, to } = monthBounds(period)
  const returnPeriod = gstPeriodOf(from)
  const st = getStatement(db, returnPeriod)
  const empty: Gst2bMismatchReport = { period, returnPeriod, statement: null, errors: [], matched: 0, summary: summariseMismatches([]), rows: [] }
  if (!st) return empty
  const parsed = parseGstr2b(st.jsonText)
  const tol = getRecon2bTolerances(db)
  const books = extractPurchaseDocs(db, from, to)
  const result = reconcile2b(parsed.invoices, books, recon2bOptionsFrom(tol))
  // Purchase documents of the months around this one tell "period differs" from "missing".
  const around = [
    ...extractPurchaseDocs(db, monthBounds(addMonths(period, -6)).from, monthBounds(addMonths(period, -1)).to),
    ...extractPurchaseDocs(db, monthBounds(addMonths(period, 1)).from, monthBounds(addMonths(period, 2)).to)
  ]
  const suppliers = listLedgers(db).map((l) => ({ ledgerId: l.id, name: l.name, gstin: l.gstin }))
  const list = categoriseMismatches(result, around, suppliers, { amountTolerancePaise: tol.amountPaise, amountTolerancePct: tol.amountPct })
  const marks = listMarks(db, 'gst2b', period)
  const rows: Mismatch[] = list.map((m) => {
    const mk = marks.get(m.key)
    return mk && (mk.status === 'resolved' || mk.status === 'dismissed') ? { ...m, resolved: { status: mk.status, note: mk.note, by: mk.by, at: mk.at } } : m
  })
  return {
    period,
    returnPeriod,
    statement: { period: st.period, fileName: st.fileName, documents: st.documents, importedAt: st.importedAt, importedBy: st.importedBy },
    errors: parsed.errors,
    matched: result.buckets.matched.count,
    summary: summariseMismatches(rows.filter((r) => !r.resolved)),
    rows: opts.includeResolved ? rows : rows.filter((r) => !r.resolved)
  }
}

export function resolve2bMismatch(db: DB, period: string, key: string, status: 'resolved' | 'dismissed' | null, note: string | null, user: string | null): MarkRow | null {
  return setMark(db, { assistant: 'gst2b', scope: period, key, status, note }, user)
}

export { monthOfReturn }
