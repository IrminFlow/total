import type { DB } from '../db/connection'
import type { CollectionCustomerSettings, CollectionCustomerWorkspace, CollectionPromise, CollectionQueueRow, CollectionTimelineItem, ReceiptSuggestion } from '@shared/collections'
import { outstandings } from './analysis'
import { writeAudit } from './audit'
import { descendantIdsByName } from './masters'

interface PromiseRow {
  id: number; ledger_id: number; amount: number; promised_date: string; owner: string; note: string | null
  status: CollectionPromise['status']; outcome_note: string | null; created_at: string; resolved_at: string | null
}

function mapPromise(row: PromiseRow): CollectionPromise {
  return { id: row.id, ledgerId: row.ledger_id, amount: row.amount, promisedDate: row.promised_date, owner: row.owner, note: row.note, status: row.status, outcomeNote: row.outcome_note, createdAt: row.created_at, resolvedAt: row.resolved_at }
}

export function listPromises(db: DB, ledgerId?: number): CollectionPromise[] {
  const rows = (ledgerId
    ? db.prepare('SELECT * FROM collection_promises WHERE ledger_id = ? ORDER BY promised_date DESC, id DESC').all(ledgerId)
    : db.prepare('SELECT * FROM collection_promises ORDER BY promised_date DESC, id DESC').all()) as PromiseRow[]
  return rows.map(mapPromise)
}

export function savePromise(db: DB, input: { ledgerId: number; amount: number; promisedDate: string; owner: string; note: string | null }): CollectionPromise {
  const party = db.prepare('SELECT id, group_id AS groupId FROM ledgers WHERE id = ?').get(input.ledgerId) as { id: number; groupId: number } | undefined
  if (!party || !descendantIdsByName(db, ['Sundry Debtors']).has(party.groupId)) throw new Error('Debtor ledger not found')
  if (listPromises(db, input.ledgerId).some((promise) => promise.status === 'pending')) throw new Error('Resolve the active promise before recording another')
  const result = db.prepare('INSERT INTO collection_promises (ledger_id, amount, promised_date, owner, note) VALUES (?, ?, ?, ?, ?)')
    .run(input.ledgerId, input.amount, input.promisedDate, input.owner.trim(), input.note?.trim() || null)
  const promise = listPromises(db, input.ledgerId).find((row) => row.id === Number(result.lastInsertRowid))!
  writeAudit(db, 'collection_promise', promise.id, 'create', null, promise)
  return promise
}

