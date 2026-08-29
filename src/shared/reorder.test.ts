import { describe, it, expect } from 'vitest'
import { buildReorderMessages, type ReorderSupplier } from './reorder'
import type { PurchaseSuggestionRow } from './reports'

const row = (over: Partial<PurchaseSuggestionRow> = {}): PurchaseSuggestionRow => ({
  stockItemId: 1,
  name: 'Bolts',
  unitSymbol: 'Nos',
  decimals: 2,
  closingQtyMilli: 2000,
  reorderLevelMilli: 10_000,
  shortfallQtyMilli: 8000,
  lastSupplier: 'Acme Hardware',
  lastSupplierLedgerId: 7,
  lastPurchaseDate: '2026-05-01',
  lastRatePaise: 12_500,
  estimatedCost: 100_000,
  ...over
})

const supplier = (over: Partial<ReorderSupplier> = {}): ReorderSupplier => ({
  ledgerId: 7,
  name: 'Acme Hardware',
  email: 'sales@acme.example',
  phone: '9876543210',
  ...over
})

const company = { name: 'Demo Traders' }

describe('buildReorderMessages', () => {
  it('writes one message per supplier, listing everything to order from them', () => {
    const { messages } = buildReorderMessages(
      company,
      [row(), row({ stockItemId: 2, name: 'Nuts', shortfallQtyMilli: 4000, estimatedCost: 20_000 })],
      new Map([[7, supplier()]]),
      '2026-08-24'
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.items).toHaveLength(2)
    expect(messages[0]!.estimatedTotal).toBe(120_000)
    expect(messages[0]!.body).toContain('Bolts  —  8.00 Nos')
    expect(messages[0]!.body).toContain('Nuts  —  4.00 Nos')
    expect(messages[0]!.body).toContain('Demo Traders')
  })

  it('offers a wa.me link when the number is usable, and always an email draft', () => {
    const { messages } = buildReorderMessages(company, [row()], new Map([[7, supplier()]]), '2026-08-24')
    const m = messages[0]!
    expect(m.whatsapp).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    expect(m.mailto).toContain('mailto:sales@acme.example')
    // One body, both channels: what is previewed is what the supplier receives.
    expect(decodeURIComponent(m.whatsapp!.split('text=')[1]!)).toBe(m.body)
  })

  it('has no WhatsApp link when the number is not one WhatsApp can use', () => {
    const { messages } = buildReorderMessages(company, [row()], new Map([[7, supplier({ phone: '12345' })]]), '2026-08-24')
    expect(messages[0]!.whatsapp).toBeNull()
    expect(messages[0]!.mailto).toContain('mailto:sales@acme.example')
  })

  it('still drafts an email with no address, so the user can type one in', () => {
    const { messages } = buildReorderMessages(
      company,
      [row()],
      new Map([[7, supplier({ email: null, phone: null })]]),
      '2026-08-24'
    )
    expect(messages[0]!.mailto).toContain('mailto:?subject=')
  })

  it('lists items nobody can be asked for separately instead of dropping them', () => {
    const never = row({ stockItemId: 3, name: 'Widgets', lastSupplier: null, lastSupplierLedgerId: null, lastRatePaise: null, estimatedCost: null })
    const { messages, unsourced } = buildReorderMessages(company, [row(), never], new Map([[7, supplier()]]), '2026-08-24')
    expect(messages).toHaveLength(1)
    expect(unsourced.map((r) => r.name)).toEqual(['Widgets'])
  })

  it('treats a supplier ledger that no longer exists as unreachable', () => {
    const { messages, unsourced } = buildReorderMessages(company, [row({ lastSupplierLedgerId: 99 })], new Map(), '2026-08-24')
    expect(messages).toEqual([])
    expect(unsourced).toHaveLength(1)
  })

  it('omits the price line when nothing has ever been bought at a known rate', () => {
    const { messages } = buildReorderMessages(
      company,
      [row({ lastRatePaise: null, estimatedCost: null })],
      new Map([[7, supplier()]]),
      '2026-08-24'
    )
    expect(messages[0]!.estimatedTotal).toBe(0)
    expect(messages[0]!.body).not.toContain('Approximately')
    expect(messages[0]!.body).toContain('Please confirm your current rates')
  })

  it('puts the biggest order first, so the call worth making is at the top', () => {
    const suppliers = new Map([
      [7, supplier()],
      [8, supplier({ ledgerId: 8, name: 'Beta Supplies' })]
    ])
    const { messages } = buildReorderMessages(
      company,
      [row({ estimatedCost: 5000 }), row({ stockItemId: 2, lastSupplierLedgerId: 8, estimatedCost: 900_000 })],
      suppliers,
      '2026-08-24'
    )
    expect(messages.map((m) => m.supplierName)).toEqual(['Beta Supplies', 'Acme Hardware'])
  })

  it('says nothing at all when nothing is below its reorder level', () => {
    expect(buildReorderMessages(company, [], new Map(), '2026-08-24')).toEqual({
      asOn: '2026-08-24',
      messages: [],
      unsourced: []
    })
  })
})
