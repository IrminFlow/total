import { describe, it, expect } from 'vitest'
import { computeMonthlyPay, daysInMonth } from './payroll'
import { parseTallyExport, parseTallyAmount, parseTallyDate, parseTallyQty, parseXml, collect, childText } from './tally'

describe('payroll engine', () => {
  const emp = { basic: 20_000_00, hra: 8_000_00, special: 4_000_00, pfEnabled: true, esiEnabled: true, ptEnabled: true }

  it('computes a full month with PF ceiling and PT', () => {
    const p = computeMonthlyPay(emp, 31, 31)
    expect(p.gross).toBe(32_000_00)
    // PF on min(basic 20,000, ceiling 15,000) = 1,800 each side
    expect(p.pfEmp).toBe(1_800_00)
    expect(p.pfEr).toBe(1_800_00)
    // Gross 32,000 > ESI limit 21,000 → no ESI
    expect(p.esiEmp).toBe(0)
    expect(p.pt).toBe(200_00)
    expect(p.net).toBe(32_000_00 - 1_800_00 - 200_00)
    // Employer cost now includes the EPFO admin 0.5% + EDLI 0.5% charges on the capped wage.
    expect(p.employerCost).toBe(32_000_00 + 1_800_00 + 75_00 + 75_00)
  })

  it('applies ESI below the limit with round-up-to-rupee', () => {
    const low = { basic: 12_000_00, hra: 4_000_00, special: 2_000_00, pfEnabled: true, esiEnabled: true, ptEnabled: true }
    const p = computeMonthlyPay(low, 30, 30)
    expect(p.gross).toBe(18_000_00)
    expect(p.esiEmp).toBe(135_00) // 0.75% of 18,000 = 135 exactly
    expect(p.esiEr).toBe(585_00) // 3.25% of 18,000
    const odd = computeMonthlyPay(low, 29, 30)
    // prorated gross 17,400 → 0.75% = 130.50 → rounds UP to 131
    expect(odd.esiEmp).toBe(131_00)
  })

  it('prorates by attendance', () => {
    const p = computeMonthlyPay(emp, 15.5, 31)
    expect(p.basic).toBe(10_000_00)
    expect(p.gross).toBe(16_000_00)
  })

  it('knows month lengths', () => {
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2024-02')).toBe(29)
    expect(daysInMonth('2026-08')).toBe(31)
  })
})

describe('tally value parsing', () => {
  it('parses amounts, dates and quantities', () => {
    expect(parseTallyAmount('-1,00,000.00')).toBe(-10000000)
    expect(parseTallyAmount('500')).toBe(50000)
    expect(parseTallyDate('20260815')).toBe('2026-08-15')
    expect(parseTallyDate('junk')).toBeNull()
    expect(parseTallyQty(' 2 Nos')).toBe(2000)
    expect(parseTallyQty('2.500 Kg')).toBe(2500)
  })
})

describe('tally XML import', () => {
  const xml = `<?xml version="1.0"?>
  <ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE>
      <GROUP NAME="Local Debtors"><PARENT>Sundry Debtors</PARENT></GROUP>
    </TALLYMESSAGE>
    <TALLYMESSAGE>
      <LEDGER NAME="Acme &amp; Sons">
        <PARENT>Local Debtors</PARENT>
        <OPENINGBALANCE>-2500.00</OPENINGBALANCE>
        <PARTYGSTIN>27AAPFU0939F1ZV</PARTYGSTIN>
        <LEDSTATENAME>Maharashtra</LEDSTATENAME>
      </LEDGER>
    </TALLYMESSAGE>
    <TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales">
        <DATE>20260710</DATE>
        <VOUCHERNUMBER>42</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Acme &amp; Sons</PARTYLEDGERNAME>
        <NARRATION>July supply</NARRATION>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Acme &amp; Sons</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-1180.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sales</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>1180.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`

  it('parses groups, ledgers and vouchers with Tally sign conventions', () => {
    const data = parseTallyExport(xml)
    expect(data.groups).toEqual([{ name: 'Local Debtors', parent: 'Sundry Debtors' }])
    expect(data.ledgers[0]).toMatchObject({
      name: 'Acme & Sons',
      parent: 'Local Debtors',
      opening: 250000, // Tally -2500 (Dr) -> our +2500 Dr
      gstin: '27AAPFU0939F1ZV',
      stateName: 'Maharashtra'
    })
    const v = data.vouchers[0]!
    expect(v).toMatchObject({ vchType: 'Sales', date: '2026-07-10', number: '42', party: 'Acme & Sons' })
    expect(v.lines).toEqual([
      { ledger: 'Acme & Sons', drCr: 'dr', amount: 118000 },
      { ledger: 'Sales', drCr: 'cr', amount: 118000 }
    ])
  })

  it('parses raw XML with attributes, entities and self-closing tags', () => {
    const root = parseXml('<A X="1&amp;2"><B/><C>text &#65;</C></A>')
    const a = root.children[0]!
    expect(a.attrs.X).toBe('1&2')
    expect(a.children.map((c) => c.tag)).toEqual(['B', 'C'])
    expect(childText(a, 'C')).toBe('text A')
    expect(collect(root, 'B')).toHaveLength(1)
  })
})