export function resolvePromise(db: DB, id: number, status: 'kept' | 'broken' | 'cancelled', outcomeNote: string | null): CollectionPromise {
  const before = listPromises(db).find((row) => row.id === id)
  if (!before) throw new Error('Promise not found')
  if (before.status !== 'pending') throw new Error('Promise has already been resolved')
  db.prepare("UPDATE collection_promises SET status = ?, outcome_note = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(status, outcomeNote?.trim() || null, id)
  const after = listPromises(db).find((row) => row.id === id)!
  writeAudit(db, 'collection_promise', id, 'update', before, after)
  return after
}

export function collectionQueue(db: DB, asOn: string): CollectionQueueRow[] {
  const promises = listPromises(db)
  return outstandings(db, 'receivable', asOn).map((party) => {
    const overdueBills = party.bills.filter((bill) => bill.overdueDays > 0)
    const overdueAmount = overdueBills.reduce((sum, bill) => sum + bill.pending, 0)
    const oldestOverdueDays = overdueBills.reduce((max, bill) => Math.max(max, bill.overdueDays), 0)
    const partyPromises = promises.filter((promise) => promise.ledgerId === party.ledgerId)
    const brokenPromises = partyPromises.filter((promise) => promise.status === 'broken').length
    const nextPromise = partyPromises.filter((promise) => promise.status === 'pending').sort((a, b) => a.promisedDate.localeCompare(b.promisedDate))[0] ?? null
    const promiseOverdue = !!nextPromise && nextPromise.promisedDate < asOn
    const priorityScore = overdueAmount + oldestOverdueDays * 10_000 + brokenPromises * 500_000 + (promiseOverdue ? 1_000_000 : 0)
    const priority: CollectionQueueRow['priority'] = promiseOverdue || oldestOverdueDays > 90 || brokenPromises > 0 ? 'critical' : oldestOverdueDays > 30 || overdueAmount > 500_000 ? 'high' : 'normal'
    const reason = promiseOverdue ? 'Promised date missed' : brokenPromises ? `${brokenPromises} broken promise${brokenPromises === 1 ? '' : 's'}` : oldestOverdueDays ? `${oldestOverdueDays} days past oldest due date` : 'Not yet overdue'
    return { ledgerId: party.ledgerId, name: party.name, pending: party.pending, overdueAmount, oldestOverdueDays, brokenPromises, priorityScore, priority, reason, nextPromise, bills: party.bills }
  }).sort((a, b) => b.priorityScore - a.priorityScore || b.pending - a.pending || a.name.localeCompare(b.name))
}

function addDays(date: string, days: number): string { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
function party(db: DB, ledgerId: number): { id: number; name: string } {
  const row = db.prepare('SELECT id,name,group_id AS groupId FROM ledgers WHERE id=?').get(ledgerId) as { id: number; name: string; groupId: number } | undefined
  if (!row || !descendantIdsByName(db, ['Sundry Debtors']).has(row.groupId)) throw new Error('Customer ledger not found')
  return row
}

export function customerSettings(db: DB, ledgerId: number): CollectionCustomerSettings {
  party(db, ledgerId)
  const row = db.prepare('SELECT owner,reminder_days AS reminderDays,early_discount_bps AS earlyDiscountBps,early_days AS earlyDays FROM collection_customer_settings WHERE ledger_id=?').get(ledgerId) as { owner: string; reminderDays: string; earlyDiscountBps: number; earlyDays: number } | undefined
  return row ? { owner: row.owner, reminderDays: row.reminderDays.split(',').map(Number).filter((day) => Number.isInteger(day) && day > 0), earlyDiscountBps: row.earlyDiscountBps, earlyDays: row.earlyDays } : { owner: '', reminderDays: [7, 14, 30], earlyDiscountBps: 0, earlyDays: 0 }
}

export function saveCustomerSettings(db: DB, ledgerId: number, input: CollectionCustomerSettings, actor: string): CollectionCustomerSettings {
  party(db, ledgerId)
  const reminderDays = [...new Set(input.reminderDays)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 365).sort((a, b) => a - b).slice(0, 12)
  if (!reminderDays.length) throw new Error('Enter at least one reminder day')
  const before = customerSettings(db, ledgerId)
  db.prepare(`INSERT INTO collection_customer_settings(ledger_id,owner,reminder_days,early_discount_bps,early_days,updated_by) VALUES(?,?,?,?,?,?)
    ON CONFLICT(ledger_id) DO UPDATE SET owner=excluded.owner,reminder_days=excluded.reminder_days,early_discount_bps=excluded.early_discount_bps,early_days=excluded.early_days,updated_by=excluded.updated_by,updated_at=datetime('now')`)
    .run(ledgerId, input.owner.trim(), reminderDays.join(','), input.earlyDiscountBps, input.earlyDays, actor)
  const after = customerSettings(db, ledgerId); writeAudit(db, 'collection_settings', ledgerId, 'update', before, after); return after
}

function monthEnds(asOn: string, count: number): string[] {
  const result: string[] = []
  const anchor = new Date(`${asOn}T00:00:00Z`)
  for (let offset = count - 1; offset >= 0; offset--) {
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - offset + 1, 0))
    result.push(end.toISOString().slice(0, 10) > asOn ? asOn : end.toISOString().slice(0, 10))
  }
  return [...new Set(result)]
}

function creditSales(db: DB, ledgerId: number | null, from: string, to: string): number {
  const clause = ledgerId == null ? '' : ' AND v.party_ledger_id=?'
  const params = ledgerId == null ? [from, to] : [from, to, ledgerId]
  const row = db.prepare(`SELECT COALESCE(SUM(vl.amount),0) AS amount FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id JOIN voucher_lines vl ON vl.voucher_id=v.id AND vl.ledger_id=v.party_ledger_id WHERE vt.kind='sales' AND v.deleted_at IS NULL AND v.is_optional=0 AND v.date BETWEEN ? AND ?${clause}`).get(...params) as { amount: number }
  return row.amount
}

