import { describe, expect, it } from 'vitest'
import { reportHtml } from './reportHtml'
import type { CompanyInfo } from '@shared/domain'

const COMPANY: CompanyInfo = {
  name: 'Total Traders',
  stateCode: '27',
  gstin: '27AAAAA0000A1Z5',
  gstRegistrationType: 'regular',
  gstFilingFrequency: 'monthly',
  turnoverBand: null,
  address: '1 Market Road, Mumbai',
  booksFrom: 2026,
  email: null,
  phone: null,
  pan: null,
  tan: null
}

const base = {
  title: 'Trial Balance',
  company: COMPANY,
  periodLabel: '01-Apr-26 to 31-Mar-27',
  columns: [
    { label: 'Ledger', align: 'l' as const },
    { label: 'Debit', align: 'r' as const }
  ],
  rows: [{ cells: ['Cash', '1,000.00'] }]
}

describe('reportHtml', () => {
  it('states the period in the footer whether or not a footNote was supplied', () => {
    // A screenshot or photocopy of a report is worthless evidence if the range it covers has to
    // be taken on trust, so this is not optional.
    const withNote = reportHtml({ ...base, footNote: 'Excludes the bin.' })
    expect(withNote).toContain('Excludes the bin.')
    expect(withNote).toContain('01-Apr-26 to 31-Mar-27')

    const without = reportHtml(base)
    expect(without).toContain('01-Apr-26 to 31-Mar-27')
    expect(without).toContain('Total Traders')
    expect(without).toContain('27AAAAA0000A1Z5')
  })

  it('omits the GSTIN from the footer for an unregistered company rather than printing null', () => {
    const html = reportHtml({ ...base, company: { ...COMPANY, gstin: null } })
    expect(html).not.toContain('GSTIN null')
    expect(html).not.toContain('GSTIN undefined')
    // The header block still says so in words.
    expect(html).toContain('Unregistered')
  })

  it('escapes a company name that contains markup', () => {
    // A company name is user input and lands in both the header and the footer.
    const html = reportHtml({ ...base, company: { ...COMPANY, name: '<script>x</script> & Co' } })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp; Co')
  })

  it('escapes cell contents', () => {
    const html = reportHtml({ ...base, rows: [{ cells: ['<b>Cash</b>', '1.00'] }] })
    expect(html).not.toContain('<b>Cash</b>')
    expect(html).toContain('&lt;b&gt;Cash&lt;/b&gt;')
  })

  it('renders a grand total as bold with the double rule', () => {
    const html = reportHtml({ ...base, rows: [{ cells: ['Total', '1,000.00'], bold: true, rule: true }] })
    expect(html).toContain('class="bold rule"')
  })

  it('indents a tree row by level', () => {
    const html = reportHtml({ ...base, rows: [{ cells: ['Sundry Debtors', '0.00'], indent: 2 }] })
    expect(html).toContain('padding-left:40px') // 8 + 2 * 16
  })
})
