import type { DB } from '../db/connection'
import type { VoucherInputParsed } from '@shared/schemas'
import { voucherInputSchema } from '@shared/schemas'
import type { Voucher } from '@shared/domain'
import { saveVoucher } from './vouchers'
import { writeAudit } from './audit'

export interface ApprovalPolicy {
  enabled: boolean
  thresholdPaise: number | null
  voucherTypeIds: number[]
  expenseEnabled: boolean
  expenseThresholdPaise: number | null
}

export interface ApprovalRequest {
  id: number
  status: 'pending' | 'approved' | 'rejected'
  makerUserId: number
  makerName: string
  checkerUserId: number | null
  checkerName: string | null
  targetVoucherId: number | null
  postedVoucherId: number | null
  summary: string
  amount: number
  payload: VoucherInputParsed
  decisionNote: string | null
  createdAt: string
  reviewedAt: string | null
  requestKind: 'voucher' | 'expense'
  expenseLedgers: string[]
  departments: string[]
}

const DEFAULT_POLICY: ApprovalPolicy = { enabled: false, thresholdPaise: null, voucherTypeIds: [], expenseEnabled: false, expenseThresholdPaise: null }

export function getApprovalPolicy(db: DB): ApprovalPolicy {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'approval.policy'").get() as { value: string } | undefined
  if (!row) return DEFAULT_POLICY
  try {
    const value = JSON.parse(row.value) as Partial<ApprovalPolicy>
    return {
      enabled: value.enabled === true,
      thresholdPaise: Number.isInteger(value.thresholdPaise) && (value.thresholdPaise as number) >= 0 ? value.thresholdPaise as number : null,
      voucherTypeIds: Array.isArray(value.voucherTypeIds)
        ? [...new Set(value.voucherTypeIds.filter((id): id is number => Number.isInteger(id) && id > 0))]
        : [],
      expenseEnabled: value.expenseEnabled === true,
      expenseThresholdPaise: Number.isInteger(value.expenseThresholdPaise) && (value.expenseThresholdPaise as number) >= 0 ? value.expenseThresholdPaise as number : null
    }
  } catch {
    return DEFAULT_POLICY
  }
}

