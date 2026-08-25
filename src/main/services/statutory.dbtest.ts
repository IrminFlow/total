import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { recordFiling } from './filings'
import { gstr1aFor, snapshotGstr1 } from './gstr1a'
import { acceptMatched, clearImsDecision, imsWorklist, recordImsDecision } from './ims'
import { itemRateHistory, itemTaxOn, rateAdvisory, saveItemRate, deleteItemRate } from './gstRates'
import { form3cdPack, scheduleIII } from './presentation'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { imsKey } from '@shared/gst/ims'

const GST_CO: CompanyInfo = { ...TEST_INFO, gstin: '27AAPFU0939F1ZV', booksFrom: 2026 }

function books() {
  const db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  const buyer = L({ name: 'Acme Corp', groupId: groupId('Sundry Debtors'), stateCode: '27', gstin: '27AACCA1234A1ZI' })
  const sales = L({ name: 'Sales 18%', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' })
  const cgst = L({ name: 'CGST Output', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
  const sgst = L({ name: 'SGST Output', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })

  const post = (kind: string, date: string, partyId: number | null, lines: { ledgerId: number; drCr: DrCr; amount: number }[]) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })

  /** A ₹1,00,000 + 18% local sale. */
  const sell = (date: string, taxable: number) =>
    post('sales', date, buyer, [
      { ledgerId: buyer, drCr: 'dr', amount: Math.round(taxable * 1.18) },
      { ledgerId: sales, drCr: 'cr', amount: taxable },
      { ledgerId: cgst, drCr: 'cr', amount: Math.round(taxable * 0.09) },
      { ledgerId: sgst, drCr: 'cr', amount: Math.round(taxable * 0.09) }
    ])

  return { db, groupId, vtId, L, buyer, sales, cgst, sgst, post, sell }
}

// ---------- GSTR-1A (roadmap #353) ----------

describe('GSTR-1A', () => {
  const fileGstr1 = (db: ReturnType<typeof books>['db'], period = '2026-05') =>
    recordFiling(db, { form: 'GSTR-1', period, dueDate: '2026-06-11', filedAt: '2026-06-10', arn: 'AA27', taxPaid: 0, notes: null })

  it('refuses to snapshot a period nobody has recorded as filed', () => {
    const b = books()
    expect(() => snapshotGstr1(b.db, GST_CO, '2026-05')).toThrow(/Record the filing first/)
  })

  it('says there is nothing to compare against rather than reporting a clean return', () => {
    // The most dangerous possible answer for this screen is "clean" when nothing was compared.
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    fileGstr1(b.db)
    const state = gstr1aFor(b.db, GST_CO, '2026-05')
    expect(state.result).toBeNull()
    expect(state.message).toContain('No snapshot')
  })

  it('is clean when nothing has changed since the snapshot', () => {
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    fileGstr1(b.db)
    snapshotGstr1(b.db, GST_CO, '2026-05')
    expect(gstr1aFor(b.db, GST_CO, '2026-05').result!.clean).toBe(true)
  })

  it('finds an invoice added after the return went in', () => {
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    fileGstr1(b.db)
    snapshotGstr1(b.db, GST_CO, '2026-05')
    b.sell('2026-05-20', 50_000_00)

    const result = gstr1aFor(b.db, GST_CO, '2026-05').result!
    expect(result.clean).toBe(false)
    expect(result.rows.map((r) => r.change)).toEqual(['added'])
    expect(result.net.taxable).toBe(50_000_00)
  })

  it('reports the window as shut once GSTR-3B is filed', () => {
    const b = books()
    fileGstr1(b.db)
    recordFiling(b.db, { form: 'GSTR-3B', period: '2026-05', dueDate: '2026-06-20', filedAt: '2026-06-19', arn: 'BB27', taxPaid: 0, notes: null })
    expect(gstr1aFor(b.db, GST_CO, '2026-05').window.open).toBe(false)
  })

  it('handles a period with no transactions at all', () => {
    const b = books()
    fileGstr1(b.db)
    snapshotGstr1(b.db, GST_CO, '2026-05')
    const state = gstr1aFor(b.db, GST_CO, '2026-05')
    expect(state.snapshotDocs).toBe(0)
    expect(state.result!.clean).toBe(true)
  })
})

// ---------- IMS (roadmap #352) ----------

const twoBJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    data: {
      rtnprd: '052026',
      docdata: {
        b2b: [
          {
            ctin: '27AAPFU0939F1ZV',
            trdnm: 'Ram Traders',
            inv: [
              {
                inum: 'RT-1',
                idt: '04-05-2026',
                val: 118000,
                itms: [{ itm_det: { rt: 18, txval: 100000, camt: 9000, samt: 9000 } }],
                ...over
              }
            ]
          }
        ]
      }
    }
  })

