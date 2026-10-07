// WP 3.6 — fixed-asset register against a real (in-memory) company DB: migration 026 seeds,
// create-from-purchase, depreciation run → one journal, re-run refusal until the voucher is
// binned, lock / closed-year refusal, disposal with catch-up depreciation and profit / loss,
// the schedule reconciling to ledger balances, the IT block statement and the year-end warning.
import { describe, it, expect, beforeEach } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { MIGRATIONS } from '../db/migrations'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { closingBalances, trialBalance } from './reports'
import { closePreview } from './yearEnd'
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
function ledger(db: DB, name: string, group: string): number {
  return createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(db, group) }).id
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
function faGroup(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM fixed_asset_groups WHERE name = ?').get(name) as { id: number }).id
}
function balanceOf(db: DB, ledgerId: number, asOn: string): number {
  return closingBalances(db, asOn).get(ledgerId) ?? 0
}

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
  // ₹60,000 laptop bought 1 Apr 2025.
  purchaseId = post(db, 'purchase', '2025-04-01', [
    { ledgerId: computersLedger, drCr: 'dr', amount: R(60000) },
    { ledgerId: vendor, drCr: 'cr', amount: R(60000) }
  ], vendor)
})

function laptopInput(over: Partial<FixedAssetInput> = {}): FixedAssetInput {
  return {
    name: 'MacBook Pro', assetGroupId: faGroup(db, 'Computers'), ledgerId: computersLedger, purchaseVoucherId: purchaseId,
    purchaseDate: '2025-04-01', putToUseDate: '2025-04-01', costPaise: R(60000), residualBp: 500, lifeMonths: 36,
    method: 'slm', itBlockId: (db.prepare("SELECT id FROM it_blocks WHERE code = 'PM40'").get() as { id: number }).id,
    location: 'Head office', identifier: 'SN-001', ...over
  }
}

describe('migration 026', () => {
  it('creates the register tables and seeds cited, effective-dated master data', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    for (const t of ['fixed_assets', 'fixed_asset_groups', 'fixed_asset_additions', 'depreciation_runs', 'depreciation_lines', 'it_blocks', 'it_block_rates', 'it_block_openings', 'ca_asset_classes']) {
      expect(tables).toContain(t)
    }
    const classes = fa.listClasses(db)
    expect(classes.find((c) => c.code === 'XII(ii)')).toMatchObject({ lifeMonths: 36, effectiveFrom: '2014-04-01', isSeeded: true })
    expect(classes.find((c) => c.code === 'IV(a)')?.lifeMonths).toBe(180)
    expect(classes.every((c) => c.source.includes('accessed 2026-10-07'))).toBe(true)
    const pm = fa.listBlocks(db).find((b) => b.code === 'PM15')!
    expect(pm.rates.map((r) => [r.act, r.effectiveFrom, r.effectiveTo, r.rateBp, r.additionalRateBp])).toEqual([
      ['1961', '2017-04-01', '2026-03-31', 1500, 2000],
      ['2025', '2026-04-01', null, 1500, 2000]
    ])
    const groups = fa.listAssetGroups(db)
    expect(groups.find((g) => g.name === 'Computers')).toMatchObject({ lifeMonths: 36, residualBp: 500, method: 'slm', itBlockName: expect.stringContaining('40%') })
    // No "≤ ₹5,000 written off" rule is seeded (not in Schedule II — GN(A) 35 ¶56-58).
    expect(MIGRATIONS.at(-1)).not.toMatch(/5,?000.*write/i)
  })
})

