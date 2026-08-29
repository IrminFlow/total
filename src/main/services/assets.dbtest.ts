import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import {
  depreciationDraft,
  depreciationSchedule,
  deleteAsset,
  disposalDraft,
  ensureBlocks,
  listAssets,
  listBlocks,
  recordDepreciationRun,
  recordDisposal,
  saveAsset
} from './assets'

type Db = ReturnType<typeof seededDb>

/**
 * The register and the two schedules.
 *
 * What matters most: the two schedules genuinely differ (that is the point), a year already
 * posted does not silently recompute itself, an asset sold mid-year is depreciated up to the day
 * it left, and nothing here posts a voucher.
 */
function machine(db: Db, over: Record<string, unknown> = {}) {
  const block = listBlocks(db).find((b) => b.name === 'Plant and machinery — general')!
  return saveAsset(db, {
    name: (over.name as string) ?? 'Lathe',
    blockId: block.id,
    purchaseDate: '2026-04-01',
    putToUseDate: '2026-04-01',
    cost: 10_00_000_00,
    residualValue: 50_000_00,
    usefulLifeMonths: 180,
    method: 'slm',
    ...over
  } as never)
}

describe('the asset register', () => {
  it('seeds the common blocks once, and leaves an edited rate alone', () => {
    const db = seededDb()
    const first = ensureBlocks(db)
    expect(first.length).toBeGreaterThan(5)
    expect(first.find((b) => b.name === 'Computers and software')!.itRate).toBe(40)

    db.prepare('UPDATE asset_blocks SET it_rate = 35 WHERE name = ?').run('Computers and software')
    const again = ensureBlocks(db)
    expect(again.length).toBe(first.length)
    expect(again.find((b) => b.name === 'Computers and software')!.itRate).toBe(35)
  })

  it('caps the residual value at 5% of cost rather than losing the form', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db, { residualValue: 5_00_000_00 })
    expect(a.residualValue).toBe(50_000_00)
  })

  it('refuses an asset with no cost or no life', () => {
    const db = seededDb()
    ensureBlocks(db)
    expect(() => machine(db, { cost: 0 })).toThrow('must have a cost')
    expect(() => machine(db, { usefulLifeMonths: 0 })).toThrow('useful life')
  })

  it('reports book value as cost less what has actually been posted', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    expect(a.accumulated).toBe(0)
    expect(a.bookValue).toBe(a.cost)

    recordDepreciationRun(db, 2026, null)
    const after = listAssets(db).find((x) => x.id === a.id)!
    expect(after.accumulated).toBeGreaterThan(0)
    expect(after.bookValue).toBe(after.cost - after.accumulated)
  })
})

