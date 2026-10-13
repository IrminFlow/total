// Grouped undo and the save card's figures (WP 8.5, plan 2026-10-13 §1.6).
//
// Undo moves the vouchers a save just made to the bin as ONE group (undo_groups, the last
// migration): each through deleteVoucher, so the bin's own rules apply unchanged (lock date,
// live trade links, a forex revaluation's partner). It is offered only while every voucher is
// untouched since its save — its newest 'voucher' audit row is still the 'create' — so anything
// edited, binned and restored, or matured since says "Edit instead". It never re-opens a closed
// year: a closing entry is refused, and so is a voucher whose financial year was closed after it
// was saved. Restoring any member from the bin restores the whole group (restoreFromBin); a
// voucher outside a group restores exactly as before.

import type { DB } from '../db/connection'
import type { SaveCardEntry, SaveCardParty, SaveSummary, UndoState } from '@shared/simple/saveCard'
import { AppError } from '@shared/errors'
import { fyOf, todayISO } from '@shared/dates'
import { writeAudit } from './audit'
import { deleteVoucher, getLockDate, getVoucher, lockedError, NOT_DELETED, restoreVoucher } from './vouchers'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { partyAllocation } from './analysis'

/** Most vouchers one undo may carry (an intent saves a handful; a guard against a runaway list). */
export const UNDO_MAX = 20

function latestVoucherAudit(db: DB, id: number): string | null {
  const row = db
    .prepare("SELECT action FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .get(id) as { action: string } | undefined
  return row?.action ?? null
}

/** Why `id` can't be undone, or null when it can. */
function blockOf(db: DB, id: number, lock: string | null): UndoState['reason'] | 'missing' {
  const v = db.prepare('SELECT id, date, deleted_at, is_year_end_close FROM vouchers WHERE id = ?').get(id) as
    | { id: number; date: string; deleted_at: string | null; is_year_end_close: number }
    | undefined
  if (!v) return 'missing'
  if (v.deleted_at) return 'binned'
  if (v.is_year_end_close) return 'closing_entry'
  if (latestVoucherAudit(db, id) !== 'create') return 'edited'
  if (lock && v.date <= lock) return 'locked'
  const fy = fyOf(v.date)
  const closedAfter = db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? AND v.id > ? LIMIT 1`)
    .get(fy.from, fy.to, id)
  if (closedAfter) return 'closed_year'
  return null
}

/** Whether the save card may still offer Undo for these just-saved vouchers. */
export function undoState(db: DB, voucherIds: readonly number[]): UndoState {
  const lock = getLockDate(db)
  for (const id of voucherIds) {
    const why = blockOf(db, id, lock)
    if (why === 'missing') return { undoable: false, reason: 'binned' }
    if (why) return { undoable: false, reason: why }
  }
  return { undoable: voucherIds.length > 0, reason: voucherIds.length > 0 ? null : 'binned' }
}

/** voucher:undoSave — bin the just-saved vouchers as one group. */
export function undoSave(db: DB, voucherIds: readonly number[]): { groupId: number; binned: number[] } {
  const ids = [...new Set(voucherIds)]
  if (ids.length === 0 || ids.length > UNDO_MAX) throw new AppError('undo_nothing', 'Nothing to undo')
  const lock = getLockDate(db)
  for (const id of ids) {
    const why = blockOf(db, id, lock)
    if (why === 'missing' || why === 'binned') throw new AppError('undo_nothing', `Voucher #${id} is already in the bin — nothing to undo`)
    if (why === 'edited') throw new AppError('undo_edited', `Voucher #${id} was changed after it was saved — edit it instead of undoing`)
    if (why === 'closing_entry') throw new AppError('undo_closing_entry', 'A year-end closing journal cannot be undone')
    if (why === 'closed_year') throw new AppError('undo_closed_year', `The year of voucher #${id} was closed after it was saved — it cannot be undone`)
    if (why === 'locked') throw lockedError(lock!)
  }
  return db.transaction(() => {
    const binned: number[] = []
    for (const id of ids) {
      // A partner binned along with an earlier member (forex revaluation pairs) is already there.
      const live = db.prepare('SELECT deleted_at FROM vouchers WHERE id = ?').get(id) as { deleted_at: string | null }
      if (!live.deleted_at) deleteVoucher(db, id)
      binned.push(id)
    }
    const groupId = Number(db.prepare('INSERT INTO undo_groups DEFAULT VALUES').run().lastInsertRowid)
    const add = db.prepare('INSERT INTO undo_group_vouchers (group_id, voucher_id) VALUES (?, ?)')
    for (const id of binned) add.run(groupId, id)
    writeAudit(db, 'undo_group', groupId, 'create', null, { voucherIds: binned, reason: 'undo after save' })
    return { groupId, binned }
  })()
}