describe('register', () => {
  it('creates an asset from a purchase voucher and no longer offers that line', () => {
    const cand = fa.candidateFromVoucher(db, purchaseId)!
    expect(cand.lines).toEqual([{ ledgerId: computersLedger, ledgerName: 'Computers', amount: R(60000), suggestedGroupId: null }])
    expect(fa.purchaseCandidates(db, '2025-04-01', '2026-03-31').map((c) => c.voucherId)).toEqual([purchaseId])
    const asset = fa.saveAsset(db, laptopInput())
    expect(asset).toMatchObject({ status: 'active', grossPaise: R(60000), accumulatedPaise: 0, lifeEnd: '2028-03-31', purchaseVoucherId: purchaseId })
    expect(fa.candidateFromVoucher(db, purchaseId)).toBeNull()
    expect(fa.purchaseCandidates(db, '2025-04-01', '2026-03-31')).toEqual([])
  })

  it('refuses a non-fixed-asset ledger', () => {
    expect(() => fa.saveAsset(db, laptopInput({ ledgerId: vendor }))).toThrow(/under Fixed Assets/)
  })
})

describe('depreciation run', () => {
  it('posts ONE journal, refuses a re-run until the voucher is binned, and guards restore + edit', () => {
    const asset = fa.saveAsset(db, laptopInput())
    const preview = fa.previewRun(db, '2025-04-01', '2026-03-31')
    expect(preview.blocked).toBeNull()
    expect(preview.rows).toMatchObject([{ assetId: asset.id, depreciation: R(19000), daysUsed: 365, closingWdv: R(41000) }])
    expect(preview.journal).toEqual([
      { ledgerId: null, ledgerName: 'Depreciation', drCr: 'dr', amount: R(19000), assetId: null },
      { ledgerId: null, ledgerName: 'Accumulated Depreciation - Computers', drCr: 'cr', amount: R(19000), assetId: null }
    ])

    const run = fa.postRun(db, '2025-04-01', '2026-03-31')
    expect(run).toMatchObject({ total: R(19000), lineCount: 1, voided: false, fyStartYear: 2025 })
    const v = getVoucher(db, run.voucherId!)!
    expect(v.date).toBe('2026-03-31')
    const depId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Depreciation'").get() as { id: number }).id
    const accId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Accumulated Depreciation - Computers'").get() as { id: number }).id
    expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[depId, 'dr', R(19000)], [accId, 'cr', R(19000)]])
    // The ledgers are under the right groups and stored on the asset group.
    expect(db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?').get(accId)).toEqual({ name: 'Fixed Assets' })
    expect(db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?').get(depId)).toEqual({ name: 'Indirect Expenses' })
    expect(fa.listAssetGroups(db).find((g) => g.name === 'Computers')).toMatchObject({ accDepLedgerId: accId, depExpenseLedgerId: depId })
    // An ordinary expense: it is in the trial balance's movement like any journal.
    expect(trialBalance(db, '2026-03-31').rows.find((r) => r.ledgerId === depId)).toBeTruthy()

    // Re-running the period (or any overlapping one) is refused.
    expect(fa.previewRun(db, '2025-10-01', '2026-03-31').blocked).toMatch(/already posted.*bin/)
    expect(() => fa.postRun(db, '2025-04-01', '2026-03-31')).toThrow(/already posted/)
    // The journal can't be edited from voucher entry.
    expect(() => saveVoucher(db, { ...v, voucherTypeId: v.voucherTypeId, lines: v.lines.map((l) => ({ ...l, costAllocations: [] })) } as unknown as VoucherInput, v.id))
      .toThrow(/posted by Fixed assets/)

    // Bin it → the run is void, the period can be run again.
    deleteVoucher(db, run.voucherId!)
    expect(fa.listRuns(db)[0]!.voided).toBe(true)
    expect(fa.getAsset(db, asset.id, '2026-03-31').accumulatedPaise).toBe(0)
    const again = fa.postRun(db, '2025-04-01', '2026-03-31')
    expect(again.total).toBe(R(19000))
    // Restoring the old one now would double-charge the year — refused.
    expect(() => restoreVoucher(db, run.voucherId!)).toThrow(/posted again since/)
  })

  it('respects the lock date and closed years', () => {
    fa.saveAsset(db, laptopInput())
    setLockDate(db, '2026-03-31')
    expect(fa.previewRun(db, '2025-04-01', '2026-03-31').blocked).toBe('Books are locked up to 2026-03-31')
    expect(() => fa.postRun(db, '2025-04-01', '2026-03-31')).toThrow(/locked/)
    setLockDate(db, null)
    db.prepare("UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?").run(purchaseId)
    expect(fa.previewRun(db, '2025-04-01', '2026-03-31').blocked).toMatch(/FY 2025-26 is closed/)
  })

  it('quarterly runs accumulate and the next year continues from them', () => {
    fa.saveAsset(db, laptopInput())
    const q1 = fa.postRun(db, '2025-04-01', '2025-06-30')
    const rest = fa.postRun(db, '2025-07-01', '2026-03-31')
    expect(Math.abs(q1.total + rest.total - R(19000))).toBeLessThanOrEqual(1)
    const fy26 = fa.previewRun(db, '2026-04-01', '2027-03-31')
    expect(fa.getAsset(db, fa.listAssets(db, '2027-03-31')[0]!.id, '2026-03-31').accumulatedPaise).toBe(q1.total + rest.total)
    expect(fy26.rows[0]!.depreciation).toBe(R(19000))
  })

  it('posts per asset when the group asks for it', () => {
    const g = fa.listAssetGroups(db).find((x) => x.name === 'Computers')!
    fa.saveAssetGroup(db, { ...g, postPerAsset: true }, g.id)
    fa.saveAsset(db, laptopInput())
    fa.saveAsset(db, laptopInput({ name: 'Second laptop', identifier: 'SN-002', purchaseVoucherId: null }))
    const p = fa.previewRun(db, '2025-04-01', '2026-03-31')
    expect(p.journal.filter((l) => l.drCr === 'cr').length).toBe(2)
    expect(p.journal.filter((l) => l.drCr === 'dr')).toHaveLength(1)
  })

  it('changes of life apply prospectively and need an effective year once depreciation is booked', () => {
    const asset = fa.saveAsset(db, laptopInput({ lifeMonths: 60 })) // 5 years ⇒ ₹11,400 a year
    expect(fa.postRun(db, '2025-04-01', '2026-03-31').total).toBe(R(11400))
    expect(() => fa.saveAsset(db, laptopInput({ lifeMonths: 36 }), asset.id)).toThrow(/give the financial year/)
    expect(() => fa.saveAsset(db, laptopInput({ lifeMonths: 36, changeEffectiveFrom: '2025-04-01' }), asset.id)).toThrow(/later year|after/)
    fa.saveAsset(db, laptopInput({ lifeMonths: 36, changeEffectiveFrom: '2026-04-01' }), asset.id)
    // Carrying ₹48,600 − residual ₹3,000 over the 2 remaining years ⇒ ₹22,800.
    expect(fa.previewRun(db, '2026-04-01', '2027-03-31').rows[0]!.depreciation).toBe(R(22800))
    expect(() => fa.saveAsset(db, laptopInput({ costPaise: R(50000), lifeMonths: 36, changeEffectiveFrom: '2026-04-01' }), asset.id)).toThrow(/cost can't change/)
  })
})

describe('disposal', () => {
  it('posts the sale with catch-up depreciation, marks the asset disposed, and binning reinstates it', () => {
    const asset = fa.saveAsset(db, laptopInput())
    fa.postRun(db, '2025-04-01', '2026-03-31') // ₹19,000
    const input = { assetId: asset.id, date: '2026-10-01', kind: 'sale' as const, proceedsPaise: R(30000), considerationLedgerId: bank, chargeCatchUp: true }
    const p = fa.previewDisposal(db, input)
    // Catch-up 1 Apr – 30 Sep 2026: 183 days ⇒ 19,000 × 183 / 365 = 9,526.03.
    expect(p).toMatchObject({ gross: R(60000), accumulatedBooked: R(19000), catchUp: 952603, catchUpFrom: '2026-04-01', blocked: null })
    // Carrying 60,000 − 19,000 − 9,526.03 = 31,473.97 ⇒ loss 1,473.97.
    expect(p.carrying).toBe(3147397)
    expect(p.profit).toBe(-147397)

    const { voucherId, asset: disposed } = fa.disposeAsset(db, input)
    expect(disposed).toMatchObject({ status: 'disposed', disposalDate: '2026-10-01', disposalProceedsPaise: R(30000), disposalVoucherId: voucherId })
    const v = getVoucher(db, voucherId)!
    const name = (id: number): string => (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string }).name
    expect(v.lines.map((l) => [name(l.ledgerId), l.drCr, l.amount])).toEqual([
      ['HDFC Bank', 'dr', R(30000)],
      ['Depreciation', 'dr', 952603],
      ['Accumulated Depreciation - Computers', 'dr', R(19000)],
      ['Computers', 'cr', R(60000)],
      ['Loss on Sale of Fixed Assets', 'dr', 147397]
    ])
    // Asset and accumulated depreciation ledgers are cleared for this asset.
    const accId = fa.listAssetGroups(db).find((g) => g.name === 'Computers')!.accDepLedgerId!
    expect(balanceOf(db, computersLedger, '2026-10-01')).toBe(0)
    expect(balanceOf(db, accId, '2026-10-01')).toBe(0)
    // The year's run no longer charges it; a second disposal is refused.
    expect(fa.previewRun(db, '2026-04-01', '2027-03-31').total).toBe(0)
    expect(fa.previewDisposal(db, input).blocked).toMatch(/already disposed/)
    // Binning the disposal journal reinstates the asset (and voids its catch-up).
    deleteVoucher(db, voucherId)
    expect(fa.getAsset(db, asset.id, '2026-10-01')).toMatchObject({ status: 'active', accumulatedPaise: R(19000) })
  })

  it('a scrap with no proceeds; a sale at a profit credits Profit on Sale', () => {
    const asset = fa.saveAsset(db, laptopInput())
    fa.postRun(db, '2025-04-01', '2026-03-31')
    const p = fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'sale', proceedsPaise: R(45000), considerationLedgerId: bank })
    expect(p.catchUp).toBe(0)
    expect(p.profit).toBe(R(4000))
    expect(p.journal.at(-1)).toEqual({ ledgerId: null, ledgerName: 'Profit on Sale of Fixed Assets', drCr: 'cr', amount: R(4000), assetId: null })
    expect(fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'sale', proceedsPaise: R(45000) }).blocked).toMatch(/proceeds go to/)
    const s = fa.previewDisposal(db, { assetId: asset.id, date: '2026-04-01', kind: 'scrap', proceedsPaise: 0 })
    expect(s.blocked).toBeNull()
    expect(s.profit).toBe(-R(41000))
  })

  it('refuses a disposal that skips an unbooked prior year', () => {
    const asset = fa.saveAsset(db, laptopInput())
    expect(fa.previewDisposal(db, { assetId: asset.id, date: '2026-10-01', kind: 'scrap', proceedsPaise: 0 }).blocked).toMatch(/isn't booked/)
  })
})

