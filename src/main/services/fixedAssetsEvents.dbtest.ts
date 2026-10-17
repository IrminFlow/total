// Fixed-asset events beyond WP 3.6's whole-asset disposal: a partial disposal (a quantity / share
// split off and disposed of); GST on the sale of a capital good (CGST Act s.18(6)); the rule 25(2)
// 40% cap of the Income-tax Rules, 2026. Figures are hand-worked in the comments (integer paise); statutory
// text in src/shared/fixedAssetSources.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { extractOutwardDocs, gstr3b } from './gst'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import { closingBalances } from './reports'
import * as fa from './fixedAssets'
import type { FixedAssetInput } from '@shared/fixedAssets'
import type { VoucherInput } from '@shared/schemas'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null, openingBalance: 0
}
const R = (rupees: number): number => Math.round(rupees * 100)

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}
function ledger(db: DB, name: string, group: string, over: { stateCode?: string; taxType?: 'cgst' | 'sgst' | 'igst' | 'cess' } = {}): number {
  return createLedger(db, { ...LEDGER_DEFAULTS, ...over, name, groupId: groupId(db, group) }).id
}
function vtype(db: DB, kind: string): number {
  return (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
}
function post(db: DB, kind: string, date: string, lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[], partyLedgerId: number | null = null): number {
  return saveVoucher(db, {
    voucherTypeId: vtype(db, kind), date, partyLedgerId, narration: null, reference: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null
  } as VoucherInput).id
}
const faGroup = (db: DB, name: string): number => (db.prepare('SELECT id FROM fixed_asset_groups WHERE name = ?').get(name) as { id: number }).id
const balanceOf = (db: DB, id: number, asOn: string): number => closingBalances(db, asOn).get(id) ?? 0
const ledgerName = (db: DB, id: number): string => (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string }).name
const auditCount = (db: DB, entity: string): number => (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE entity = ?').get(entity) as { n: number }).n

let db: DB
let computersLedger: number
let vendor: number
let bank: number
let purchaseId: number

beforeEach(() => {
  db = seededDb()
  computersLedger = ledger(db, 'Computers', 'Fixed Assets')
  vendor = ledger(db, 'Laptop World', 'Sundry Creditors')
  bank = ledger(db, 'HDFC Bank', 'Bank Accounts')
  // Four identical laptops, ₹60,000 together, bought and put to use 1 Apr 2025.
  purchaseId = post(db, 'purchase', '2025-04-01', [
    { ledgerId: computersLedger, drCr: 'dr', amount: R(60000) },
    { ledgerId: vendor, drCr: 'cr', amount: R(60000) }
  ], vendor)
})

function laptops(over: Partial<FixedAssetInput> = {}): FixedAssetInput {
  return {
    name: 'Laptops (4)', assetGroupId: faGroup(db, 'Computers'), ledgerId: computersLedger, purchaseVoucherId: purchaseId,
    purchaseDate: '2025-04-01', putToUseDate: '2025-04-01', costPaise: R(60000), residualBp: 500, lifeMonths: 36,
    method: 'slm', itBlockId: (db.prepare("SELECT id FROM it_blocks WHERE code = 'PM40'").get() as { id: number }).id,
    location: 'Head office', identifier: null, ...over
  }
}

describe('partial disposal', () => {
  it('splits the part off with its share of cost and booked depreciation, disposes of it, and leaves the rest', () => {
    const asset = fa.saveAsset(db, laptops())
    // FY 2025-26: (60,000 − 5% residual 3,000) ÷ 3 years = ₹19,000.
    expect(fa.postRun(db, '2025-04-01', '2026-03-31').total).toBe(R(19000))
    const input = {
      assetId: asset.id, date: '2026-10-01', kind: 'sale' as const, proceedsPaise: R(8000), considerationLedgerId: bank,
      chargeCatchUp: true, part: { quantity: 1, of: 4 }
    }
    const runsBefore = (db.prepare('SELECT COUNT(*) AS n FROM depreciation_lines').get() as { n: number }).n
    const p = fa.previewDisposal(db, input)
    // The preview rehearses the split and rolls it back: nothing is left behind.
    expect((db.prepare('SELECT COUNT(*) AS n FROM fixed_assets').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM depreciation_lines').get() as { n: number }).n).toBe(runsBefore)
    // Part = 1/4: cost 15,000; booked depreciation 19,000 / 4 = 4,750.
    // Catch-up 1 Apr – 30 Sep 2026 (183 days): (15,000 − 750) × 12 ÷ 36 × 183 ÷ 365
    //   = 1,425,000 paise × 183 ÷ 1,095 = 238,150.68 → 238,151 paise (₹2,381.51).
    // Carrying 15,000 − 4,750 − 2,381.51 = 7,868.49 ⇒ profit 8,000 − 7,868.49 = ₹131.51.
    expect(p).toMatchObject({
      assetId: asset.id, gross: R(15000), accumulatedBooked: R(4750), catchUp: 238151, carrying: 786849, profit: 13151,
      blocked: null, part: { quantity: 1, of: 4 }, remainingCost: R(45000)
    })

    const auditBefore = auditCount(db, 'fixed_asset')
    const { asset: sold, remaining, voucherId } = fa.disposeAsset(db, input)
    expect(sold).toMatchObject({ name: 'Laptops (4) (part 1 of 4)', status: 'disposed', costPaise: R(15000), disposalVoucherId: voucherId })
    expect(remaining).toMatchObject({ id: asset.id, status: 'active', costPaise: R(45000), accumulatedPaise: R(14250) })
    // The asset's update (whole before / after), the part's create, the disposal.
    expect(auditCount(db, 'fixed_asset') - auditBefore).toBe(3)
    const v = getVoucher(db, voucherId)!
    expect(v.narration).toBe('Sale of part (1 of 4) of fixed asset Laptops (4)')
    expect(v.lines.map((l) => [ledgerName(db, l.ledgerId), l.drCr, l.amount])).toEqual([
      ['HDFC Bank', 'dr', R(8000)],
      ['Depreciation', 'dr', 238151],
      ['Accumulated Depreciation - Computers', 'dr', R(4750)],
      ['Computers', 'cr', R(15000)],
      ['Profit on Sale of Fixed Assets', 'cr', 13151]
    ])
    // Books: Computers 60,000 − 15,000 = 45,000; accumulated 19,000 + 2,381.51 − (4,750 + 2,381.51) = 14,250.
    const accId = fa.listAssetGroups(db).find((g) => g.name === 'Computers')!.accDepLedgerId!
    expect(balanceOf(db, computersLedger, '2026-10-01')).toBe(R(45000))
    expect(balanceOf(db, accId, '2026-10-01')).toBe(-R(14250))
    for (const r of fa.assetSchedule(db, '2026-04-01', '2027-03-31').reconciliation) expect(r.difference, r.ledgerName).toBe(0)
    // The FY 2025-26 run still totals 19,000 across the two records (14,250 + 4,750).
    const fy25 = fa.listRuns(db).find((r) => r.periodFrom === '2025-04-01' && r.assetId == null)!
    expect(fy25).toMatchObject({ total: R(19000), lineCount: 2 })
    // The rest depreciates on its own cost: (45,000 − 2,250) ÷ 3 = ₹14,250 for FY 2026-27.
    const run = fa.previewRun(db, '2026-04-01', '2027-03-31')
    expect(run.rows.find((r) => r.assetId === asset.id)!.depreciation).toBe(R(14250))
    expect(run.total).toBe(R(14250))

    // Income-tax block (40%): FY 2025-26 closing 60,000 − 24,000 = 36,000; FY 2026-27 the part's
    // moneys payable 8,000 reduce it (s.41(1)(c) "C") ⇒ 28,000 × 40% = 11,200, closing 16,800; the
    // block goes on (assets remain), so no s.74 / s.50 gain or loss.
    const block = fa.itStatement(db, 2026).blocks.find((b) => b.blockCode === 'PM40')!
    expect(block).toMatchObject({ openingWdv: R(36000), saleProceeds: R(8000), totalDepreciation: R(11200), closingWdv: R(16800), shortTermCapitalGain: 0, shortTermCapitalLoss: 0 })

    // Binning the journal puts the part back on the register as its own record; the totals are the
    // asset's again (45,000 + 15,000; 14,250 + 4,750).
    deleteVoucher(db, voucherId)
    const back = fa.listAssets(db, '2026-10-01')
    expect(back.map((a) => [a.costPaise, a.accumulatedPaise, a.status])).toEqual([[R(45000), R(14250), 'active'], [R(15000), R(4750), 'active']])
  })

  it('a share by cost, additions split too, and refusals leave nothing behind', () => {
    const asset = fa.saveAsset(db, laptops())
    fa.saveAddition(db, { assetId: asset.id, date: '2025-10-01', amountPaise: R(3000), kind: 'improvement' })
    fa.postRun(db, '2025-04-01', '2026-03-31')
    const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM fixed_assets').get() as { n: number }).n
    // A share given in rupees: ₹20,000 of the ₹60,000 cost ⇒ 1/3 of every figure; the ₹3,000
    // improvement splits 1,000 / 2,000.
    const p = fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: R(20000), of: R(60000) } })
    expect(p).toMatchObject({ gross: R(21000), remainingCost: R(42000), blocked: null })
    // Refused inside the lock — and the rehearsal leaves no record.
    setLockDate(db, '2026-12-31')
    expect(fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: 1, of: 3 } }).blocked).toMatch(/locked/)
    expect(() => fa.disposeAsset(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: 1, of: 3 } })).toThrow(/locked/)
    setLockDate(db, null)
    expect(count()).toBe(1)
    // A share that rounds to nothing is refused.
    expect(fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: 1, of: 1e12 } }).blocked).toMatch(/rounds to nothing/)
    expect(() => fa.disposeAsset(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: 1, of: 1e12 } })).toThrow(/rounds to nothing/)
    expect(count()).toBe(1)
    // The part must be less than the whole (Zod).
    expect(() => fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0, part: { quantity: 3, of: 3 } })).toThrow(/less than the whole/)
  })
})

