import { describe, it, expect } from 'vitest'
import { renderForm16aHtml } from './form16a'
import type { Form16aData } from '../tdsTypes'

const DATA: Form16aData = {
  deductor: { name: 'Demo <Traders>', address: 'Pune', pan: 'AAACD1234E', tan: 'PNED12345F' },
  fyStartYear: 2025, quarter: 1, period: { from: '2025-04-01', to: '2025-06-30' }, assessmentYear: '2026-27',
  parties: [{
    partyLedgerId: 1, partyName: 'Acme', pan: null, address: null,
    payments: [{ date: '2025-05-10', sectionCode: '194C', nature: 'Contract work', amountPaise: 5000000, tdsPaise: 100000, voucherNumber: 'J-1' }],
    challans: [], totals: { amountPaise: 5000000, tdsPaise: 100000, depositedPaise: 0 }
  }]
}

describe('renderForm16aHtml', () => {
  it('renders one page per deductee with the Form 16A fields, labelled as data only, escaped', () => {
    const html = renderForm16aHtml(DATA)
    expect(html).toContain('Data for Form No. 16A — not a certificate')
    expect(html).toContain('Demo &lt;Traders&gt;')
    expect(html).toContain('PNED12345F')
    expect(html).toContain('PANNOTAVBL')
    expect(html).toContain('2026-27')
    expect(html).toContain('50,000.00')
    expect(html).toContain('Not yet deposited')
    expect(html.match(/class="page"/g)).toHaveLength(1)
  })
})