describe('asset schedule', () => {
  it('reconciles gross block and accumulated depreciation to the ledger balances at query time', () => {
    const furnitureLedger = ledger(db, 'Furniture', 'Fixed Assets')
    post(db, 'journal', '2025-07-15', [
      { ledgerId: furnitureLedger, drCr: 'dr', amount: R(120000) },
      { ledgerId: bank, drCr: 'cr', amount: R(120000) }
    ])
    const laptop = fa.saveAsset(db, laptopInput())
    fa.saveAsset(db, laptopInput({
      name: 'Conference table', assetGroupId: faGroup(db, 'Furniture and fittings'), ledgerId: furnitureLedger,
      purchaseVoucherId: null, purchaseDate: '2025-07-15', putToUseDate: '2025-07-15', costPaise: R(120000), lifeMonths: 120, identifier: null
    }))
    fa.postRun(db, '2025-04-01', '2026-03-31')
    fa.postRun(db, '2026-04-01', '2026-09-30')
    fa.disposeAsset(db, { assetId: laptop.id, date: '2026-10-01', kind: 'sale', proceedsPaise: R(30000), considerationLedgerId: bank })

    for (const [from, to] of [['2025-04-01', '2026-03-31'], ['2026-04-01', '2027-03-31']] as const) {
      const s = fa.assetSchedule(db, from, to)
      for (const r of s.reconciliation) expect(r.difference, `${r.ledgerName} ${to}`).toBe(0)
      // Net block = gross − accumulated, and the totals are the sum of the groups.
      expect(s.totals.netClosing).toBe(s.totals.grossClosing - s.totals.accClosing)
      expect(s.groups.reduce((x, g) => x + g.grossClosing, 0)).toBe(s.totals.grossClosing)
      const ledgersNet = s.reconciliation.reduce((x, r) => x + (r.role === 'asset' ? r.ledger : -r.ledger), 0)
      expect(ledgersNet).toBe(s.totals.netClosing)
    }
    const fy26 = fa.assetSchedule(db, '2026-04-01', '2027-03-31')
    const comp = fy26.groups.find((g) => g.groupName === 'Computers')!
    expect(comp).toMatchObject({ grossOpening: R(60000), grossDisposals: R(60000), grossClosing: 0, accClosing: 0 })
    expect(comp.accDisposals).toBe(comp.accOpening + comp.accCharge)
  })
})

