// WP 9.6 review — the simple Bank screen's save is ONE transaction: when the statement line can't
// be tied to the entry simple:post just saved (bankImport.reconcileSavedDraft refuses), nothing
// of it survives — no voucher, no number used up, no simple_posts record, no audit row, no match
// row, no learned rule — and the next save takes the very number the refused one would have.
// Also: a line matched meanwhile by another path is refused (never matched twice), a retry with the
// same clientId after an Unmatch in the full app re-ties the SAME entry (no second voucher), and an
// "Already recorded" whose entry left the books is refused.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const refuse = { on: false }
vi.mock('./bankImport', async (orig) => {
  const real = (await orig()) as typeof import('./bankImport')
  return {
    ...real,
    reconcileSavedDraft: (...args: Parameters<typeof real.reconcileSavedDraft>) =>
      refuse.on ? ({ ok: false, reason: 'the statement line was matched meanwhile' } as const) : real.reconcileSavedDraft(...args)
  }
})

import { seededDb, TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { BankAcceptItem, BankView } from '@shared/simple/bank'
import { createLedger } from './masters'
import { deleteVoucher, IN_BOOKS } from './vouchers'
import { commitStatement, confirmMatches, unmatchLine } from './bankImport'
import { postIntent } from './simplePost'
import { acceptLines, bankView } from './simpleBank'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Bank Rollback Co', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-20'
const HEADER = 'Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance'
const ROWS = ['12/08/2025,NEFT-RAMESH TRADERS-UTR998877,N1,,"4,000.00",', '14/08/2025,UPI-STATIONERY MART-PAPER,U1,"450.00",,']

let db: DB
let bank = 0
let ramesh = 0
let office = 0
let seq = 0
const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledger = (name: string, group: string, extra: Record<string, unknown> = {}): number =>
  createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
const view = (): Promise<BankView> => bankView(db, bank, TODAY)
const lineOf = (v: BankView, text: string) => v.lines.find((l) => l.description.includes(text))!
const accept = (item: Omit<BankAcceptItem, 'clientId'>, clientId = `bank-${item.lineId}-${++seq}-x`) => acceptLines(db, INFO, bank, [{ ...item, clientId } as BankAcceptItem], TODAY)

/** Every trace a save could leave. */
const traces = () => ({
  vouchers: n('SELECT COUNT(*) AS n FROM vouchers'),
  lines: n('SELECT COUNT(*) AS n FROM voucher_lines'),
  refs: n('SELECT COUNT(*) AS n FROM bill_refs'),
  posts: n('SELECT COUNT(*) AS n FROM simple_posts'),
  audit: n('SELECT COUNT(*) AS n FROM audit_log'),
  matches: n('SELECT COUNT(*) AS n FROM bank_statement_matches'),
  rules: n('SELECT COUNT(*) AS n FROM bank_learned_rules'),
  ledgers: n('SELECT COUNT(*) AS n FROM ledgers')
})

beforeEach(() => {
  refuse.on = false
  db = seededDb()
  writeCompanyInfo(db, INFO)
  bank = ledger('HDFC Bank', 'Bank Accounts')
  ramesh = ledger('Ramesh Traders', 'Sundry Debtors')
  office = ledger('Office expenses', 'Indirect Expenses', { simpleCategory: 'office' })
  ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  postIntent(db, INFO, { clientId: 'seed-sale-1-xxxx', kind: 'sale', date: '2025-08-01', customerId: ramesh, amount: { amount: 500_000 }, payment: { how: 'credit' } }, TODAY)
  commitStatement(db, bank, { fileName: 'hdfc.csv', text: [HEADER, ...ROWS].join('\n') })
})

describe('simple Bank — one transaction per line (WP 9.6 review)', () => {
  it('a refused reconcile leaves no trace: no voucher, number, record, audit, match or rule; the next save takes the same number', async () => {
    const v = await view()
    const line = lineOf(v, 'RAMESH')
    const before = traces()
    refuse.on = true
    const r = accept({ lineId: line.id, choice: { kind: 'customer', partyId: ramesh } }, 'bank-refused-123')
    expect(r.done).toEqual([])
    expect(r.failed[0]!.error).toMatchObject({ code: 'simple_bank_not_matched', field: 'line' })
    expect(traces()).toEqual(before)
    expect((await view()).lines.find((l) => l.id === line.id)!.status).toBe('open')

    // Allowed again (same clientId — nothing of it was kept): saved, and numbered as the first try would have been.
    refuse.on = false
    const ok = accept({ lineId: line.id, choice: { kind: 'customer', partyId: ramesh } }, 'bank-refused-123')
    expect(ok.failed).toEqual([])
    const vid = ok.done[0]!.voucherIds[0]!
    const numbers = db.prepare("SELECT v.number FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE t.kind = 'receipt' ORDER BY v.id").all() as { number: string }[]
    expect(numbers.map((x) => x.number)).toEqual(['1'])
    expect(n(`SELECT COUNT(*) AS n FROM bank_statement_matches WHERE statement_line_id = ${line.id} AND voucher_id = ${vid}`)).toBe(1)
  })

  it('a line matched meanwhile by another path is refused — never matched twice', async () => {
    const v = await view()
    const line = lineOf(v, 'STATIONERY')
    // Someone records the payment by hand and ties it in the full app.
    const hand = postIntent(db, INFO, { clientId: 'hand-entry-1-xxxx', kind: 'money_out', date: '2025-08-14', payeeId: office, amount: 45_000, from: { how: 'bank', accountId: bank } }, TODAY)
    confirmMatches(db, bank, [{ lineIds: [line.id], voucherIds: hand.voucherIds }])
    const before = traces()
    const r = accept({ lineId: line.id, choice: { kind: 'expense', accountId: office } })
    expect(r.failed[0]!.error).toMatchObject({ code: 'simple_bank_line_done', field: 'line' })
    expect(traces()).toEqual(before)
    expect(n(`SELECT COUNT(*) AS n FROM bank_statement_matches WHERE statement_line_id = ${line.id}`)).toBe(1)
  })

  it('a retry with the same clientId after an Unmatch ties the SAME entry again (no second voucher)', async () => {
    const v = await view()
    const line = lineOf(v, 'STATIONERY')
    const item = { lineId: line.id, choice: { kind: 'expense' as const, accountId: office } }
    const first = accept(item, 'bank-retry-unmatch-1')
    unmatchLine(db, bank, line.id)
    const vouchers = n(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)
    const again = accept(item, 'bank-retry-unmatch-1')
    expect(again.done).toEqual(first.done)
    expect(n(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)).toBe(vouchers)
    expect((await view()).lines.find((l) => l.id === line.id)!.status).toBe('done')
  })

  it('"Already recorded" is refused when the entry left the books since the screen showed it', async () => {
    const hand = postIntent(db, INFO, { clientId: 'hand-entry-2-xxxx', kind: 'money_out', date: '2025-08-14', payeeId: office, amount: 45_000, from: { how: 'bank', accountId: bank } }, TODAY)
    const v = await view()
    const line = lineOf(v, 'STATIONERY')
    expect(line.suggestion?.choice.kind).toBe('existing')
    deleteVoucher(db, hand.voucherIds[0]!)
    const before = traces()
    const r = accept({ lineId: line.id, choice: { kind: 'existing' } })
    expect(r.failed[0]!.error).toMatchObject({ code: 'simple_bank_no_match', field: 'choice' })
    expect(traces()).toEqual(before)
  })
})