describe('the two schedules', () => {
  it('gives different numbers for the same asset, which is the point', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db)
    const s = depreciationSchedule(db, 2026)
    // Books: (10,00,000 − 50,000) / 15 years = 63,333.33 → floored.
    expect(s.companiesActTotal).toBe(Math.floor((9_50_000_00 / 15)))
    // Return: 15% of 10,00,000, full rate (put to use on 1 April).
    expect(s.incomeTaxTotal).toBe(1_50_000_00)
    expect(s.difference).toBe(s.companiesActTotal - s.incomeTaxTotal)
    expect(s.difference).not.toBe(0)
  })

  it('halves the tax rate for an asset put to use late in the year', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db, { purchaseDate: '2027-01-01', putToUseDate: '2027-01-01' })
    const s = depreciationSchedule(db, 2026)
    expect(s.incomeTaxTotal).toBe(75_000_00)
    // The books pro-rate by days instead, so they do not agree.
    expect(s.companiesAct[0]!.heldFraction).toBeLessThan(1)
  })

  it('counts an asset with no block in the books and not in the return', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db, { blockId: null })
    const s = depreciationSchedule(db, 2026)
    expect(s.unblocked).toBe(1)
    expect(s.companiesActTotal).toBeGreaterThan(0)
    expect(s.incomeTax).toEqual([])
  })

  it('leaves out an asset bought after the year ended', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db, { purchaseDate: '2028-01-01', putToUseDate: '2028-01-01' })
    const s = depreciationSchedule(db, 2026)
    expect(s.companiesAct).toEqual([])
  })

  it('carries the opening written-down value from what was posted, not a recomputation', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDepreciationRun(db, 2026, null)
    const year2 = depreciationSchedule(db, 2027)
    const row = year2.companiesAct.find((r) => r.assetId === a.id)!
    expect(row.openingWdv).toBe(a.cost - Math.floor(9_50_000_00 / 15))
  })

  it('refuses to post the same year twice', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db)
    recordDepreciationRun(db, 2026, null)
    expect(() => recordDepreciationRun(db, 2026, null)).toThrow('already been posted')
    expect(depreciationSchedule(db, 2026).alreadyPosted).toBe(true)
  })

  it('produces a balanced draft and posts nothing', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db)
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const draft = depreciationDraft(db, 2026)!
    expect(draft.lines).toHaveLength(2)
    expect(draft.lines[0]!.drCr).toBe('dr')
    expect(draft.lines[1]!.drCr).toBe('cr')
    expect(draft.lines[0]!.amount).toBe(draft.lines[1]!.amount)
    // Only the Companies Act figure goes in the books — the tax number would make them wrong.
    expect(draft.total).toBe(depreciationSchedule(db, 2026).companiesActTotal)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
  })

  it('has no draft in a year with nothing to depreciate', () => {
    const db = seededDb()
    ensureBlocks(db)
    expect(depreciationDraft(db, 2026)).toBeNull()
  })
})

describe('disposal', () => {
  it('depreciates up to the day it left, not for the whole year', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDisposal(db, a.id, '2026-09-30', 8_00_000_00)
    const s = depreciationSchedule(db, 2026)
    const row = s.companiesAct.find((r) => r.assetId === a.id)!
    expect(row.heldFraction).toBeLessThan(1)
    expect(row.heldFraction).toBeGreaterThan(0.4)
    expect(row.disposedOn).toBe('2026-09-30')
  })

  it('books a profit for the accounts and reduces the block for the return', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDepreciationRun(db, 2026, null)
    const draft = disposalDraft(db, a.id, '2027-06-01', 11_00_000_00)
    expect(draft.profitOrLoss).toBe(11_00_000_00 - draft.bookValue)
    expect(draft.incomeTaxTreatment).toContain('no gain or loss on the asset itself')
    const dr = draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
  })

  it('books a loss the other way round, still balanced', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    const draft = disposalDraft(db, a.id, '2026-06-01', 1_00_000_00)
    expect(draft.profitOrLoss).toBeLessThan(0)
    expect(draft.lines.some((l) => l.ledgerName === 'Loss on Sale of Assets' && l.drCr === 'dr')).toBe(true)
    const dr = draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
  })

  it('refuses to dispose of the same asset twice', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDisposal(db, a.id, '2026-09-30', 1_00_000_00)
    expect(() => recordDisposal(db, a.id, '2026-10-30', 1_00_000_00)).toThrow('already disposed')
    expect(() => disposalDraft(db, a.id, '2026-10-30', 1_00_000_00)).toThrow('already disposed')
  })

  it('hides a disposed asset from the register unless asked', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDisposal(db, a.id, '2026-09-30', 1_00_000_00)
    expect(listAssets(db)).toEqual([])
    expect(listAssets(db, { includeDisposed: true })).toHaveLength(1)
  })

  it('refuses to delete an asset that has been depreciated in a posted run', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db)
    recordDepreciationRun(db, 2026, null)
    expect(() => deleteAsset(db, a.id)).toThrow('dispose of it instead')
  })
})