describe('income-tax statement', () => {
  it('computes the block at half rate for < 180 days, with no asset-level figures and nothing posted', () => {
    fa.saveAsset(db, laptopInput({ putToUseDate: '2025-10-15', purchaseDate: '2025-10-15' })) // 168 days ⇒ 20%
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const st = fa.itStatement(db, 2025)
    const pm40 = st.blocks.find((b) => b.blockCode === 'PM40')!
    expect(pm40).toMatchObject({ rateBp: 4000, act: '1961', additionsHalfRate: R(60000), totalDepreciation: R(12000), closingWdv: R(48000), openingSource: 'none' })
    // FY 2026-27 under the 2025 Act carries the closing WDV forward: 48,000 × 40% = 19,200.
    const next = fa.itStatement(db, 2026).blocks.find((b) => b.blockCode === 'PM40')!
    expect(next).toMatchObject({ act: '2025', openingWdv: R(48000), openingSource: 'carried', totalDepreciation: R(19200) })
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
    // An entered opening WDV wins over the carried one.
    fa.setBlockOpening(db, { blockId: pm40.blockId, fyStartYear: 2026, openingWdv: R(100000) })
    expect(fa.itStatement(db, 2026).blocks.find((b) => b.blockCode === 'PM40')).toMatchObject({ openingSource: 'entered', openingWdv: R(100000) })
  })

  it('a sale of the only asset ends the block with a capital gain or loss figure', () => {
    const asset = fa.saveAsset(db, laptopInput())
    fa.postRun(db, '2025-04-01', '2026-03-31')
    fa.disposeAsset(db, { assetId: asset.id, date: '2026-10-01', kind: 'sale', proceedsPaise: R(30000), considerationLedgerId: bank })
    const b = fa.itStatement(db, 2026).blocks.find((x) => x.blockCode === 'PM40')!
    // IT WDV after FY25: 60,000 − 24,000 = 36,000; sold for 30,000 and nothing remains ⇒ STCL 6,000.
    expect(b.openingWdv).toBe(R(36000))
    expect(b.shortTermCapitalLoss).toBe(R(6000))
    expect(b.closingWdv).toBe(0)
  })
})

describe('year-end close preview', () => {
  it('warns while depreciation for the year has not been run to 31 March', () => {
    fa.saveAsset(db, laptopInput())
    expect(closePreview(db, 2025).depreciation).toMatchObject({ missing: true, assetsInService: 1, coveredThrough: null })
    fa.postRun(db, '2025-04-01', '2025-12-31')
    expect(closePreview(db, 2025).depreciation).toMatchObject({ missing: true, coveredThrough: '2025-12-31' })
    fa.postRun(db, '2026-01-01', '2026-03-31')
    expect(closePreview(db, 2025).depreciation.missing).toBe(false)
  })
})
