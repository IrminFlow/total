import { describe, expect, it } from 'vitest'
import {
  decimalToScaled, parseBool, parseDate, parseDrCr, parseGstin, parseHsn, parseMoney, parsePan, parsePercent, parseQty, parseSignedMoney, parseState
} from './values'
import { applyMapping, autoMap, detectHeaderRow, headerSignature, mappingByName, mappingFromNames, normalizeHeader, tableFrom } from './detect'
import { detectProfile, PROFILES, rankProfiles } from './profiles'
import { parseTarget, TARGETS, kindFromWord, type MappedRecord, type VoucherDraft } from './targets'
import { buildInvoiceVoucher, lineTax, special, type InvoiceIn } from './invoiceBuild'
import { BUSY_GROUP_MAP, busySaleType, busyTaxCategoryRate, mapBusyGroup, parseBusyXml } from './busy'
import { zohoTaxRate } from './zoho'
import { BOOKS_SHEETS, booksHeader, readManifest } from './books'
import { DEFAULT_GROUPS } from '../seed'
import { decimalCommaLike, normalizeDecimalComma } from './values'
import { parseTallyRate } from '../tally'

const ok = <T>(v: T): { ok: T } => ({ ok: v })

describe('value parsers', () => {
  it('money: Indian grouping, ₹/Rs, brackets, trailing minus, float noise from Excel formulas', () => {
    expect(parseMoney('1,23,456.78')).toEqual(ok(12345678))
    expect(parseMoney('₹ 500')).toEqual(ok(50000))
    expect(parseMoney('Rs. 12.5')).toEqual(ok(1250))
    expect(parseMoney('(1,000.00)')).toEqual(ok(-100000))
    expect(parseMoney('250-')).toEqual(ok(-25000))
    expect(parseMoney('1234.5000000001')).toEqual(ok(123450))
    expect(parseMoney('0.005')).toEqual(ok(1))
    expect(parseMoney('')).toEqual(ok(null))
    expect(parseMoney('abc')).toEqual({ error: '"abc" is not an amount' })
    expect(decimalToScaled('-2.4449', 2)).toBe(-244)
  })
  it('signed money with Dr/Cr suffix, prefix or a separate column', () => {
    expect(parseSignedMoney('15,000.00 Dr')).toEqual(ok(1500000))
    expect(parseSignedMoney('500 Cr')).toEqual(ok(-50000))
    expect(parseSignedMoney('Cr 500')).toEqual(ok(-50000))
    expect(parseSignedMoney('500', 'Credit')).toEqual(ok(-50000))
    expect(parseSignedMoney('-500')).toEqual(ok(-50000))
    expect(parseDrCr('By')).toEqual(ok('dr'))
    expect('error' in parseDrCr('maybe')).toBe(true)
  })
  it('quantities with units, percent, bool', () => {
    expect(parseQty('2.500 Kg')).toEqual(ok(2500))
    expect(parseQty('1,000')).toEqual(ok(1000000))
    expect(parseQty('0.0005')).toEqual(ok(1))
    expect(parsePercent('18%')).toEqual(ok(18))
    expect('error' in parsePercent('118')).toBe(true)
    expect(parseBool('Yes')).toEqual(ok(true))
  })
  it('dates in every export format, with the d/m order switch', () => {
    expect(parseDate('2025-04-01')).toEqual(ok('2025-04-01'))
    expect(parseDate('2025-04-01T00:00:00')).toEqual(ok('2025-04-01'))
    expect(parseDate('01/04/2025')).toEqual(ok('2025-04-01'))
    expect(parseDate('01/04/2025', 'mdy')).toEqual(ok('2025-01-04'))
    expect(parseDate('1-Apr-25')).toEqual(ok('2025-04-01'))
    expect(parseDate('15 April 2025')).toEqual(ok('2025-04-15'))
    expect(parseDate('Apr 15, 2025')).toEqual(ok('2025-04-15'))
    expect(parseDate('20250401')).toEqual(ok('2025-04-01'))
    expect(parseDate('08.04.2026 10:30')).toEqual(ok('2026-04-08'))
    expect(parseDate('45748')).toEqual(ok('2025-04-01'))
    expect('error' in parseDate('31/02/2025')).toBe(true)
  })
  it('GSTIN (checksum), PAN, HSN and states through the shared GST validators', () => {
    expect(parseGstin('27aapfu0939f1zv')).toEqual(ok('27AAPFU0939F1ZV'))
    expect(parseGstin('URP')).toEqual(ok(null))
    expect((parseGstin('27AAPFU0939F1ZX') as { error: string }).error).toMatch(/checksum/)
    expect(parsePan('abcde1234f')).toEqual(ok('ABCDE1234F'))
    expect('error' in parsePan('ABCD1234F')).toBe(true)
    expect(parseHsn('7326.0')).toEqual(ok('7326'))
    expect('error' in parseHsn('732')).toBe(true)
    expect(parseState('TN')).toEqual(ok('33'))
    expect(parseState('27-Maharashtra')).toEqual(ok('27'))
    expect(parseState('Jammu and Kashmir')).toEqual(ok('01'))
    expect(parseState('Karnataka (29)')).toEqual(ok('29'))
    expect('error' in parseState('Atlantis')).toBe(true)
  })
})

