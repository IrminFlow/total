// Screen registry (lib/screens.ts) — the invalidation families App.tsx refreshes when a screen
// becomes visible. Regression for the audit that reconciled families with the real useQuery keys:
// dead families are silent no-ops, missing ones leave sub-queries up to staleTime stale.
import { describe, expect, it } from 'vitest'
import { SCREENS, invalidationFamilies } from '../lib/screens'

describe('screen registry invalidation families', () => {
  it('stock-summary covers its expandable sub-queries (godown/batch breakdown)', () => {
    const fams = invalidationFamilies('stock-summary')
    expect(fams).toContain('stockSummary')
    expect(fams).toContain('stockAgeing')
    expect(fams).toContain('stockByGodown')
    expect(fams).toContain('stockBatches')
  })

  it('masters lists only families a query on it actually uses', () => {
    // The original audit stripped priceLevels/priceRates/batches because nothing on Masters
    // queried them. `priceLevels` is back, and legitimately: the Price lists tab (#128) queries
    // it. `priceRates` and `batches` still have no query anywhere on this screen.
    const fams = invalidationFamilies('masters')
    expect(fams).toContain('priceLevels')
    expect(fams).not.toContain('priceRates')
    expect(fams).not.toContain('batches')
  })

  it('the price-list tab\'s version families are all invalidated', () => {
    // A missing family here serves a five-second-stale price list, which is the one thing a
    // versioned list must never do.
    const fams = invalidationFamilies('masters')
    expect(fams).toContain('priceVersions')
    expect(fams).toContain('priceListAsOn')
  })

  it('banking covers the foreign-currency tab (#140)', () => {
    const fams = invalidationFamilies('banking')
    expect(fams).toContain('fxAccounts')
    expect(fams).toContain('fxRevaluations')
  })

  it('stock-summary covers the three tabs that hang off it', () => {
    // Job work is NOT one of them. This lane built a job-work tab here; the merge kept the
    // ITC-04 lane's own screen instead, so the family that has to be refreshed is on THAT screen.
    const fams = invalidationFamilies('stock-summary')
    for (const f of ['serials', 'standardCosts', 'variance']) expect(fams).toContain(f)
  })

  it('job work refreshes the stock its challans now move (#127)', () => {
    const fams = invalidationFamilies('job-work')
    for (const f of ['jobWorkChallans', 'godowns', 'stockByGodown']) expect(fams).toContain(f)
  })

  it('exceptions covers the scratchpad (#46)', () => {
    expect(invalidationFamilies('exceptions')).toContain('scratchpad')
  })

  it('edocs targets the real list key family (edocList, not the removed "edocs")', () => {
    const fams = invalidationFamilies('edocs')
    expect(fams).toContain('edocList')
    expect(fams).not.toContain('edocs')
  })

  it('disclosure covers the two multi-GSTIN tabs it now hosts (#108, #355)', () => {
    // Neither has a screen of its own: every accelerator is taken, and both are documents an
    // auditor asks for, which is what this screen is for.
    const fams = invalidationFamilies('disclosure')
    for (const f of ['branchTransferRegister', 'isdDesk', 'gstRegistrations']) expect(fams).toContain(f)
  })

  it('no screen lists a family twice', () => {
    for (const s of SCREENS) {
      expect(new Set(s.invalidates).size).toBe(s.invalidates.length)
    }
  })
})
