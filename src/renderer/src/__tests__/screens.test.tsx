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

  it('masters lists only families a query uses (batches has none; the WP 2.6 pricing tabs do)', () => {
    const fams = invalidationFamilies('masters')
    expect(fams).toEqual(expect.arrayContaining(['priceLevels', 'priceRates', 'pricingGrid', 'partyRates', 'discountSchemes']))
    expect(fams).not.toContain('batches')
  })

  it('Counter billing sits in the top block after Manufacture, gated on inventory (WP 2.6)', () => {
    const top = SCREENS.filter((s) => s.navSection === 'top').map((s) => s.name)
    expect(top.indexOf('counter-billing')).toBe(top.indexOf('manufacture') + 1)
    expect(SCREENS.find((s) => s.name === 'counter-billing')).toMatchObject({ feature: 'inventory', navLabel: 'Counter' })
  })

  it('edocs targets the real list key family (edocList, not the removed "edocs")', () => {
    const fams = invalidationFamilies('edocs')
    expect(fams).toContain('edocList')
    expect(fams).not.toContain('edocs')
  })

  it('Manufacture sits in the top block directly under Voucher entry, gated on inventory (WP 2.2)', () => {
    const top = SCREENS.filter((s) => s.navSection === 'top').map((s) => s.name)
    expect(top.indexOf('manufacture')).toBe(top.indexOf('voucher-entry') + 1)
    expect(SCREENS.find((s) => s.name === 'manufacture')).toMatchObject({ title: 'Manufacture', feature: 'inventory' })
    expect(invalidationFamilies('manufacture-register')).toEqual(['manufactureRegister'])
  })

  it('no screen lists a family twice', () => {
    for (const s of SCREENS) {
      expect(new Set(s.invalidates).size).toBe(s.invalidates.length)
    }
  })
})