describe('column detection', () => {
  it('normalises headers and auto-maps aliases one column per field', () => {
    expect(normalizeHeader(' Op. Bal. (Dr/Cr) ')).toBe('opbaldrcr')
    const m = autoMap(['Ledger Name', 'Under', 'Op. Bal.', 'GST No'], TARGETS.ledgers.fields)
    expect(m).toMatchObject({ name: 0, group: 1, opening: 2, gstin: 3, pan: null })
  })
  it('finds the header under a title block and keeps blank-named columns addressable', () => {
    const grid = { rows: [{ line: 1, cells: ['Acme Pvt Ltd'] }, { line: 2, cells: ['Ledger list', ''] }, { line: 4, cells: ['Name', 'Group', ''] }, { line: 5, cells: ['A', 'B', 'x'] }] }
    const i = detectHeaderRow(grid, [TARGETS.ledgers.fields])
    expect(i).toBe(2)
    const t = tableFrom(grid, i)
    expect(t.headers).toEqual(['Name', 'Group', 'Column 3'])
    expect(applyMapping(t, { name: 0, group: 1 })).toEqual([{ line: 5, values: { name: 'A', group: 'B' } }])
  })
  it('templates store header names (order-proof) with a stable signature', () => {
    const t = { headers: ['A', 'B'], rows: [] }
    expect(mappingFromNames(['b', 'x', 'a'], mappingByName(t, { name: 0, group: 1 }))).toEqual({ name: 2, group: 0 })
    expect(headerSignature(['B', 'a'])).toBe(headerSignature(['A', 'b']))
  })
  it('recognises Zoho and Busy exports by their headers, and plain layouts as generic', () => {
    expect(detectProfile(['Invoice Date', 'Invoice ID', 'Invoice Number', 'Invoice Status', 'Customer Name', 'Item Name', 'Quantity', 'Item Price', 'Item Total', 'Item Tax %', 'Item Tax Amount', 'Total'])?.profileId).toBe('zoho:invoices')
    expect(detectProfile(['Bill Date', 'Bill ID', 'Bill Number', 'Vendor Name', 'Bill Status', 'Item Total', 'Accounts Payable'])?.profileId).toBe('zoho:bills')
    expect(detectProfile(['Account ID', 'Account Name', 'Account Code', 'Account Type', 'Parent Account'])?.profileId).toBe('zoho:accounts')
    expect(detectProfile(['Journal Date', 'Journal Number', 'Journal Type', 'Account', 'Debit', 'Credit'])?.profileId).toBe('zoho:journals')
    expect(detectProfile(['Acc_name', 'Account Group', 'Op. Bal.', 'Dr/Cr', 'GSTNo'])?.profileId).toBe('busy:accounts')
    expect(detectProfile(['Voucher/Bill Date', 'Voucher/Bill Number', 'Sale Type', 'Party Name', 'Material Centre', 'Item Name', 'Quantity', 'Price'])?.profileId).toBe('busy:sales')
    expect(detectProfile(['Name', 'Group', 'Opening Balance', 'GSTIN'])?.profileId).toBe('generic:ledgers')
    expect(detectProfile(['Voucher Type', 'Date', 'Number', 'Ledger', 'Debit', 'Credit'])?.profileId).toBe('generic:vouchers')
    expect(detectProfile(['Date', 'Narration', 'Chq./Ref.No.', 'Withdrawal Amt.', 'Deposit Amt.'])?.profileId).toBe('generic:bank')
    expect(rankProfiles([]).every((g) => g.score <= 2)).toBe(true)
  })
  it('every profile has unique field keys and required fields', () => {
    for (const p of PROFILES) expect(new Set(p.fields.map((f) => f.key)).size).toBe(p.fields.length)
  })
})