describe('IMS worklist', () => {
  it('turns a portal invoice the books have never seen into an undecided row', () => {
    const b = books()
    const { worklist } = imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31')
    expect(worklist.rows).toHaveLength(1)
    expect(worklist.rows[0]!.bucket).toBe('missingInBooks')
    expect(worklist.undecided).toBe(1)
    expect(worklist.atRisk.cgst).toBe(9_000_00)
  })

  it('remembers a decision across a fresh 2B download', () => {
    const b = books()
    const key = imsKey('27AAPFU0939F1ZV', 'RT-1')
    recordImsDecision(b.db, { docKey: key, period: '052026', action: 'reject', note: 'Not our bill' }, 'anita')
    const { worklist } = imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31')
    expect(worklist.rows[0]!.action).toBe('reject')
    expect(worklist.undecided).toBe(0)
    expect(worklist.counts.reject).toBe(1)
  })

  it('lets a decision be revised, keeping one row rather than a history nobody reads', () => {
    const b = books()
    const key = imsKey('27AAPFU0939F1ZV', 'RT-1')
    recordImsDecision(b.db, { docKey: key, period: '052026', action: 'pending', note: null }, null)
    recordImsDecision(b.db, { docKey: key, period: '052026', action: 'accept', note: null }, null)
    const { worklist } = imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31')
    expect(worklist.rows[0]!.action).toBe('accept')
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM ims_actions').get() as { n: number }).n).toBe(1)
  })

  it('puts a cleared decision back on the worklist', () => {
    const b = books()
    const key = imsKey('27AAPFU0939F1ZV', 'RT-1')
    recordImsDecision(b.db, { docKey: key, period: '052026', action: 'accept', note: null }, null)
    clearImsDecision(b.db, key)
    expect(imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31').worklist.undecided).toBe(1)
  })

  it('bulk-accepts only the rows where the portal and the books agree', () => {
    // Rubber-stamping a mismatch alongside four hundred matches is exactly what this must not do.
    const b = books()
    const { worklist } = imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31')
    expect(acceptMatched(b.db, worklist, null)).toBe(0)
    expect(imsWorklist(b.db, twoBJson(), '2026-05-01', '2026-05-31').worklist.undecided).toBe(1)
  })

  it('produces an empty worklist for a month with an empty 2B', () => {
    const b = books()
    const { worklist } = imsWorklist(b.db, JSON.stringify({ data: { rtnprd: '052026', docdata: {} } }), '2026-05-01', '2026-05-31')
    expect(worklist.rows).toEqual([])
    expect(worklist.undecided).toBe(0)
  })
})

// ---------- dated item rates (roadmap #358) ----------

describe('dated GST rates', () => {
  const withItem = () => {
    const b = books()
    const unit = (b.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const item = createStockItem(b.db, {
      name: 'Cement', groupId: null, unitId: unit, hsn: '2523', gstRate: 18, cessRate: 0,
      openingQtyMilli: 0, openingValue: 0, code: null, barcode: null, reorderLevelMilli: null,
      valuationMethod: 'fifo', blockNegative: null
    })
    return { ...b, item }
  }

  it('falls back to the master for an item nobody has dated', () => {
    // An item with no history has had one rate for its whole life, and that is the master's.
    const b = withItem()
    const tax = itemTaxOn(b.db, b.item.id, '2026-05-04')
    expect(tax.gstRate).toBe(18)
    expect(tax.source).toBe('master')
  })

  it('answers with the rate in force on the date once a change is recorded', () => {
    const b = withItem()
    saveItemRate(b.db, { stockItemId: b.item.id, effectiveFrom: '2017-07-01', gstRate: 28, cessRate: 0, note: null })
    saveItemRate(b.db, { stockItemId: b.item.id, effectiveFrom: '2025-09-22', gstRate: 18, cessRate: 0, note: 'Rationalisation' })
    expect(itemTaxOn(b.db, b.item.id, '2025-09-21').gstRate).toBe(28)
    expect(itemTaxOn(b.db, b.item.id, '2025-09-22').gstRate).toBe(18)
    expect(itemTaxOn(b.db, b.item.id, '2025-09-22').source).toBe('history')
  })

  it('replaces rather than duplicates when the same date is saved twice', () => {
    const b = withItem()
    saveItemRate(b.db, { stockItemId: b.item.id, effectiveFrom: '2025-09-22', gstRate: 5, cessRate: 0, note: null })
    saveItemRate(b.db, { stockItemId: b.item.id, effectiveFrom: '2025-09-22', gstRate: 18, cessRate: 0, note: null })
    expect(itemRateHistory(b.db, b.item.id)).toHaveLength(1)
    expect(itemTaxOn(b.db, b.item.id, '2026-01-01').gstRate).toBe(18)
  })

  it('removes an entry and goes back to what was there before it', () => {
    const b = withItem()
    const [entry] = saveItemRate(b.db, { stockItemId: b.item.id, effectiveFrom: '2025-09-22', gstRate: 5, cessRate: 0, note: null })
    deleteItemRate(b.db, entry!.id)
    expect(itemTaxOn(b.db, b.item.id, '2026-01-01').source).toBe('master')
  })

  it('advises when a master still carries a slab that was withdrawn', () => {
    const b = books()
    const unit = (b.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    createStockItem(b.db, {
      name: 'Tiles', groupId: null, unitId: unit, hsn: '6907', gstRate: 12, cessRate: 0,
      openingQtyMilli: 0, openingValue: 0, code: null, barcode: null, reorderLevelMilli: null,
      valuationMethod: 'fifo', blockNegative: null
    })
    const advisory = rateAdvisory(b.db, '2026-05-01', '2026-05-31')
    expect(advisory.staleMasters).toHaveLength(1)
    expect(advisory.staleMasters[0]!.message).toContain('withdrawn')
  })

  it('flags the period that straddles the rate change, so the split is not mistaken for an error', () => {
    const b = books()
    expect(rateAdvisory(b.db, '2025-09-01', '2025-09-30').structureChange?.effectiveFrom).toBe('2025-09-22')
    expect(rateAdvisory(b.db, '2026-05-01', '2026-05-31').structureChange).toBeNull()
  })

  it('says nothing about a quiet period in a company with no items', () => {
    const b = books()
    const advisory = rateAdvisory(b.db, '2026-05-01', '2026-05-31')
    expect(advisory.findings).toEqual([])
    expect(advisory.staleMasters).toEqual([])
  })
})

// ---------- Schedule III (roadmap #363) ----------

describe('Schedule III presentation', () => {
  it('ties to the balance sheet it is a view over', () => {
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    const s = scheduleIII(b.db, '2026-04-01', '2027-03-31')
    expect(s.balanceSheet.balanced || s.balanceSheet.unmapped.length > 0).toBe(true)
    const eql = s.balanceSheet.totalEquityAndLiabilities
    const assets = s.balanceSheet.totalAssets
    expect(eql).toBe(assets)
  })

  it('puts a customer balance under trade receivables and the tax under other current liabilities', () => {
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    const s = scheduleIII(b.db, '2026-04-01', '2027-03-31')
    expect(s.balanceSheet.assets.find((l) => l.key === 'tradeReceivables')!.amount).toBe(1_18_000_00)
    expect(s.balanceSheet.equityAndLiabilities.find((l) => l.key === 'otherCurrentLiabilities')!.amount).toBe(18_000_00)
  })

  it('says the MSME payables split is missing when nobody has classified a supplier', () => {
    // The caveat only fires where there ARE payables — a company that owes nobody has nothing to
    // split, and nagging about it would be noise.
    const b = books()
    const creditor = b.L({ name: 'Steel Supplier', groupId: b.groupId('Sundry Creditors') })
    b.post('purchase', '2026-05-04', creditor, [
      { ledgerId: b.sales, drCr: 'dr', amount: 40_000_00 },
      { ledgerId: creditor, drCr: 'cr', amount: 40_000_00 }
    ])
    const s = scheduleIII(b.db, '2026-04-01', '2027-03-31')
    expect(s.balanceSheet.equityAndLiabilities.find((l) => l.key === 'tradePayables')!.amount).toBe(40_000_00)
    expect(s.balanceSheet.caveats.join(' ')).toContain('24 March 2021')
  })

  it('presents an empty company without falling over', () => {
    const b = books()
    const s = scheduleIII(b.db, '2026-04-01', '2027-03-31')
    expect(s.balanceSheet.totalAssets).toBe(0)
    expect(s.profitAndLoss.profitBeforeTax).toBe(0)
  })

  it('reconciles the P&L face: income less expenses is the profit before tax', () => {
    const b = books()
    b.sell('2026-05-04', 1_00_000_00)
    const s = scheduleIII(b.db, '2026-04-01', '2027-03-31')
    expect(s.profitAndLoss.revenue).toBe(1_00_000_00)
    expect(s.profitAndLoss.profitBeforeTax).toBe(s.profitAndLoss.totalIncome - s.profitAndLoss.totalExpenses)
  })
})

// ---------- Form 3CD (roadmap #362) ----------

describe('Form 3CD pack', () => {
  it('names every clause it did not extract, so the pack cannot look complete', () => {
    const b = books()
    const pack = form3cdPack(b.db, 2026)
    expect(pack.extracts.length + pack.empty.length).toBeGreaterThanOrEqual(11)
    expect(pack.empty.some((e) => e.clause === '14(a)')).toBe(true)
    expect(pack.empty.every((e) => e.reason.length > 0)).toBe(true)
  })

  it('finds a cash payment over the section 40A(3) limit, aggregated per party per day', () => {
    // Three ₹4,000 payments to one contractor in one day is one ₹12,000 breach, not three
    // compliant payments.
    const b = books()
    const cash = (b.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const supplier = b.L({ name: 'Ram Contractors', groupId: b.groupId('Sundry Creditors') })
    for (let i = 0; i < 3; i++) {
      b.post('payment', '2026-06-10', supplier, [
        { ledgerId: supplier, drCr: 'dr', amount: 4_000_00 },
        { ledgerId: cash, drCr: 'cr', amount: 4_000_00 }
      ])
    }
    const pack = form3cdPack(b.db, 2026)
    const clause = pack.extracts.find((e) => e.clause === '21(d)')!
    expect(clause.rows).toHaveLength(1)
    expect(clause.rows[0]!.cells[1]).toBe('Ram Contractors')
    expect(clause.caveats.join(' ')).toContain('bearer cheque')
  })

  it('leaves a payment under the limit alone', () => {
    const b = books()
    const cash = (b.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const supplier = b.L({ name: 'Small Vendor', groupId: b.groupId('Sundry Creditors') })
    b.post('payment', '2026-06-10', supplier, [
      { ledgerId: supplier, drCr: 'dr', amount: 5_000_00 },
      { ledgerId: cash, drCr: 'cr', amount: 5_000_00 }
    ])
    expect(form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '21(d)')).toBeUndefined()
  })

  it('uses the limit in force on the payment’s own date, not today’s', () => {
    // ₹15,000 in 2016 was inside the then ₹20,000 limit. Applying today's ₹10,000 to it would
    // report a disallowance that never happened.
    const b = books()
    const cash = (b.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const supplier = b.L({ name: 'Old Vendor', groupId: b.groupId('Sundry Creditors') })
    b.post('payment', '2016-06-10', supplier, [
      { ledgerId: supplier, drCr: 'dr', amount: 15_000_00 },
      { ledgerId: cash, drCr: 'cr', amount: 15_000_00 }
    ])
    expect(form3cdPack(b.db, 2016).extracts.find((e) => e.clause === '21(d)')).toBeUndefined()
    // The same payment made after the Finance Act 2017 halved the limit is a breach.
    b.post('payment', '2026-06-10', supplier, [
      { ledgerId: supplier, drCr: 'dr', amount: 15_000_00 },
      { ledgerId: cash, drCr: 'cr', amount: 15_000_00 }
    ])
    expect(form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '21(d)')!.rows).toHaveLength(1)
  })

  it('splits expenditure under clause 44 by whether the supplier is registered', () => {
    const b = books()
    const registered = b.L({
      name: 'Registered Supplier', groupId: b.groupId('Sundry Creditors'), gstin: '27AACCA1234A1ZI', stateCode: '27'
    })
    const unregistered = b.L({ name: 'Local Vendor', groupId: b.groupId('Sundry Creditors') })
    const expense = b.L({ name: 'Repairs', groupId: b.groupId('Indirect Expenses') })
    b.post('purchase', '2026-06-10', registered, [
      { ledgerId: expense, drCr: 'dr', amount: 30_000_00 },
      { ledgerId: registered, drCr: 'cr', amount: 30_000_00 }
    ])
    b.post('purchase', '2026-06-11', unregistered, [
      { ledgerId: expense, drCr: 'dr', amount: 10_000_00 },
      { ledgerId: unregistered, drCr: 'cr', amount: 10_000_00 }
    ])

    const clause = form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '44')!
    expect(clause.rows[0]!.cells[1]).toContain('30,000')
    expect(clause.rows[1]!.cells[1]).toContain('10,000')
    expect(clause.caveats.join(' ')).toContain('only registration fact')
  })

  it('shows expenditure with no supplier on its own line rather than calling it unregistered', () => {
    // A direct cash expense booked without a party cannot be attributed either way, and folding
    // it into "not registered" would overstate exactly the figure the clause exists to test.
    const b = books()
    const cash = (b.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const expense = b.L({ name: 'Sundry Expenses', groupId: b.groupId('Indirect Expenses') })
    b.post('payment', '2026-06-10', null, [
      { ledgerId: expense, drCr: 'dr', amount: 2_000_00 },
      { ledgerId: cash, drCr: 'cr', amount: 2_000_00 }
    ])
    const clause = form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '44')!
    expect(clause.rows[2]!.cells[1]).toContain('2,000')
    expect(clause.rows[1]!.cells[1]).toBe('0.00')
  })

  it('reports the 43B(h) disallowance under clause 26, and says who is unclassified', () => {
    const b = books()
    const supplier = b.L({
      name: 'Micro Supplier', groupId: b.groupId('Sundry Creditors'), msmeStatus: 'micro', creditDays: 15
    })
    const expense = b.L({ name: 'Job Work', groupId: b.groupId('Direct Expenses') })
    // Billed in April, still unpaid at the year end: well past the fifteen days section 15 allows
    // where there is no written agreement.
    b.post('purchase', '2026-04-10', supplier, [
      { ledgerId: expense, drCr: 'dr', amount: 1_00_000_00 },
      { ledgerId: supplier, drCr: 'cr', amount: 1_00_000_00 }
    ])
    const clause = form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '26')!
    expect(clause.rows[0]!.cells[0]).toBe('Micro Supplier')
    expect(clause.rows[0]!.cells[3]).toContain('1,00,000')
    expect(clause.caveats.join(' ')).toContain('statutory-dues limbs')
  })

  it('lists related-party transactions under clause 23', () => {
    const b = books()
    const related = b.L({ name: 'Director’s Firm', groupId: b.groupId('Sundry Creditors'), relatedParty: true, relationship: 'Director' })
    b.post('purchase', '2026-06-10', related, [
      { ledgerId: b.sales, drCr: 'dr', amount: 20_000_00 },
      { ledgerId: related, drCr: 'cr', amount: 20_000_00 }
    ])
    const clause = form3cdPack(b.db, 2026).extracts.find((e) => e.clause === '23')!
    expect(clause.rows[0]!.cells[0]).toBe('Director’s Firm')
    expect(clause.caveats.join(' ')).toContain('wider definition')
  })
})
