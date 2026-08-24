import { describe, expect, it } from 'vitest'
import { suggestNarration } from './autoNarration'

describe('suggestNarration', () => {
  it('writes a sale from its items and its buyer', () => {
    expect(
      suggestNarration({ kind: 'sales', partyName: 'Umbrella Retail', itemNames: ['Laptop 14"'] })
    ).toBe('Sold Laptop 14" to Umbrella Retail')
  })

  it('writes a purchase the other way round', () => {
    expect(
      suggestNarration({ kind: 'purchase', partyName: 'Bharat Steel', itemNames: ['MS Angle'] })
    ).toBe('Purchased MS Angle from Bharat Steel')
  })

  it('writes a payment from its accounts', () => {
    expect(
      suggestNarration({ kind: 'payment', partyName: 'Landlord', accountNames: ['Office Rent'] })
    ).toBe('Paid Office Rent to Landlord')
  })

  it('manages with only a party', () => {
    expect(suggestNarration({ kind: 'receipt', partyName: 'Krishna Enterprises' })).toBe(
      'Received from Krishna Enterprises'
    )
  })

  it('manages with only a subject', () => {
    expect(suggestNarration({ kind: 'payment', accountNames: ['Electricity'] })).toBe('Paid Electricity')
  })

  it('lists two and three names in words, and abbreviates beyond that', () => {
    expect(suggestNarration({ kind: 'sales', itemNames: ['A', 'B'] })).toBe('Sold A and B')
    expect(suggestNarration({ kind: 'sales', itemNames: ['A', 'B', 'C'] })).toBe('Sold A, B and C')
    expect(suggestNarration({ kind: 'sales', itemNames: ['A', 'B', 'C', 'D', 'E'] })).toBe(
      'Sold A, B, C and 2 more'
    )
  })

  it('does not repeat a name that appears on several lines', () => {
    expect(suggestNarration({ kind: 'sales', itemNames: ['Widget', 'Widget', 'Gadget'] })).toBe(
      'Sold Widget and Gadget'
    )
  })

  it('prefers items over accounts on a trading voucher', () => {
    // The items are what was traded; the sales ledger is bookkeeping.
    expect(
      suggestNarration({ kind: 'sales', partyName: 'Buyer', itemNames: ['Widget'], accountNames: ['Sales A/c'] })
    ).toBe('Sold Widget to Buyer')
  })

  it('says nothing at all rather than something generic', () => {
    // "Journal entry" as a narration is worse than a blank: it looks written and says nothing.
    expect(suggestNarration({ kind: 'journal' })).toBeNull()
    expect(suggestNarration({ kind: 'sales' })).toBeNull()
    expect(suggestNarration({ kind: 'sales', partyName: '   ', itemNames: [] })).toBeNull()
  })

  it('describes a journal by its accounts, since it has no natural verb', () => {
    expect(suggestNarration({ kind: 'journal', accountNames: ['Depreciation', 'Plant'] })).toBe(
      'Being Depreciation and Plant'
    )
  })

  it('ignores blank names rather than producing double spaces', () => {
    expect(suggestNarration({ kind: 'sales', partyName: 'Buyer', itemNames: ['', '  ', 'Widget'] })).toBe(
      'Sold Widget to Buyer'
    )
  })
})