describe('assets older than the register', () => {
  it('starts from what was already depreciated, not from full cost', () => {
    const db = seededDb()
    ensureBlocks(db)
    // A 2018 machine, half written off by the time this app was installed.
    const old = machine(db, { purchaseDate: '2018-04-01', putToUseDate: '2018-04-01', openingAccumulated: 5_00_000_00 })
    expect(old.accumulated).toBe(5_00_000_00)
    expect(old.bookValue).toBe(5_00_000_00)

    const s = depreciationSchedule(db, 2026)
    const row = s.companiesAct.find((r) => r.assetId === old.id)!
    expect(row.openingWdv).toBe(5_00_000_00)
    // Straight line is still on cost less residual, but it stops at the residual sooner.
    expect(row.closingWdv).toBe(row.openingWdv - row.depreciation)
  })

  it('cannot be given more opening depreciation than it has value to lose', () => {
    const db = seededDb()
    ensureBlocks(db)
    const a = machine(db, { openingAccumulated: 99_00_000_00 })
    expect(a.accumulated).toBe(10_00_000_00 - 50_000_00)
  })

  it('takes a tax written-down value that is not its book value', () => {
    const db = seededDb()
    ensureBlocks(db)
    // The books say five lakh is left; the block says three, because they depreciate differently.
    const a = machine(db, {
      purchaseDate: '2018-04-01', putToUseDate: '2018-04-01',
      openingAccumulated: 5_00_000_00, openingTaxWdv: 3_00_000_00
    })
    expect(a.bookValue).toBe(5_00_000_00)
    expect(a.taxWdv).toBe(3_00_000_00)

    const s = depreciationSchedule(db, 2026)
    const block = s.incomeTax.find((b) => b.blockName === 'Plant and machinery — general')!
    // 15% of the TAX value, not of the book value.
    expect(block.openingWdv).toBe(3_00_000_00)
    expect(block.depreciation).toBe(45_000_00)
  })
})

describe('the tax block rolls forward on its own rate', () => {
  it('does not derive next year from the Companies Act charge', () => {
    const db = seededDb()
    ensureBlocks(db)
    const computers = listBlocks(db).find((b) => b.name === 'Computers and software')!
    // A computer: three-year straight line in the books, 40% written-down value in the return.
    const pc = saveAsset(db, {
      name: 'Workstation', blockId: computers.id,
      purchaseDate: '2026-04-01', putToUseDate: '2026-04-01',
      cost: 90_000_00, residualValue: 0, usefulLifeMonths: 36, method: 'slm'
    } as never)

    const y1 = depreciationSchedule(db, 2026)
    const y1row = y1.companiesAct.find((r) => r.assetId === pc.id)!
    expect(y1.incomeTaxTotal).toBe(36_000_00) // 40% of 90,000
    expect(y1row.taxDepreciation).toBe(36_000_00)
    expect(y1row.depreciation).not.toBe(y1row.taxDepreciation)

    recordDepreciationRun(db, 2026, null)

    const y2 = depreciationSchedule(db, 2027)
    const block = y2.incomeTax.find((b) => b.blockName === computers.name)!
    // 90,000 − 36,000 = 54,000 at 40% = 21,600. Deriving it from the books' charge would have
    // opened at 60,000 and given 24,000.
    expect(block.openingWdv).toBe(54_000_00)
    expect(block.depreciation).toBe(21_600_00)
  })

  it('splits a block charge across its assets so the parts sum to the whole', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db, { name: 'Lathe A', cost: 6_00_000_00 })
    machine(db, { name: 'Lathe B', cost: 4_00_000_00 })
    const s = depreciationSchedule(db, 2026)
    const block = s.incomeTax.find((b) => b.blockName === 'Plant and machinery — general')!
    const parts = s.companiesAct.reduce((t, r) => t + r.taxDepreciation, 0)
    expect(parts).toBe(block.depreciation)
  })

  it('allows nothing on an asset bought in-year but never put to use', () => {
    const db = seededDb()
    ensureBlocks(db)
    machine(db, { purchaseDate: '2027-03-01', putToUseDate: '2027-06-01' })
    const s = depreciationSchedule(db, 2026)
    // Not even the half rate: section 32 needs the asset in use.
    expect(s.incomeTaxTotal).toBe(0)
    expect(s.companiesActTotal).toBe(0)
  })
})
