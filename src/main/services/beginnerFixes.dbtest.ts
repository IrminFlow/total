// WP 10.8 — the beginner study's fixes on the server side.
//   - A regular business that started its books TODAY is not asked about last month: Taxes opens
//     on the running month (no earlier period offered), Home's GST tile is the running month so
//     far, and Home's "Needs attention" has no month-end checks for a month before the books.
//   - A business that started earlier keeps the return the next GSTR-3B files (unchanged).
import { describe, expect, it } from 'vitest'
import { freshDb } from '../db/testdb'
import { readCompanyInfo } from '../db/seed'
import { applySetup } from './companySetup'
import { simpleTaxes } from './simpleTaxes'
import { simpleHome, simpleHomeAttention } from './simpleHome'
import type { DB } from '../db/connection'

const TODAY = '2026-10-14'

function trader(startDate: string): DB {
  const db = freshDb()
  applySetup(db, { name: 'Agarwal Traders', stateCode: '27', businessType: 'trader', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'monthly', stock: true, startDate, fresh: startDate === TODAY }, TODAY)
  return db
}

describe('WP 10.8: GST periods start with the books', () => {
  it('a business started today: Taxes on the running month only; Home tile so far; no last-month checks', () => {
    const db = trader(TODAY)
    const company = readCompanyInfo(db)
    const x = simpleTaxes(db, company, {}, TODAY)
    if (x.kind !== 'regular') throw new Error('regular expected')
    expect(x.period).toMatchObject({ period: '2026-10', soFar: true })
    expect(x.periods.map((p) => p.period)).toEqual(['2026-10'])
    const home = simpleHome(db, company, { today: TODAY, backups: [] })
    expect(home.gst?.kind === 'regular' && home.gst.row).toMatchObject({ period: '2026-10', soFar: true, from: '2026-10-01', to: TODAY })
    expect(simpleHomeAttention(db, company, TODAY).items.filter((i) => i.source === 'close')).toEqual([])
  })

  it('a business that started at the FY start keeps the return due next (September)', () => {
    const db = trader('2026-04-01')
    const company = readCompanyInfo(db)
    const x = simpleTaxes(db, company, {}, TODAY)
    if (x.kind !== 'regular') throw new Error('regular expected')
    expect(x.period).toMatchObject({ period: '2026-09', soFar: false })
    expect(x.periods.map((p) => p.period)).toContain('2026-04')
  })
})