const rec = (line: number, values: Record<string, string>): MappedRecord => ({ line, values })

describe('canonical parsing', () => {
  it('vouchers: keyed rows group, continuation rows join the voucher above, Debit/Credit or Amount + Dr/Cr', () => {
    const { result, errors } = parseTarget('vouchers', [
      rec(2, { type: 'Journal', date: '01-05-2025', number: 'J1', ledger: 'Rent', debit: '100' }),
      rec(3, { ledger: 'Cash', credit: '100' }),
      rec(4, { type: 'Payment', date: '02-05-2025', number: 'P1', ledger: 'Rent', amount: '50', drCr: 'Dr' }),
      rec(5, { type: 'Payment', date: '02-05-2025', number: 'P1', ledger: 'Cash', amount: '-50' }),
      rec(6, { ledger: 'Orphan', amount: '5' })
    ])
    const rows = (result as { rows: VoucherDraft[] }).rows
    expect(rows.map((v) => [v.number, v.kind, v.ledgerLines.map((l) => `${l.ledger} ${l.drCr} ${l.amount}`)])).toEqual([
      ['J1', 'journal', ['Rent dr 10000', 'Cash cr 10000']],
      ['P1', 'payment', ['Rent dr 5000', 'Cash cr 5000', 'Orphan dr 500']]
    ])
    expect(errors).toEqual([])
  })
  it('vouchers: a bad line rejects its whole voucher; items default direction and amount', () => {
    const { result, errors } = parseTarget('vouchers', [
      rec(2, { key: 'A', type: 'Sales', date: '2025-05-01', ledger: 'Party', debit: '118' }),
      rec(3, { key: 'A', item: 'Widget', qty: '2', rate: '50' }),
      rec(4, { key: 'B', type: 'Sales', date: 'not a date', ledger: 'X', debit: '1' })
    ])
    const rows = (result as { rows: VoucherDraft[] }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.items).toEqual([expect.objectContaining({ qtyMilli: 2000, ratePaise: 5000, amount: 10000, direction: null })])
    expect(errors).toEqual([expect.objectContaining({ line: 4, field: 'date' })])
    expect(kindFromWord('Sale Return')).toBe('credit_note')
    expect(kindFromWord('Rcpt')).toBe('receipt')
  })
  it('openings: signed, Dr/Cr column or Debit/Credit columns', () => {
    const { result } = parseTarget('openings', [rec(2, { ledger: 'A', opening: '100', drCr: 'Cr' }), rec(3, { ledger: 'B', debit: '40', credit: '' }), rec(4, { ledger: 'C', opening: '60 Dr' })])
    expect((result as { rows: { opening: number }[] }).rows.map((r) => r.opening)).toEqual([-10000, 4000, 6000])
  })
  it('bank lines: separate columns or one signed amount', () => {
    const { result, errors } = parseTarget('bank', [rec(2, { date: '05/05/2025', withdrawal: '1,000.00' }), rec(3, { date: '06/05/2025', amount: '250' }), rec(4, { date: '07/05/2025' })])
    expect((result as { rows: { deposit: number; withdrawal: number }[] }).rows.map((r) => [r.deposit, r.withdrawal])).toEqual([[0, 100000], [25000, 0]])
    expect(errors[0]!.message).toMatch(/No deposit or withdrawal/)
  })
})