export function customerWorkspace(db: DB, ledgerId: number, asOn: string): CollectionCustomerWorkspace {
  const customer = party(db, ledgerId)
  const settings = customerSettings(db, ledgerId)
  const receivables = outstandings(db, 'receivable', asOn)
  const current = receivables.find((row) => row.ledgerId === ledgerId)
  const bills = current?.bills ?? []
  const disputes = db.prepare(`SELECT id,voucher_id AS voucherId,reason,owner,status,resolution,created_at AS createdAt FROM collection_disputes WHERE ledger_id=? ORDER BY created_at DESC,id DESC`).all(ledgerId) as CollectionCustomerWorkspace['disputes']
  const openDisputedVoucherIds = new Set(disputes.filter((row) => row.status === 'open').map((row) => row.voucherId))
  const voucherItems = db.prepare(`SELECT v.id,v.date AS at,vt.kind,v.number,v.narration,MAX(vl.amount) AS amount FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id JOIN voucher_lines vl ON vl.voucher_id=v.id WHERE v.deleted_at IS NULL AND v.date<=? AND (v.party_ledger_id=? OR vl.ledger_id=?) AND vt.kind IN ('sales','receipt','credit_note') GROUP BY v.id ORDER BY v.date DESC,v.id DESC LIMIT 300`).all(asOn, ledgerId, ledgerId) as { id: number; at: string; kind: 'sales' | 'receipt' | 'credit_note'; number: string; narration: string | null; amount: number }[]
  const timeline: CollectionTimelineItem[] = voucherItems.map((row) => ({ id: `voucher-${row.id}`, at: row.at, kind: row.kind === 'sales' ? 'invoice' : row.kind, title: `${row.kind === 'sales' ? 'Invoice' : row.kind === 'receipt' ? 'Receipt' : 'Credit note'} ${row.number}`, detail: row.narration ?? '', amount: row.amount, voucherId: row.id, status: openDisputedVoucherIds.has(row.id) ? 'disputed' : null }))
  for (const promise of listPromises(db, ledgerId)) timeline.push({ id: `promise-${promise.id}`, at: promise.createdAt.slice(0, 10), kind: 'promise', title: `Promise ${promise.status}`, detail: `${promise.owner}${promise.note ? ` · ${promise.note}` : ''}`, amount: promise.amount, voucherId: null, status: promise.status })
  const reminders = db.prepare('SELECT id,voucher_id AS voucherId,channel,status,body,due_date AS dueDate,created_at AS createdAt FROM collection_reminders WHERE ledger_id=?').all(ledgerId) as { id: number; voucherId: number | null; channel: string; status: string; body: string; dueDate: string; createdAt: string }[]
  for (const row of reminders) timeline.push({ id: `reminder-${row.id}`, at: row.createdAt.slice(0, 10), kind: 'reminder', title: `${row.channel} reminder ${row.status}`, detail: row.body, amount: null, voucherId: row.voucherId, status: row.status })
  for (const row of disputes) timeline.push({ id: `dispute-${row.id}`, at: row.createdAt.slice(0, 10), kind: 'dispute', title: `Dispute ${row.status}`, detail: row.reason, amount: null, voucherId: row.voucherId, status: row.status })
  const notes = db.prepare('SELECT id,body,created_by AS createdBy,created_at AS createdAt FROM collection_notes WHERE ledger_id=?').all(ledgerId) as { id: number; body: string; createdBy: string; createdAt: string }[]
  for (const row of notes) timeline.push({ id: `note-${row.id}`, at: row.createdAt.slice(0, 10), kind: 'note', title: `Note · ${row.createdBy}`, detail: row.body, amount: null, voucherId: null, status: null })
  timeline.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))

  const ageingTrend = monthEnds(asOn, 6).map((date) => {
    const row = outstandings(db, 'receivable', date).find((item) => item.ledgerId === ledgerId)
    return { asOn: date, buckets: row?.buckets ?? [0, 0, 0, 0] as [number, number, number, number], pending: row?.pending ?? 0 }
  })
  const start = addDays(asOn, -89)
  const customerCreditSales = creditSales(db, ledgerId, start, asOn)
  const companyCreditSales = creditSales(db, null, start, asOn)
  const customerReceivable = current?.pending ?? 0
  const companyReceivable = receivables.reduce((sum, row) => sum + row.pending, 0)
  const customerDays = customerCreditSales > 0 ? Math.round(customerReceivable * 90 / customerCreditSales) : null
  const companyDays = companyCreditSales > 0 ? Math.round(companyReceivable * 90 / companyCreditSales) : null
  const broken = listPromises(db, ledgerId).filter((row) => row.status === 'broken').length
  const oldest = bills.reduce((max, bill) => Math.max(max, bill.overdueDays), 0)
  let score = Math.min(50, Math.floor(oldest / 2)) + Math.min(25, broken * 10) + Math.min(25, openDisputedVoucherIds.size * 10)
  const reasons: string[] = []
  if (oldest > 0) reasons.push(`Oldest invoice is ${oldest} days overdue`)
  if (broken) reasons.push(`${broken} broken payment promise${broken === 1 ? '' : 's'}`)
  if (openDisputedVoucherIds.size) reasons.push(`${openDisputedVoucherIds.size} open dispute${openDisputedVoucherIds.size === 1 ? '' : 's'}`)
  if (!reasons.length) reasons.push('No overdue, dispute or broken-promise signal')
  const band = score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low'
  const discountAmount = settings.earlyDiscountBps ? Math.round(customerReceivable * settings.earlyDiscountBps / 10_000) : 0
  const annualizedCostBps = settings.earlyDiscountBps > 0 && settings.earlyDays > 0 && settings.earlyDiscountBps < 10_000 ? Math.round(settings.earlyDiscountBps * 365 * 10_000 / ((10_000 - settings.earlyDiscountBps) * settings.earlyDays)) : null
  const observed = db.prepare(`SELECT CAST(ROUND(AVG(MAX(0,julianday(pay.date)-julianday(COALESCE(orig.due_date,inv.date))))) AS INTEGER) AS days FROM bill_refs payref JOIN vouchers pay ON pay.id=payref.voucher_id JOIN bill_refs orig ON orig.party_ledger_id=payref.party_ledger_id AND orig.name=payref.name AND orig.kind='new' JOIN vouchers inv ON inv.id=orig.voucher_id WHERE payref.party_ledger_id=? AND payref.kind='against' AND pay.date<=?`).get(ledgerId, asOn) as { days: number | null }
  const behaviorDays = Math.max(0, Math.min(90, observed.days ?? 0))
  const pendingPromise = listPromises(db, ledgerId).find((row) => row.status === 'pending')
  let promisedRemaining = Math.min(current?.pending ?? 0, pendingPromise?.amount ?? 0)
  const forecast: CollectionCustomerWorkspace['forecast'] = []
  if (pendingPromise && promisedRemaining) forecast.push({ date: pendingPromise.promisedDate, amount: promisedRemaining, source: 'promise', voucherId: null, label: `Promise by ${pendingPromise.owner}` })
  for (const bill of bills) {
    const amount = Math.max(0, bill.pending - promisedRemaining); promisedRemaining = Math.max(0, promisedRemaining - bill.pending)
    if (!amount) continue
    const base = bill.dueDate ?? bill.date
    forecast.push({ date: addDays(base, behaviorDays), amount, source: behaviorDays ? 'behavior' : 'due_date', voucherId: bill.voucherId, label: bill.number })
  }
  const existingReminderKeys = new Set(reminders.map((row) => `${row.voucherId ?? 0}|${row.dueDate}`))
  const remindersDue = bills.flatMap((bill) => settings.reminderDays.flatMap((cadenceDay) => {
    const due = addDays(bill.dueDate ?? bill.date, cadenceDay)
    return bill.overdueDays >= cadenceDay && !openDisputedVoucherIds.has(bill.voucherId ?? 0) && !existingReminderKeys.has(`${bill.voucherId ?? 0}|${due}`) ? [{ voucherId: bill.voucherId, billNumber: bill.number, overdueDays: bill.overdueDays, cadenceDay }] : []
  }))
  return { ledgerId, name: customer.name, settings, timeline, disputes, ageingTrend, dso: { customerDays, companyDays, periodDays: 90, customerCreditSales, companyCreditSales, customerReceivable, companyReceivable }, risk: { band, score, reasons }, earlyPayment: { discountAmount, payAmount: Math.max(0, customerReceivable - discountAmount), expiresOn: settings.earlyDays ? addDays(asOn, settings.earlyDays) : null, annualizedCostBps }, forecast: forecast.sort((a, b) => a.date.localeCompare(b.date)), remindersDue }
}