describe('GST on the sale of a capital good (s.18(6))', () => {
  let plant: number
  let buyer: number
  let machineBill: number
  let machine: number
  beforeEach(() => {
    plant = ledger(db, 'Plant and Machinery', 'Fixed Assets')
    const inCgst = ledger(db, 'Input CGST', 'Duties & Taxes', { taxType: 'cgst' })
    const inSgst = ledger(db, 'Input SGST', 'Duties & Taxes', { taxType: 'sgst' })
    ledger(db, 'Output CGST', 'Duties & Taxes', { taxType: 'cgst' })
    ledger(db, 'Output SGST', 'Duties & Taxes', { taxType: 'sgst' })
    const supplier = ledger(db, 'Machine Works', 'Sundry Creditors', { stateCode: '27' })
    buyer = ledger(db, 'Shree Traders', 'Sundry Debtors', { stateCode: '27' })
    // ₹1,00,000 machine + CGST 9,000 + SGST 9,000 (credit taken), invoiced 1 Apr 2025.
    machineBill = post(db, 'purchase', '2025-04-01', [
      { ledgerId: plant, drCr: 'dr', amount: R(100000) },
      { ledgerId: inCgst, drCr: 'dr', amount: R(9000) },
      { ledgerId: inSgst, drCr: 'dr', amount: R(9000) },
      { ledgerId: supplier, drCr: 'cr', amount: R(118000) }
    ], supplier)
    machine = fa.saveAsset(db, laptops({
      name: 'CNC lathe', assetGroupId: faGroup(db, 'Plant and machinery'), ledgerId: plant, purchaseVoucherId: machineBill,
      costPaise: R(100000), lifeMonths: 180, itBlockId: null
    })).id
    // FY 2025-26: (1,00,000 − 5,000) ÷ 15 = 6,333.33 (633,333 paise).
    expect(fa.postRun(db, '2025-04-01', '2026-03-31').total).toBe(633333)
  })

  const sale = (over: Record<string, unknown> = {}) => ({
    assetId: machine, date: '2026-09-15', kind: 'sale' as const, proceedsPaise: R(50000), considerationLedgerId: buyer,
    chargeCatchUp: true, gst: { ratePercent: 18 }, ...over
  })

  it('posts the tax invoice at the value, the extra output tax in the disposal journal, and 3B 3.1(a) carries both', () => {
    const p = fa.previewDisposal(db, sale())
    expect(p.blocked).toBeNull()
    expect(p).toMatchObject({ gstApplies: true, suggestedGstRate: 18 })
    // Working (as capitalGoodsGst.test): ITC 18,000; rule 40(2) 6 quarters ⇒ 12,600; rule 44(6)
    // 43/60 ⇒ 12,900; tax on ₹50,000 @ 18% = 9,000 ⇒ s.18(6) amount 12,900, extra 3,900.
    expect(p.gst).toMatchObject({
      supply: 'intra', taxableValue: R(50000), itcSource: 'purchase', invoiceTotal: R(59000),
      extraOutputTax: { igst: 0, cgst: R(1950), sgst: R(1950), cess: 0 }
    })
    expect(p.gst!.working.payable).toEqual({ igst: 0, cgst: R(6450), sgst: R(6450), cess: 0 })

    const { voucherId, invoiceVoucherId } = fa.disposeAsset(db, sale())
    const inv = getVoucher(db, invoiceVoucherId!)!
    expect(inv.partyLedgerId).toBe(buyer)
    expect(inv.narration).toContain('rule 44(6) 43/60 months left = ₹12,900.00')
    expect(inv.lines.map((l) => [ledgerName(db, l.ledgerId), l.drCr, l.amount])).toEqual([
      ['Shree Traders', 'dr', R(59000)],
      ['Sale of Fixed Assets', 'cr', R(50000)],
      ['Output CGST', 'cr', R(4500)],
      ['Output SGST', 'cr', R(4500)]
    ])
    // Catch-up 1 Apr – 14 Sep 2026 (167 days): 9,500,000 × 167 ÷ (15 × 365) = 289,771.69 → 289,772.
    // Carrying 1,00,000 − 6,333.33 − 2,897.72 = 90,768.95 ⇒ loss on sale 40,768.95.
    const j = getVoucher(db, voucherId)!
    expect(j.reference).toBe(`Invoice ${inv.number}`)
    expect(j.lines.map((l) => [ledgerName(db, l.ledgerId), l.drCr, l.amount])).toEqual([
      ['Sale of Fixed Assets', 'dr', R(50000)],
      ['Depreciation', 'dr', 289772],
      ['Accumulated Depreciation - Plant and machinery', 'dr', 633333],
      ['Plant and Machinery', 'cr', R(100000)],
      ['Loss on Sale of Fixed Assets', 'dr', 4076895],
      ['GST on Sale of Capital Goods (s.18(6))', 'dr', R(3900)],
      ['Output CGST', 'cr', R(1950)],
      ['Output SGST', 'cr', R(1950)]
    ])
    const id = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
    expect(balanceOf(db, id('Sale of Fixed Assets'), '2026-09-30')).toBe(0)
    expect(balanceOf(db, id('Output CGST'), '2026-09-30')).toBe(-R(6450))

    // GSTR-1 / the export see the invoice alone (18% on ₹50,000); 3B 3.1(a) adds the extra 3,900.
    const info = readCompanyInfo(db)
    const docs = extractOutwardDocs(db, info, '2026-09-01', '2026-09-30')
    expect(docs.map((d) => [d.voucherId, d.items])).toEqual([[invoiceVoucherId, [{ rate: 18, taxable: R(50000), cgst: R(4500), sgst: R(4500), igst: 0, cess: 0 }]]])
    const r = gstr3b(db, info, '2026-09-01', '2026-09-30', '092026')
    expect(r.outward).toMatchObject({ taxable: R(50000), cgst: R(6450), sgst: R(6450), igst: 0 })
    expect(r.netPayable).toMatchObject({ cgst: R(6450), sgst: R(6450) })

    // The invoice can't be edited on its own; binning the journal reinstates the asset and drops
    // the extra from 3B; the journal comes back only with its invoice.
    expect(() => saveVoucher(db, { ...inv, lines: inv.lines.map((l) => ({ ...l, costAllocations: [] })) } as unknown as VoucherInput, inv.id)).toThrow(/posted by a fixed-asset disposal/)
    deleteVoucher(db, voucherId)
    expect(fa.getAsset(db, machine, '2026-09-30').status).toBe('active')
    expect(gstr3b(db, info, '2026-09-01', '2026-09-30', '092026').outward).toMatchObject({ cgst: R(4500), sgst: R(4500) })
    deleteVoucher(db, invoiceVoucherId!)
    expect(() => restoreVoucher(db, voucherId)).toThrow(/tax invoice first/)
    restoreVoucher(db, invoiceVoucherId!)
    restoreVoucher(db, voucherId)
    expect(gstr3b(db, info, '2026-09-01', '2026-09-30', '092026').outward).toMatchObject({ cgst: R(6450), sgst: R(6450) })
  })

  it('a sale above the credit-based amount pays the tax on the value only; entered credit wins; the scrap proviso', () => {
    // ₹90,000 @ 18% = 16,200 > 12,900 ⇒ no extra.
    const high = fa.previewDisposal(db, sale({ proceedsPaise: R(90000) }))
    expect(high.gst!.extraOutputTax).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
    expect(high.journal.some((l) => l.ledgerName.startsWith('GST on Sale'))).toBe(false)
    // Credit entered by hand: IGST 6,000 ⇒ rule 44(6) 6,000 × 43/60 = 4,300 < 9,000 ⇒ no extra.
    const entered = fa.previewDisposal(db, sale({ gst: { ratePercent: 18, itc: { igst: R(6000), cgst: 0, sgst: 0, cess: 0 } } }))
    expect(entered.gst).toMatchObject({ itcSource: 'entered', extraOutputTax: { cgst: 0, sgst: 0 } })
    const scrap = fa.previewDisposal(db, sale({ kind: 'scrap', proceedsPaise: R(1000), gst: { ratePercent: 18, scrapProviso: true } }))
    expect(scrap.gst!.extraOutputTax).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  })

  it('refuses GST for an unregistered company on the sale date, and without a buyer — leaving nothing behind', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    expect(fa.previewDisposal(db, sale({ considerationLedgerId: null })).blocked).toMatch(/proceeds go to|buyer/)
    writeCompanyInfo(db, { ...readCompanyInfo(db), gstRegistrationType: 'unregistered' })
    const p = fa.previewDisposal(db, sale())
    expect(p.gstApplies).toBe(false)
    expect(p.blocked).toMatch(/GST is not charged/)
    expect(() => fa.disposeAsset(db, sale())).toThrow(/GST is not charged/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
  })
})