describe('invoice builder (Zoho / Busy)', () => {
  const base: InvoiceIn = {
    key: 'k', kind: 'sales', typeName: 'Sales', date: '2025-06-01', number: 'I1', party: 'P', reference: null, narration: null,
    placeOfSupply: '27', companyState: '27', lines: [], charges: [], total: null, dueDate: null, billRef: 'I1', godown: null
  }
  const line = { line: 2, account: null, item: null, qtyMilli: null, ratePaise: null, cgst: null, sgst: null, igst: null, cess: null, taxAmount: null, taxRate: 18, taxName: null }
  it('splits intra-state tax CGST/SGST (odd paisa to SGST) and inter-state to IGST', () => {
    expect(lineTax(base, { ...line, taxable: 1001, taxAmount: 181 })).toEqual({ cgst: 90, sgst: 91, igst: 0, cess: 0 })
    expect(lineTax({ ...base, placeOfSupply: '29' }, { ...line, taxable: 1000 })).toEqual({ cgst: 0, sgst: 0, igst: 180, cess: 0 })
    expect(lineTax(base, { ...line, taxable: 1000, taxName: 'IGST18' })).toMatchObject({ igst: 180 })
  })
  it('balances against the document total with a round-off, refuses a real mismatch', () => {
    const { draft } = buildInvoiceVoucher({ ...base, lines: [{ ...line, taxable: 10000 }], total: 11850 })
    expect(draft!.ledgerLines.map((l) => `${l.ledger} ${l.drCr} ${l.amount}`)).toEqual([
      'P dr 11850', `${special('sales')} cr 10000`, `${special('tax:output:cgst')} cr 900`, `${special('tax:output:sgst')} cr 900`, `${special('roundoff')} cr 50`
    ])
    expect(buildInvoiceVoucher({ ...base, lines: [{ ...line, taxable: 10000 }], total: 20000 }).error).toMatch(/document total/)
  })
  it('a purchase debits expense and input tax; a credit note reverses a sale', () => {
    const p = buildInvoiceVoucher({ ...base, kind: 'purchase', lines: [{ ...line, taxable: 1000 }] }).draft!
    expect(p.ledgerLines.map((l) => `${l.ledger} ${l.drCr}`)).toEqual(['P cr', `${special('purchase')} dr`, `${special('tax:input:cgst')} dr`, `${special('tax:input:sgst')} dr`])
    const cn = buildInvoiceVoucher({ ...base, kind: 'credit_note', lines: [{ ...line, taxable: 1000 }] }).draft!
    expect(cn.ledgerLines.map((l) => `${l.ledger} ${l.drCr}`)).toEqual(['P cr', `${special('sales')} dr`, `${special('tax:output:cgst')} dr`, `${special('tax:output:sgst')} dr`])
  })
})

