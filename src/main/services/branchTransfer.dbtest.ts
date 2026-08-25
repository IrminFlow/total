import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createGodown, createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { saveTransfer } from './inventoryTransfer'
import { writeCompanyInfo } from '../db/seed'
import { gstScope, listRegistrations, saveRegistration } from './registrations'
import { gstr1, gstr3b, itcBreakdown } from './gst'
import { profitAndLoss, stockValue, trialBalance } from './reports'
import {
  branchTransferRegister,
  deleteBranchTransferInvoice,
  getBranchTransferInvoice,
  issueBranchTransfers,
  nextBranchTransferNumber,
  scanMovements,
  undocumentedCrossTransfers
} from './branchTransfer'

// Checksum-valid GSTINs on one PAN: Maharashtra and Gujarat.
const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

const FROM = '2026-07-01'
const TO = '2026-07-31'
const AS_ON = '2027-03-31'

interface Book {
  db: DB
  mh: number
  gj: number
  mumbai: number
  surat: number
  item: number
}

/**
 * One PAN, two registrations, a Mumbai godown and a Surat one, and ₹1,000 of stock in Mumbai.
 *
 * The purchase that brings the stock in is what makes the closing-stock assertion meaningful: a
 * book with no stock cannot prove that raising a transfer invoice left the stock value alone.
 */
function stockBook(): Book {
  const db = seededDb()
  writeCompanyInfo(db, { ...TEST_INFO, gstin: MH, stateCode: '27' })
  const gj = saveRegistration(db, {
    gstin: GJ,
    stateCode: '24',
    tradeName: 'Gujarat branch',
    address: 'Surat',
    registeredOn: null,
    surrenderedOn: null
  }).id
  const mh = listRegistrations(db).find((r) => r.id !== gj)!.id
  const mumbai = createGodown(db, { name: 'Mumbai godown', gstRegistrationId: mh })
  const surat = createGodown(db, { name: 'Surat godown', gstRegistrationId: gj })
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const item = Number(
    db
      .prepare('INSERT INTO stock_items (name, unit_id, gst_rate, hsn) VALUES (?, ?, ?, ?)')
      .run('Widget', unit, 18, '8471').lastInsertRowid
  )

  const vtId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
  const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Purchase Accounts'").get() as { id: number }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId, openingBalance: 0 }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  saveVoucher(db, {
    voucherTypeId: vtId,
    date: '2026-07-01',
    partyLedgerId: null,
    lines: [
      { ledgerId: purchases, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: cash, drCr: 'cr', amount: 100000, costAllocations: [] }
    ],
    inventory: [
      { stockItemId: item, godownId: mumbai.id, qtyMilli: 10000, ratePaise: 10000, amount: 100000, direction: 'in' }
    ],
    billRefs: [],
    tds: null
  })
  return { db, mh, gj, mumbai: mumbai.id, surat: surat.id, item }
}

/** Move 4 of the 10 widgets from Mumbai to Surat — a Schedule I para 2 supply. */
function transfer(b: Book, date = '2026-07-12'): void {
  saveTransfer(b.db, {
    date,
    fromGodownId: b.mumbai,
    toGodownId: b.surat,
    items: [{ stockItemId: b.item, qtyMilli: 4000 }]
  })
}

const issue = (b: Book): ReturnType<typeof issueBranchTransfers> =>
  issueBranchTransfers(b.db, { from: FROM, to: TO, basis: 'declared-full-itc', recipientFullItc: true })