describe('Income-tax Rules, 2026 rule 25(2) — 40% cap for the concessional regimes', () => {
  it('caps a block\'s rate at 40% of WDV and allows no additional depreciation; 1961-Act years are unchanged', () => {
    const block = fa.saveBlock(db, { code: 'PM45', name: 'Motor buses on hire (test 45%)' })
    fa.saveBlockRate(db, { blockId: block.id, effectiveFrom: '2026-04-01', rateBp: 4500, additionalRateBp: 2000, act: '2025', sectionRef: 'test', source: 'test' })
    const bus = ledger(db, 'Buses', 'Fixed Assets')
    fa.saveAsset(db, laptops({
      name: 'Bus', ledgerId: bus, purchaseVoucherId: null, purchaseDate: '2026-04-01', putToUseDate: '2026-04-01', costPaise: R(100000),
      assetGroupId: faGroup(db, 'Motor vehicles'), lifeMonths: 96, itBlockId: block.id, itAdditionalEligible: true
    }))
    // Ordinary: 1,00,000 × 45% = 45,000 + additional 20% = 20,000 ⇒ 65,000; closing 35,000.
    const plain = fa.itStatement(db, 2026).blocks.find((b) => b.blockCode === 'PM45')!
    expect(plain).toMatchObject({ rateBp: 4500, depreciationFullRate: R(45000), additionalDepreciation: R(20000), totalDepreciation: R(65000), closingWdv: R(35000), cappedFromBp: null, additionalDisallowed: false })
    // Rule 25(2) regime: 40% ⇒ 40,000, no additional (s.202(2)(a)(vi) / s.205(1)(a)); closing 60,000.
    const st = fa.itStatement(db, 2026, { concessionalRegime: true })
    expect(st.concessionalRegime).toBe(true)
    expect(st.blocks.find((b) => b.blockCode === 'PM45')).toMatchObject({
      rateBp: 4000, cappedFromBp: 4500, additionalRateBp: 0, additionalDepreciation: 0, totalDepreciation: R(40000), closingWdv: R(60000), additionalDisallowed: true
    })
    // FY 2027-28 carries 60,000 forward: 60,000 × 40% = 24,000.
    expect(fa.itStatement(db, 2027, { concessionalRegime: true }).blocks.find((b) => b.blockCode === 'PM45')).toMatchObject({ openingWdv: R(60000), totalDepreciation: R(24000) })
    // A 1961-Act year (FY 2025-26, the four laptops at 40%) is the same either way.
    fa.saveAsset(db, laptops())
    const y25 = fa.itStatement(db, 2025).blocks
    expect(fa.itStatement(db, 2025, { concessionalRegime: true }).blocks).toEqual(y25)
  })
})