export function setApprovalPolicy(db: DB, policy: ApprovalPolicy): ApprovalPolicy {
  const normalized: ApprovalPolicy = {
    enabled: policy.enabled,
    thresholdPaise: policy.thresholdPaise,
    voucherTypeIds: [...new Set(policy.voucherTypeIds)].sort((a, b) => a - b),
    expenseEnabled: policy.expenseEnabled,
    expenseThresholdPaise: policy.expenseThresholdPaise
  }
  if (normalized.enabled || normalized.expenseEnabled) {
    const active = (db.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get() as { count: number }).count
    if (active < 2) throw new Error('Maker-checker requires at least two active users')
    if (normalized.enabled && normalized.thresholdPaise === null && normalized.voucherTypeIds.length === 0) {
      throw new Error('Choose an amount threshold or at least one voucher type')
    }
  }
  const before = getApprovalPolicy(db)
  db.prepare("INSERT INTO meta (key, value) VALUES ('approval.policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(normalized))
  writeAudit(db, 'approval_policy', 0, 'update', before, normalized)
  return normalized
}

export function voucherAmount(input: VoucherInputParsed): number {
  return input.lines.filter((line) => line.drCr === 'dr').reduce((sum, line) => sum + line.amount, 0)
}

export function requiresApproval(db: DB, input: VoucherInputParsed): boolean {
  const policy = getApprovalPolicy(db)
  const ordinary = policy.enabled && (policy.voucherTypeIds.includes(input.voucherTypeId) ||
    (policy.thresholdPaise !== null && voucherAmount(input) >= policy.thresholdPaise))
  const expense = policy.expenseEnabled && expenseContext(db, input).requestKind === 'expense' &&
    (policy.expenseThresholdPaise === null || voucherAmount(input) >= policy.expenseThresholdPaise)
  return ordinary || expense
}

function expenseContext(db: DB, input: VoucherInputParsed): Pick<ApprovalRequest, 'requestKind' | 'expenseLedgers' | 'departments'> {
  const kind=(db.prepare('SELECT kind FROM voucher_types WHERE id=?').get(input.voucherTypeId) as {kind:string}|undefined)?.kind
  if (!['payment','journal'].includes(kind ?? '')) return {requestKind:'voucher',expenseLedgers:[],departments:[]}
  const ledgerInfo=db.prepare('SELECT l.name,g.nature FROM ledgers l JOIN groups g ON g.id=l.group_id WHERE l.id=?')
  const expenseLedgers=[...new Set(input.lines.filter((line)=>line.drCr==='dr').flatMap((line)=>{const info=ledgerInfo.get(line.ledgerId) as {name:string;nature:string}|undefined;return info?.nature==='expense'?[info.name]:[]}))]
  if(!expenseLedgers.length)return {requestKind:'voucher',expenseLedgers:[],departments:[]}
  const ids=[...new Set(input.lines.flatMap((line)=>line.costAllocations.map((allocation)=>allocation.costCentreId)))]
  const departments=ids.length?(db.prepare(`SELECT name FROM cost_centres WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY name`).all(...ids) as {name:string}[]).map((row)=>row.name):[]
  return {requestKind:'expense',expenseLedgers,departments}
}

/** Exercise the exact posting path, including stock/credit/period controls, inside a savepoint
 * that is always rolled back. A proposal accepted here can still fail later if books change. */
function validateWithoutPosting(db: DB, input: VoucherInputParsed, targetVoucherId?: number): void {
  const rollback = Symbol('validated')
  const dryRun = db.transaction(() => {
    saveVoucher(db, input, targetVoucherId)
    throw rollback
  })
  try {
    dryRun()
  } catch (error) {
    if (error !== rollback) throw error
  }
}

export function createApprovalRequest(
  db: DB,
  input: VoucherInputParsed,
  maker: { id: number; name: string },
  targetVoucherId?: number
): ApprovalRequest {
  validateWithoutPosting(db, input, targetVoucherId)
  const vt = db.prepare('SELECT name FROM voucher_types WHERE id = ?').get(input.voucherTypeId) as { name: string }
  const amount = voucherAmount(input)
  const context=expenseContext(db,input)
  const summary = context.requestKind==='expense' ? `Expense · ${context.expenseLedgers.join(', ')} · ${input.date}` : `${targetVoucherId ? 'Alter' : 'Create'} ${vt.name} · ${input.date}`
  const result = db.prepare(
    `INSERT INTO approval_requests
      (maker_user_id, maker_name, target_voucher_id, summary, amount, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(maker.id, maker.name, targetVoucherId ?? null, summary, amount, JSON.stringify(input))
  const request = getApprovalRequest(db, Number(result.lastInsertRowid))
  writeAudit(db, 'approval_request', request.id, 'create', null, { ...request, payload: '[validated voucher payload]' })
  return request
}

export function getApprovalRequest(db: DB, id: number): ApprovalRequest {
  const row = db.prepare(
    `SELECT id, status, maker_user_id AS makerUserId, maker_name AS makerName,
      checker_user_id AS checkerUserId, checker_name AS checkerName,
      target_voucher_id AS targetVoucherId, posted_voucher_id AS postedVoucherId,
      summary, amount, payload_json AS payloadJson, decision_note AS decisionNote,
      created_at AS createdAt, reviewed_at AS reviewedAt
     FROM approval_requests WHERE id = ?`
  ).get(id) as (Omit<ApprovalRequest, 'payload'> & { payloadJson: string }) | undefined
  if (!row) throw new Error('Approval request not found')
  const { payloadJson, ...rest } = row
  const payload=voucherInputSchema.parse(JSON.parse(payloadJson))
  return { ...rest, payload, ...expenseContext(db,payload) }
}

export function listApprovalRequests(db: DB, status: ApprovalRequest['status'] = 'pending'): ApprovalRequest[] {
  const ids = db.prepare('SELECT id FROM approval_requests WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 200')
    .all(status) as { id: number }[]
  return ids.map(({ id }) => getApprovalRequest(db, id))
}

export function approveRequest(db: DB, id: number, checker: { id: number; name: string }, note: string | null): Voucher {
  return db.transaction(() => {
    const request = getApprovalRequest(db, id)
    if (request.status !== 'pending') throw new Error('Approval request is no longer pending')
    if (request.makerUserId === checker.id) throw new Error('Maker and checker must be different users')
    const saved = saveVoucher(db, request.payload, request.targetVoucherId ?? undefined)
    db.prepare(
      `UPDATE approval_requests SET status = 'approved', checker_user_id = ?, checker_name = ?,
       posted_voucher_id = ?, decision_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ).run(checker.id, checker.name, saved.id, note, id)
    const recurringLink = db.prepare(
      `SELECT recurring_template_id AS templateId, occurrence_date AS occurrenceDate,
              next_due AS nextDue
       FROM recurring_approval_links WHERE approval_request_id = ?`
    ).get(id) as { templateId: number; occurrenceDate: string; nextDue: string } | undefined
    if (recurringLink) {
      db.prepare(
        `UPDATE recurring_templates SET last_posted = ?, next_due = ? WHERE id = ?`
      ).run(request.payload.date, recurringLink.nextDue, recurringLink.templateId)
    }
    writeAudit(db, 'approval_request', id, 'update', { status: 'pending', maker: request.makerName }, {
      status: 'approved', checker: checker.name, postedVoucherId: saved.id, note
    })
    return saved
  })()
}

export function rejectRequest(db: DB, id: number, checker: { id: number; name: string }, note: string): void {
  db.transaction(() => {
    const request = getApprovalRequest(db, id)
    if (request.status !== 'pending') throw new Error('Approval request is no longer pending')
    if (request.makerUserId === checker.id) throw new Error('Maker and checker must be different users')
    db.prepare(
      `UPDATE approval_requests SET status = 'rejected', checker_user_id = ?, checker_name = ?,
       decision_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ).run(checker.id, checker.name, note, id)
    db.prepare('DELETE FROM recurring_approval_links WHERE approval_request_id = ?').run(id)
    writeAudit(db, 'approval_request', id, 'update', { status: 'pending', maker: request.makerName }, {
      status: 'rejected', checker: checker.name, note
    })
  })()
}