/** The undo group a binned voucher went to the bin with, if any. */
export function undoGroupOf(db: DB, voucherId: number): { groupId: number; voucherIds: number[] } | null {
  const g = db.prepare('SELECT group_id AS groupId FROM undo_group_vouchers WHERE voucher_id = ?').get(voucherId) as { groupId: number } | undefined
  if (!g) return null
  const ids = (db.prepare('SELECT voucher_id AS id FROM undo_group_vouchers WHERE group_id = ? ORDER BY voucher_id').all(g.groupId) as { id: number }[]).map((r) => r.id)
  return { groupId: g.groupId, voucherIds: ids }
}

/** voucher:restore — a voucher undone with others comes back with its whole group (all or
 *  nothing: one refusal rolls the others back); any other voucher restores as it always did. */
export function restoreFromBin(db: DB, id: number): { restored: number[] } {
  const group = undoGroupOf(db, id)
  if (!group) {
    restoreVoucher(db, id)
    return { restored: [id] }
  }
  return db.transaction(() => {
    const restored: number[] = []
    // The voucher asked for goes first, so its refusal (lock, interest clash …) is the one shown.
    for (const vid of [id, ...group.voucherIds.filter((v) => v !== id)]) {
      const row = db.prepare('SELECT deleted_at FROM vouchers WHERE id = ?').get(vid) as { deleted_at: string | null } | undefined
      if (!row?.deleted_at) continue // came back with a partner already
      restoreVoucher(db, vid)
      restored.push(vid)
    }
    db.prepare('DELETE FROM undo_groups WHERE id = ?').run(group.groupId)
    writeAudit(db, 'undo_group', group.groupId, 'restore', { voucherIds: group.voucherIds }, { restored })
    return { restored }
  })()
}

/** voucher:saveSummary — the save card's figures, computed now from the saved vouchers and the
 *  party's bill allocation (the Outstandings engine). */
export function saveSummary(db: DB, voucherIds: readonly number[]): SaveSummary {
  const cashBank = cashBankGroupIds(db)
  const cashOnly = descendantIdsByName(db, ['Cash-in-Hand'])
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const ledger = db.prepare('SELECT id, name, group_id AS groupId FROM ledgers WHERE id = ?')
  const kindOf = db.prepare('SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?')
  const entries: SaveCardEntry[] = []
  let partyId: number | null = null
  let latest = todayISO()
  for (const id of voucherIds) {
    const v = getVoucher(db, id)
    if (!v || v.deletedAt) continue
    const kind = (kindOf.get(id) as { kind: SaveCardEntry['kind'] }).kind
    const amount = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    let moneyLine: SaveCardEntry['money'] = null
    if (kind === 'receipt' || kind === 'payment') {
      const side = kind === 'receipt' ? 'dr' : 'cr'
      const lines = v.lines.filter((l) => l.drCr === side)
      const cash = lines
        .map((l) => ({ l, led: ledger.get(l.ledgerId) as { id: number; name: string; groupId: number } | undefined }))
        .filter((x) => x.led && cashBank.has(x.led.groupId))
      if (cash.length) {
        moneyLine = {
          name: cash[0]!.led!.name,
          isCash: cash.every((x) => cashOnly.has(x.led!.groupId)),
          amount: cash.reduce((s, x) => s + x.l.amount, 0)
        }
      }
    }
    entries.push({ voucherId: id, kind, number: v.number, date: v.date, amount, money: moneyLine })
    if (v.date > latest) latest = v.date
    if (partyId == null) {
      const candidate =
        v.partyLedgerId ??
        v.lines.map((l) => ledger.get(l.ledgerId) as { id: number; groupId: number } | undefined).find((l) => l && (debtors.has(l.groupId) || creditors.has(l.groupId)))?.id ??
        null
      if (candidate != null) partyId = candidate
    }
  }
  let party: SaveCardParty | null = null
  if (partyId != null) {
    const led = ledger.get(partyId) as { id: number; name: string; groupId: number } | undefined
    const side = led && debtors.has(led.groupId) ? 'customer' : led && creditors.has(led.groupId) ? 'supplier' : null
    if (led && side) {
      const alloc = partyAllocation(db, led.id, latest)
      const open = alloc.bills.reduce((s, b) => s + b.pending, 0)
      party = { ledgerId: led.id, name: led.name, side, balance: open - alloc.unappliedCredit }
    }
  }
  return { entries, party, undo: undoState(db, voucherIds) }
}
