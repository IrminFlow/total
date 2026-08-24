import type { DB } from '../db/connection'
import type { Voucher, VoucherKind } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { getLockDate, getVoucher, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import type { VoucherComment } from '@shared/voucherComments'

export interface ReverseVoucherInput {
  id: number
  date: string
  reason: string
  author: string
}

function reverseKind(kind: VoucherKind): VoucherKind {
  if (kind === 'sales') return 'credit_note'
  if (kind === 'purchase') return 'debit_note'
  if (kind === 'credit_note') return 'debit_note'
  if (kind === 'debit_note') return 'credit_note'
  return kind
}

function reversalTypeId(db: DB, voucherTypeId: number): number {
  const source = db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(voucherTypeId) as { kind: VoucherKind } | undefined
  if (!source) throw new Error('Voucher type not found')
  const targetKind = reverseKind(source.kind)
  if (targetKind === source.kind) return voucherTypeId
  const target = db
    .prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1')
    .get(targetKind) as { id: number } | undefined
  if (!target) throw new Error(`Create a ${targetKind.replace('_', ' ')} voucher type before reversing this entry`)
  return target.id
}

function assertReversible(db: DB, id: number, date: string): Voucher {
  const source = getVoucher(db, id)
  if (!source) throw new Error(`Voucher ${id} was not found`)
  if (source.deletedAt) throw new Error(`${source.number} is in the bin`)
  if (source.reversalOfId) throw new Error(`${source.number} is already a reversal`)
  if (source.reversedById) throw new Error(`${source.number} has already been reversed`)
  if (source.inventory.some((line) => line.isAbsolute)) {
    throw new Error(`${source.number} is a physical stock count; record a new count or stock adjustment instead`)
  }
  if (source.tds) {
    throw new Error(`${source.number} contains TDS; use a TDS adjustment so the statutory trail remains correct`)
  }
  if (date < source.date) throw new Error(`Reversal date cannot be before ${source.number} (${source.date})`)
  const lock = getLockDate(db)
  if (lock && date <= lock) throw new Error(`Books are locked up to ${lock}`)
  return source
}

function reversalDraft(db: DB, source: Voucher, date: string, reason: string): VoucherInputParsed {
  return {
    voucherTypeId: reversalTypeId(db, source.voucherTypeId),
    date,
    partyLedgerId: source.partyLedgerId,
    narration: `Reversal of ${source.number} — ${reason}`,
    reference: `Reversal of ${source.number}`,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    posOverride: source.posOverride,
    currencyCode: source.currencyCode,
    exchangeRate: source.exchangeRate,
    postDated: source.postDated,
    isOptional: source.isOptional,
    lines: source.lines.map((line) => ({
      ledgerId: line.ledgerId,
      drCr: line.drCr === 'dr' ? 'cr' : 'dr',
      amount: line.amount,
      costAllocations: line.costAllocations.map((allocation) => ({ ...allocation }))
    })),
    inventory: source.inventory.map((line) => ({
      stockItemId: line.stockItemId,
      godownId: line.godownId,
      batchId: line.batchId,
      qtyMilli: line.qtyMilli,
      ratePaise: line.ratePaise,
      discountPaise: line.discountPaise,
      amount: line.amount,
      direction: line.direction === 'in' ? 'out' : 'in',
      isAbsolute: false
    })),
    billRefs: source.billRefs.map((ref) => ({
      kind: ref.kind === 'new' ? 'against' : 'new',
      name: ref.name,
      amount: ref.amount,
      dueDate: ref.kind === 'against' ? ref.dueDate : null
    })),
    tds: null
  }
}

/** Create a real side-flipped voucher and permanently link it to its source. */
export function reverseVoucher(db: DB, input: ReverseVoucherInput): Voucher {
  const reason = input.reason.trim()
  const author = input.author.trim() || 'Local user'
  if (reason.length < 5) throw new Error('Enter a reversal reason of at least 5 characters')
  if (reason.length > 500) throw new Error('Reversal reason is too long')
  return db.transaction(() => {
    const source = assertReversible(db, input.id, input.date)
    const draft = reversalDraft(db, source, input.date, reason)
    const saved = saveVoucher(db, draft)
    db.prepare(
      `UPDATE vouchers SET reversal_of_id = ?, reversal_reason = ?, reversal_author = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(source.id, reason, author, saved.id)
    const reversal = getVoucher(db, saved.id)!
    writeAudit(db, 'voucher', source.id, 'update', { reversedById: null }, {
      reversedById: reversal.id,
      reversalReason: reason,
      reversalAuthor: author
    })
    return reversal
  })()
}

/** All-or-nothing batch: validation or save failure rolls every reversal and audit row back. */
export function reverseVouchers(db: DB, ids: number[], date: string, reason: string, author: string): Voucher[] {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new Error('The selection contains duplicate vouchers')
  for (const id of unique) assertReversible(db, id, date)
  return db.transaction(() => unique.map((id) => reverseVoucher(db, { id, date, reason, author })))()
}

function requireLiveVouchers(db: DB, ids: number[]): number[] {
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new Error('Select at least one voucher')
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id FROM vouchers WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...unique) as { id: number }[]
  if (rows.length !== unique.length) throw new Error('One or more selected vouchers no longer exist')
  return unique
}

export function tagVouchers(db: DB, ids: number[], rawTag: string, author: string): void {
  const tag = rawTag.trim().replace(/\s+/g, ' ')
  if (!tag || tag.length > 30) throw new Error('Tag must be between 1 and 30 characters')
  const unique = requireLiveVouchers(db, ids)
  const insert = db.prepare('INSERT OR IGNORE INTO voucher_tags (voucher_id, tag, created_by) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const id of unique) {
      const changed = insert.run(id, tag, author).changes > 0
      if (changed) writeAudit(db, 'voucher', id, 'update', null, { tagAdded: tag })
    }
  })()
}

export function reviewVouchers(db: DB, ids: number[], author: string): void {
  const unique = requireLiveVouchers(db, ids)
  const upsert = db.prepare(
    `INSERT INTO voucher_reviews (voucher_id, reviewed_by) VALUES (?, ?)
     ON CONFLICT(voucher_id) DO UPDATE SET reviewed_at = datetime('now'), reviewed_by = excluded.reviewed_by`
  )
  db.transaction(() => {
    for (const id of unique) {
      upsert.run(id, author)
      writeAudit(db, 'voucher', id, 'update', null, { reviewedBy: author })
    }
  })()
}

interface CommentRow { id: number; voucher_id: number; body: string; created_by: string; created_at: string }

function mapComment(row: CommentRow): VoucherComment {
  return { id: row.id, voucherId: row.voucher_id, body: row.body, createdBy: row.created_by, createdAt: row.created_at }
}

export function listVoucherComments(db: DB, voucherId: number): VoucherComment[] {
  requireLiveVouchers(db, [voucherId])
  return (db.prepare(
    'SELECT id, voucher_id, body, created_by, created_at FROM voucher_comments WHERE voucher_id = ? ORDER BY id'
  ).all(voucherId) as CommentRow[]).map(mapComment)
}

export function addVoucherComment(db: DB, voucherId: number, rawBody: string, author: string): VoucherComment {
  requireLiveVouchers(db, [voucherId])
  const body = rawBody.trim()
  if (!body || body.length > 2000) throw new Error('Comment must be between 1 and 2,000 characters')
  const id = Number(db.prepare(
    'INSERT INTO voucher_comments (voucher_id, body, created_by) VALUES (?, ?, ?)'
  ).run(voucherId, body, author.trim() || 'Local user').lastInsertRowid)
  writeAudit(db, 'voucher', voucherId, 'update', null, { commentAdded: id })
  const row = db.prepare(
    'SELECT id, voucher_id, body, created_by, created_at FROM voucher_comments WHERE id = ?'
  ).get(id) as CommentRow
  return mapComment(row)
}