describe('finding the movement', () => {
  it('reads the goods off the journal, with their HSN and rate', () => {
    const b = stockBook()
    transfer(b)
    const { movements } = scanMovements(b.db, FROM, TO)
    expect(movements).toHaveLength(1)
    expect(movements[0]!.from.gstin).toBe(MH)
    expect(movements[0]!.to.gstin).toBe(GJ)
    expect(movements[0]!.lines).toEqual([
      expect.objectContaining({ description: 'Widget', hsn: '8471', qtyMilli: 4000, bookValue: 40000, rate: 18 })
    ])
  })

  it('finds nothing on a single-registration book, so the check costs nothing', () => {
    const db = seededDb()
    writeCompanyInfo(db, { ...TEST_INFO, gstin: MH, stateCode: '27' })
    expect(scanMovements(db, FROM, TO)).toEqual({ movements: [], skipped: [] })
    expect(branchTransferRegister(db, FROM, TO).multiRegistration).toBe(false)
  })

  it('declines to invoice a journal that fans out to two registrations, and says why', () => {
    const b = stockBook()
    const pune = createGodown(b.db, { name: 'Pune godown', gstRegistrationId: b.mh })
    // One journal, one source, two destinations: which goods went where is not recorded.
    const vt = (b.db.prepare("SELECT id FROM voucher_types WHERE kind = 'stock_journal'").get() as { id: number }).id
    saveVoucher(b.db, {
      voucherTypeId: vt,
      date: '2026-07-14',
      partyLedgerId: null,
      lines: [],
      inventory: [
        { stockItemId: b.item, godownId: b.mumbai, qtyMilli: 2000, ratePaise: 10000, amount: 20000, direction: 'out' },
        { stockItemId: b.item, godownId: b.surat, qtyMilli: 1000, ratePaise: 10000, amount: 10000, direction: 'in' },
        { stockItemId: b.item, godownId: pune.id, qtyMilli: 1000, ratePaise: 10000, amount: 10000, direction: 'in' }
      ],
      billRefs: [],
      tds: null
    })
    const scan = scanMovements(b.db, FROM, TO)
    expect(scan.movements).toEqual([])
    expect(scan.skipped[0]!.reason).toContain('is not recorded')
  })
})

describe('the trial balance must not move', () => {
  /**
   * The constraint that shapes the whole feature and is not negotiable. One business, one set of
   * books: a transfer between its own branches creates a tax liability in one registration and a
   * matching credit in another, but it does not create revenue, expense or stock value.
   */
  it('leaves the trial balance, the P&L and the closing stock exactly as they were', () => {
    const b = stockBook()
    transfer(b)

    const tbBefore = trialBalance(b.db, AS_ON)
    const plBefore = profitAndLoss(b.db, '2026-04-01', AS_ON)
    const stockBefore = stockValue(b.db, AS_ON)

    const result = issue(b)
    expect(result.issued).toHaveLength(1)
    // And there really is tax on the document — otherwise "nothing moved" would be trivially true.
    expect(result.issued[0]!.igst).toBe(7200)

    expect(trialBalance(b.db, AS_ON)).toEqual(tbBefore)
    expect(profitAndLoss(b.db, '2026-04-01', AS_ON)).toEqual(plBefore)
    expect(stockValue(b.db, AS_ON)).toBe(stockBefore)
  })

  it('posts no voucher at all — the count is the same before and after', () => {
    const b = stockBook()
    transfer(b)
    const count = (): number =>
      (b.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }).n
    const before = count()
    issue(b)
    expect(count()).toBe(before)
  })
})

describe('the sender’s return carries the outward supply', () => {
  it('puts it in GSTR-1 B2B against the receiving GSTIN, and in 3B 3.1(a)', () => {
    const b = stockBook()
    transfer(b)
    const mhScope = gstScope(b.db, { ...TEST_INFO, gstin: MH, stateCode: '27' }, b.mh)

    const before = gstr1(b.db, mhScope, FROM, TO, '072026')
    const b2bBefore = before.summary.find((s) => s.section === 'b2b')!
    issue(b)
    const after = gstr1(b.db, mhScope, FROM, TO, '072026')
    const b2bAfter = after.summary.find((s) => s.section === 'b2b')!

    expect(b2bAfter.docs).toBe(b2bBefore.docs + 1)
    expect(b2bAfter.taxable - b2bBefore.taxable).toBe(40000)
    // Maharashtra to Gujarat: inter-state, so IGST at the goods' own 18%.
    expect(b2bAfter.igst - b2bBefore.igst).toBe(7200)

    const b3 = gstr3b(b.db, mhScope, FROM, TO, '072026')
    expect(b3.outward.taxable).toBe(40000)
    expect(b3.outward.igst).toBe(7200)
  })

  it('does not put the sender’s supply in the RECEIVER’s outward return', () => {
    const b = stockBook()
    transfer(b)
    issue(b)
    const gjScope = gstScope(b.db, { ...TEST_INFO, gstin: MH, stateCode: '27' }, b.gj)
    expect(gstr3b(b.db, gjScope, FROM, TO, '072026').outward.taxable).toBe(0)
  })
})