describe('source helpers', () => {
  it('Busy groups map onto the chart; sale types and tax categories', () => {
    const chart = new Set(DEFAULT_GROUPS.map((g) => g.name))
    for (const target of Object.values(BUSY_GROUP_MAP)) expect(chart.has(target)).toBe(true)
    expect(mapBusyGroup('Expenses (Indirect/Admn.)')).toBe('Indirect Expenses')
    expect(mapBusyGroup('My Own Group')).toBe('My Own Group')
    expect(busySaleType('L/GST-18%')).toEqual({ inter: false, rate: 18 })
    expect(busySaleType('I/GST-12%')).toEqual({ inter: true, rate: 12 })
    expect(busySaleType('L/GST-ItemWise')).toEqual({ inter: false, rate: null })
    expect(busyTaxCategoryRate('GST 5%')).toBe(5)
    expect(busyTaxCategoryRate('Exempt')).toBe(0)
    expect(zohoTaxRate('IGST18')).toBe(18)
    expect(zohoTaxRate('GST18 (18 %)')).toBe(18)
  })
  it('Busy XML: accounts sign-flipped, vouchers from AccEntries, a voucher without them warned', () => {
    const x = parseBusyXml(`<BusyData><Accounts><Account><Name>A</Name><ParentGroup>Sundry Debtors</ParentGroup><OPBal>-10.50</OPBal></Account></Accounts>
      <Jrnls><Jrnl><Date>01-05-2025</Date><VchNo>9</VchNo></Jrnl></Jrnls></BusyData>`)
    expect(x.ledgers[0]).toMatchObject({ name: 'A', group: 'Sundry Debtors', opening: 1050 })
    expect(x.vouchers).toEqual([])
    expect(x.warnings[0]).toMatch(/no account entries/)
  })
})

describe('books workbook layout', () => {
  it('every books column is a real target field, and the manifest is recognised', () => {
    for (const d of BOOKS_SHEETS) for (const c of d.columns) expect(booksHeader(d, c.field)).toBeTruthy()
    expect(readManifest({ rows: [{ line: 1, cells: ['Key', 'Value'] }, { line: 2, cells: ['format', 'total-books'] }, { line: 3, cells: ['schemaVersion', '1'] }] })).toMatchObject({ schemaVersion: 1 })
    expect(readManifest({ rows: [{ line: 1, cells: ['format', 'other'] }] })).toBeNull()
  })
})

describe('review fixes (WP 6.3)', () => {
  it('dates with upper-case month names (a "T" is not a time unless it is an ISO time)', () => {
    expect(parseDate('15-OCT-2025')).toEqual(ok('2025-10-15'))
    expect(parseDate('1 SEPT 2025')).toEqual(ok('2025-09-01'))
    expect(parseDate('01-AUG-25')).toEqual(ok('2025-08-01'))
    expect(parseDate('2025-10-15T10:30:00.000+05:30')).toEqual(ok('2025-10-15'))
    expect(parseDate('2025-10-15T10:30')).toEqual(ok('2025-10-15'))
  })
  it('decimal-comma numbers are refused, never misread — the option converts them', () => {
    expect(decimalCommaLike('1.234,56')).toBe(true)
    expect(decimalCommaLike('12,5')).toBe(true)
    expect(decimalCommaLike('1,50')).toBe(true)
    expect(decimalCommaLike('1,000')).toBe(false)
    expect(decimalCommaLike('1,23,456.78')).toBe(false)
    expect(decimalCommaLike('12,50,000')).toBe(false)
    expect((parseMoney('12,5') as { error: string }).error).toMatch(/decimal comma/)
    expect((parseQty('2,5 Kg') as { error: string }).error).toMatch(/decimal comma/)
    expect(normalizeDecimalComma('1.234,56')).toBe('1234.56')
    expect(normalizeDecimalComma('12,5')).toBe('12.5')
    expect(normalizeDecimalComma('15.04.2025')).toBe('15.04.2025') // a date stays a date
    expect(normalizeDecimalComma('Acme, Pune')).toBe('Acme, Pune')
    expect(parseMoney(normalizeDecimalComma('1.234,56'))).toEqual(ok(123456))
  })
  it('Tally rates are parsed with integer maths', () => {
    expect(parseTallyRate('0.29/Nos')).toBe(29)
    expect(parseTallyRate('1,234.565/Kg')).toBe(123457)
    expect(parseTallyRate('')).toBeNull()
  })
})
