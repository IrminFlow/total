import { describe, expect, it } from 'vitest'
import { DEMO_COMPANY } from '@shared/demo'
import { reportHtml } from './reportHtml'

describe('reportHtml provenance', () => {
  it('prints context, basis, freshness and generation time on every report', () => {
    const html = reportHtml({
      title: 'Trial balance',
      company: DEMO_COMPANY,
      periodLabel: 'as on 31-Mar-26',
      columns: [{ label: 'Ledger', align: 'l' }, { label: 'Amount', align: 'r' }],
      rows: [{ cells: ['Cash', '1,000.00'] }],
      provenance: {
        period: 'as on 31-Mar-26 · all ledgers',
        accountingBasis: 'Accrual basis · posted vouchers',
        dataFreshness: 'Live local books at export time',
        generatedAt: '2026-08-24T07:00:00.000Z'
      }
    })

    expect(html).toContain('Report context')
    expect(html).toContain('as on 31-Mar-26 · all ledgers')
    expect(html).toContain('Accrual basis · posted vouchers')
    expect(html).toContain('Live local books at export time')
    expect(html).toContain('Generated')
    expect(html).toContain('IST')
  })

  it('escapes provenance text before inserting it into printable HTML', () => {
    const html = reportHtml({
      title: 'Ledger',
      company: DEMO_COMPANY,
      periodLabel: '',
      columns: [{ label: 'Particulars', align: 'l' }],
      rows: [],
      provenance: {
        period: '<script>alert(1)</script>',
        accountingBasis: 'Accrual',
        dataFreshness: 'Live',
        generatedAt: '2026-08-24T07:00:00.000Z'
      }
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
