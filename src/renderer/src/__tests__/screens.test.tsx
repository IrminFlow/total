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

  it('masters no longer lists families no query uses (priceLevels/priceRates/batches)', () => {
    const fams = invalidationFamilies('masters')
    expect(fams).not.toContain('priceLevels')
    expect(fams).not.toContain('priceRates')
    expect(fams).not.toContain('batches')
  })

  it('edocs targets the real list key family (edocList, not the removed "edocs")', () => {
    const fams = invalidationFamilies('edocs')
    expect(fams).toContain('edocList')
    expect(fams).not.toContain('edocs')
  })

  it('no screen lists a family twice', () => {
    for (const s of SCREENS) {
      expect(new Set(s.invalidates).size).toBe(s.invalidates.length)
    }
  })
})