export function openDispute(db: DB, ledgerId: number, voucherId: number, reason: string, owner: string): void {
  party(db, ledgerId); if (!db.prepare('SELECT 1 FROM vouchers WHERE id=? AND party_ledger_id=?').get(voucherId, ledgerId)) throw new Error('Customer invoice was not found')
  const result = db.prepare('INSERT INTO collection_disputes(voucher_id,ledger_id,reason,owner) VALUES(?,?,?,?)').run(voucherId, ledgerId, reason.trim(), owner.trim())
  writeAudit(db, 'collection_dispute', Number(result.lastInsertRowid), 'create', null, { voucherId, ledgerId, reason, owner })
}
export function resolveDispute(db: DB, id: number, resolution: string): void { const before = db.prepare('SELECT * FROM collection_disputes WHERE id=?').get(id); if (!before) throw new Error('Dispute not found'); db.prepare("UPDATE collection_disputes SET status='resolved',resolution=?,resolved_at=datetime('now') WHERE id=? AND status='open'").run(resolution.trim(), id); writeAudit(db, 'collection_dispute', id, 'update', before, { status: 'resolved', resolution }) }
export function addCollectionNote(db: DB, ledgerId: number, body: string, actor: string): void { party(db, ledgerId); const result = db.prepare('INSERT INTO collection_notes(ledger_id,body,created_by) VALUES(?,?,?)').run(ledgerId, body.trim(), actor); writeAudit(db, 'collection_note', Number(result.lastInsertRowid), 'create', null, { ledgerId, body }) }
export function draftReminder(db: DB, ledgerId: number, voucherId: number | null, channel: 'email' | 'whatsapp' | 'phone', body: string, dueDate: string, actor: string): void { party(db, ledgerId); const result = db.prepare('INSERT INTO collection_reminders(ledger_id,voucher_id,channel,body,due_date,created_by) VALUES(?,?,?,?,?,?)').run(ledgerId, voucherId, channel, body.trim(), dueDate, actor); writeAudit(db, 'collection_reminder', Number(result.lastInsertRowid), 'create', null, { ledgerId, voucherId, channel, dueDate }) }

