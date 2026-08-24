import { describe, it, expect } from 'vitest'
import {
  PORTABLE_FORMAT,
  PORTABLE_VERSION,
  canonicalisePortable,
  portableTotals,
  validatePortable,
  type PortableDoc
} from './portable'

function doc(over: Partial<PortableDoc> = {}): PortableDoc {
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: '2026-04-01T10:00:00.000Z',
    coverage: [],
    company: { name: 'Acme', stateCode: '27', gstin: null, pan: null, address: '', booksFrom: 2025 },
    groups: [
      { name: 'Current Assets', parent: null, nature: 'asset', affectsGrossProfit: false },
      { name: 'Cash-in-hand', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
      { name: 'Sales Accounts', parent: null, nature: 'income', affectsGrossProfit: true }
    ],
    ledgers: [
      { name: 'Cash', group: 'Cash-in-hand', openingBalance: 100000, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null },
      { name: 'Sales', group: 'Sales Accounts', openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null }
    ],
    voucherTypes: [{ name: 'Receipt', kind: 'receipt', numbering: 'auto', prefix: 'R' }],
    units: [],
    stockGroups: [],
    stockItems: [],
    godowns: [],
    vouchers: [
      {
        type: 'Receipt',
        number: 'R1',
        date: '2026-04-01',
        party: null,
        narration: null,
        reference: null,
        lines: [
          { ledger: 'Cash', drCr: 'dr', amount: 55500 },
          { ledger: 'Sales', drCr: 'cr', amount: 55500 }
        ],
        inventory: []
      }
    ],
    ...over
  }
}

describe('the open export format', () => {
  it('accepts a document that hangs together', () => {
    expect(validatePortable(doc())).toEqual([])
  })

  it('refuses a file that is not one of ours, and one from a future version', () => {
    expect(validatePortable({ hello: 'world' })[0]).toMatch(/not a Total books export/)
    expect(validatePortable({ ...doc(), version: 99 })[0]).toMatch(/version 99/)
  })

  it('refuses a voucher that does not balance', () => {
    const bad = doc()
    bad.vouchers[0]!.lines[1]!.amount = 55000
    expect(validatePortable(bad)[0]).toMatch(/does not balance/)
  })

  it('refuses references to things the file does not contain', () => {
    const orphanLedger = doc({ ledgers: [{ ...doc().ledgers[0]!, group: 'Nowhere' }] })
    expect(validatePortable(orphanLedger).some((p) => /group "Nowhere"/.test(p))).toBe(true)

    const orphanLine = doc()
    orphanLine.vouchers[0]!.lines[0]!.ledger = 'Petty Cash'
    expect(validatePortable(orphanLine).some((p) => /ledger "Petty Cash"/.test(p))).toBe(true)
  })

  it('refuses money that is not whole paise', () => {
    const fractional = doc()
    fractional.vouchers[0]!.lines[0]!.amount = 555.5
    expect(validatePortable(fractional).some((p) => /whole number of paise/.test(p))).toBe(true)
  })

  it('orders identically however the rows arrived, so two exports can be compared', () => {
    const forwards = canonicalisePortable(doc())
    const shuffled = doc()
    shuffled.groups.reverse()
    shuffled.ledgers.reverse()
    const backwards = canonicalisePortable(shuffled)
    expect(backwards.ledgers).toEqual(forwards.ledgers)
    expect(backwards.groups).toEqual(forwards.groups)
  })

  it('emits parent groups before their children, so an importer can insert in file order', () => {
    const ordered = canonicalisePortable(doc())
    const names = ordered.groups.map((g) => g.name)
    expect(names.indexOf('Current Assets')).toBeLessThan(names.indexOf('Cash-in-hand'))
  })

  it('states totals a reader can check without importing anything', () => {
    expect(portableTotals(doc())).toEqual({ vouchers: 1, debits: 55500, credits: 55500 })
  })
})
