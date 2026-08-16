import { describe, it, expect } from 'vitest'
import { buildTallyMastersXml, buildTallyVouchersXml } from './tallyExport'
import { parseTallyExport } from './tally'
import type { TallyGroup, TallyLedger, TallyUnit, TallyItem, TallyVoucher } from './tally'

describe('Tally XML export', () => {
  const groups: TallyGroup[] = [
    { name: 'Local Debtors', parent: 'Sundry Debtors' },
    { name: 'Raw Materials', parent: '' }
  ]
  const ledgers: TallyLedger[] = [
    { name: 'Acme & Sons', parent: 'Local Debtors', opening: 250000, gstin: '27AAPFU0939F1ZV', stateName: 'Maharashtra' },
    { name: 'Cash', parent: 'Cash-in-Hand', opening: -50000, gstin: null, stateName: null }
  ]
  const units: TallyUnit[] = [
    { name: 'Nos', decimals: 0 },
    { name: 'Kg', decimals: 3 }
  ]
  const items: TallyItem[] = [
    { name: 'Widget', unit: 'Nos', hsn: '8481', gstRate: 18, openingQtyMilli: 5000, openingValue: 100000 },
    { name: 'Bolt', unit: 'Kg', hsn: null, gstRate: null, openingQtyMilli: 0, openingValue: 0 },
    { name: 'Zero-rated part', unit: 'Nos', hsn: '9999', gstRate: 0, openingQtyMilli: 1000, openingValue: 5000 }
  ]

  it('round-trips masters through the parser', () => {
    const xml = buildTallyMastersXml({ groups, ledgers, units, items })
    const parsed = parseTallyExport(xml)
    expect(parsed.groups).toEqual(groups)
    expect(parsed.ledgers).toEqual(ledgers)
    expect(parsed.units).toEqual(units)
    expect(parsed.items).toEqual(items)
  })

  const vouchers: TallyVoucher[] = [
    {
      vchType: 'Sales',
      date: '2026-07-10',
      number: '42',
      party: 'Acme & Sons',
      narration: 'July supply',
      lines: [
        { ledger: 'Acme & Sons', drCr: 'dr', amount: 118000 },
        { ledger: 'Sales', drCr: 'cr', amount: 100000 },
        { ledger: 'Output CGST', drCr: 'cr', amount: 9000 },
        { ledger: 'Output SGST', drCr: 'cr', amount: 9000 }
      ],
      inventory: [{ item: 'Widget', qtyMilli: 2000, amount: 100000 }]
    },
    {
      vchType: 'Payment',
      date: '2026-07-15',
      number: '12',
      party: null,
      narration: null,
      lines: [
        { ledger: 'Rent', drCr: 'dr', amount: 25000 },
        { ledger: 'Cash', drCr: 'cr', amount: 25000 }
      ],
      inventory: []
    }
  ]

  it('round-trips vouchers (with inventory) through the parser', () => {
    const xml = buildTallyVouchersXml(vouchers)
    const parsed = parseTallyExport(xml)
    expect(parsed.vouchers).toEqual(vouchers)
  })

  it('serializes a debit line as a negative amount (Tally convention) and parses back dr / positive paise', () => {
    const xml = buildTallyVouchersXml([vouchers[0]!])
    expect(xml).toContain(
      '<LEDGERNAME>Acme &amp; Sons</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1180.00</AMOUNT>'
    )
    expect(xml).toContain(
      '<LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT>'
    )
    const parsed = parseTallyExport(xml)
    expect(parsed.vouchers[0]!.lines[0]).toEqual({ ledger: 'Acme & Sons', drCr: 'dr', amount: 118000 })
    expect(parsed.vouchers[0]!.lines[1]).toEqual({ ledger: 'Sales', drCr: 'cr', amount: 100000 })
  })

  it('XML-escapes &, <, >, and quotes in names', () => {
    const tricky: TallyGroup[] = [{ name: 'A & B <Co> "X" \'Y\'', parent: '' }]
    const xml = buildTallyMastersXml({ groups: tricky, ledgers: [], units: [], items: [] })
    expect(xml).not.toContain('<Co>')
    expect(xml).toContain('A &amp; B &lt;Co&gt; &quot;X&quot; &apos;Y&apos;')
    const parsed = parseTallyExport(xml)
    expect(parsed.groups[0]!.name).toBe('A & B <Co> "X" \'Y\'')
  })

  it('escapes special characters in a ledger/party name inside a voucher too', () => {
    const trickyVoucher: TallyVoucher = {
      vchType: 'Journal',
      date: '2026-08-01',
      number: '1',
      party: 'M/s "Best" & Co <India>',
      narration: 'note with & and <tag>',
      lines: [
        { ledger: 'M/s "Best" & Co <India>', drCr: 'dr', amount: 500_00 },
        { ledger: 'Suspense', drCr: 'cr', amount: 500_00 }
      ],
      inventory: []
    }
    const xml = buildTallyVouchersXml([trickyVoucher])
    const parsed = parseTallyExport(xml)
    expect(parsed.vouchers[0]).toEqual(trickyVoucher)
  })
})