describe('the receiver’s return carries the credit', () => {
  it('lands in 4(A)(5), to the paise the sender charged', () => {
    const b = stockBook()
    transfer(b)
    issue(b)
    const gjScope = gstScope(b.db, { ...TEST_INFO, gstin: GJ, stateCode: '24' }, b.gj)
    const itc = itcBreakdown(b.db, gjScope, FROM, TO)
    expect(itc.oth.igst).toBe(7200)
    expect(gstr3b(b.db, gjScope, FROM, TO, '072026').itc.igst).toBe(7200)
  })

  it('withholds the credit where the recipient does not take full ITC — and says so on the paper', () => {
    const b = stockBook()
    transfer(b)
    const r = issueBranchTransfers(b.db, {
      from: FROM, to: TO, basis: 'declared-full-itc', recipientFullItc: false
    })
    expect(r.issued[0]!.recipientFullItc).toBe(false)
    expect(r.issued[0]!.warnings.join(' ')).toContain('NOT in your books')
    const gjScope = gstScope(b.db, { ...TEST_INFO, gstin: GJ, stateCode: '24' }, b.gj)
    expect(itcBreakdown(b.db, gjScope, FROM, TO).oth.igst).toBe(0)
  })

  it('one PAN nets to nothing: the sender’s output tax equals the receiver’s credit', () => {
    const b = stockBook()
    transfer(b)
    issue(b)
    const mhScope = gstScope(b.db, { ...TEST_INFO, gstin: MH, stateCode: '27' }, b.mh)
    const gjScope = gstScope(b.db, { ...TEST_INFO, gstin: GJ, stateCode: '24' }, b.gj)
    const out = gstr3b(b.db, mhScope, FROM, TO, '072026').outward.igst
    const inn = itcBreakdown(b.db, gjScope, FROM, TO).oth.igst
    expect(out).toBe(inn)
  })
})

describe('the register and the serial', () => {
  it('moves a movement from pending to issued, and back on withdrawal', () => {
    const b = stockBook()
    transfer(b)
    expect(branchTransferRegister(b.db, FROM, TO).pending).toHaveLength(1)
    const r = issue(b)
    const after = branchTransferRegister(b.db, FROM, TO)
    expect(after.pending).toEqual([])
    expect(after.issued).toHaveLength(1)

    deleteBranchTransferInvoice(b.db, r.issued[0]!.id)
    expect(branchTransferRegister(b.db, FROM, TO).pending).toHaveLength(1)
  })

  it('is idempotent: a movement already invoiced is skipped, never documented twice', () => {
    const b = stockBook()
    transfer(b)
    issue(b)
    const second = issue(b)
    expect(second.issued).toEqual([])
    expect(second.skipped).toHaveLength(1)
  })

  it('numbers per sending registration and per financial year — rule 46(b)', () => {
    const b = stockBook()
    transfer(b)
    const r = issue(b)
    expect(r.issued[0]!.number).toBe('BT/27/2026-27/0001')
    expect(nextBranchTransferNumber(b.db, '27', '2026-07-12')).toBe('BT/27/2026-27/0002')
    // A different registration's series is untouched by Maharashtra's.
    expect(nextBranchTransferNumber(b.db, '24', '2026-07-12')).toBe('BT/24/2026-27/0001')
  })

  it('runs a batch off one counter, so two movements do not share a serial', () => {
    const b = stockBook()
    transfer(b, '2026-07-12')
    transfer(b, '2026-07-19')
    const r = issue(b)
    expect(r.issued.map((x) => x.number)).toEqual(['BT/27/2026-27/0001', 'BT/27/2026-27/0002'])
  })

  it('reprints the paper that was issued rather than recomputing it', () => {
    const b = stockBook()
    transfer(b)
    const r = issue(b)
    const doc = getBranchTransferInvoice(b.db, r.issued[0]!.id)
    expect(doc.number).toBe(r.issued[0]!.number)
    expect(doc.basisCitation).toContain('Second proviso to rule 28(1)')
    expect(doc.placeOfSupply).toBe('24')
  })
})

describe('the validation warning', () => {
  it('shrinks as the invoices are raised, instead of repeating a fixed problem', () => {
    const b = stockBook()
    transfer(b)
    expect(undocumentedCrossTransfers(b.db, FROM, TO)).toHaveLength(1)
    issue(b)
    expect(undocumentedCrossTransfers(b.db, FROM, TO)).toEqual([])
  })
})