export function receiptSuggestions(db: DB, input: { amount: number; date: string; reference: string; payer: string }): ReceiptSuggestion[] {
  const reference = input.reference.trim().toLowerCase(), payer = input.payer.trim().toLowerCase()
  return outstandings(db, 'receivable', input.date).flatMap((customer) => customer.bills.map((bill) => {
    let score = 0; const reasons: string[] = []
    if (bill.pending === input.amount) { score += 70; reasons.push('Exact open amount') }
    else { const difference = Math.abs(bill.pending - input.amount); if (difference <= Math.max(100, Math.round(input.amount * 0.02))) { score += 40; reasons.push('Amount within 2%') } }
    if (reference && bill.number.toLowerCase().includes(reference)) { score += 25; reasons.push('Reference matches invoice') }
    if (payer && customer.name.toLowerCase().includes(payer)) { score += 20; reasons.push('Payer name matches customer') }
    if (bill.dueDate && Math.abs((new Date(`${input.date}T00:00:00Z`).getTime() - new Date(`${bill.dueDate}T00:00:00Z`).getTime()) / 86_400_000) <= 14) { score += 5; reasons.push('Near due date') }
    return { voucherId: bill.voucherId, billNumber: bill.number, partyLedgerId: customer.ledgerId, partyName: customer.name, pending: bill.pending, dueDate: bill.dueDate, score, reasons }
  })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || Math.abs(a.pending - input.amount) - Math.abs(b.pending - input.amount)).slice(0, 20)
}

export function ownerWorkload(db: DB, asOn: string): { owner: string; customers: number; overdue: number; followUpsDue: number; collected90Days: number }[] {
  const rows = collectionQueue(db, asOn); const byOwner = new Map<string, { owner: string; customers: number; overdue: number; followUpsDue: number; collected90Days: number }>()
  for (const row of rows) { const owner = customerSettings(db, row.ledgerId).owner || 'Unassigned'; const current = byOwner.get(owner) ?? { owner, customers: 0, overdue: 0, followUpsDue: 0, collected90Days: 0 }; current.customers += 1; current.overdue += row.overdueAmount; if (!row.nextPromise || row.nextPromise.promisedDate <= asOn) current.followUpsDue += 1; byOwner.set(owner, current) }
  for (const current of byOwner.values()) { const ids = rows.filter((row) => (customerSettings(db, row.ledgerId).owner || 'Unassigned') === current.owner).map((row) => row.ledgerId); if (ids.length) current.collected90Days = (db.prepare(`SELECT COALESCE(SUM(vl.amount),0) AS amount FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id JOIN voucher_lines vl ON vl.voucher_id=v.id WHERE vt.kind='receipt' AND v.deleted_at IS NULL AND v.date BETWEEN ? AND ? AND vl.ledger_id IN (${ids.map(() => '?').join(',')})`).get(addDays(asOn, -89), asOn, ...ids) as { amount: number }).amount }
  return [...byOwner.values()].sort((a, b) => b.overdue - a.overdue)
}
