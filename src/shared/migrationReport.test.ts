import { describe, it, expect } from 'vitest'
import { buildMigrationReport, type MigrationRun } from './migrationReport'
import { formatPaise } from './money'

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  at: '2026-08-24 11:05:00',
  userName: 'Priya Owner',
  appVersion: '0.4.0',
  groups: 3,
  ledgers: 42,
  units: 2,
  items: 15,
  vouchers: 780,
  skipped: 0,
  duplicates: 0,
  warnings: 0,
  ...over
})

const base = {
  runs: [run()],
  totalDebit: 12456000,
  totalCredit: 12456000,
  vouchersInBooks: 780,
  ledgerCount: 43,
  asOn: '2026-08-24'
}

describe('buildMigrationReport', () => {
  const text = (body: ReturnType<typeof buildMigrationReport>): string =>
    body.rows.map((r) => r.cells.join(' ')).join('\n')

  it('states who imported what, and when', () => {
    const body = buildMigrationReport(base, formatPaise)
    expect(text(body)).toContain('Priya Owner')
    expect(text(body)).toContain('780')
    expect(text(body)).toContain('0.4.0')
  })

  it('says so plainly when nothing was ever imported', () => {
    // A report with an empty table looks like a report that failed to load, and this one may be
    // the only record that no import happened at all.
    const body = buildMigrationReport({ ...base, runs: [] }, formatPaise)
    expect(text(body)).toContain('No import has been run')
  })

  it('leads with the difference when the books do not balance', () => {
    const body = buildMigrationReport({ ...base, totalCredit: 12455000 }, formatPaise)
    expect(body.outOfBalance).toBe(1000)
    expect(body.footNote.startsWith('THE BOOKS DO NOT BALANCE')).toBe(true)
    expect(body.footNote).toContain('10.00')
    expect(text(body)).toContain('OUT OF BALANCE')
  })

  it('offers the signature block when they do balance', () => {
    const body = buildMigrationReport(base, formatPaise)
    expect(body.outOfBalance).toBe(0)
    expect(body.footNote).toContain('Membership no.')
    expect(body.footNote).not.toContain('DO NOT BALANCE')
    expect(text(body)).toContain('Balanced')
  })

  it('adds up several imports rather than reporting only the last', () => {
    const body = buildMigrationReport(
      { ...base, runs: [run({ vouchers: 300, skipped: 2 }), run({ vouchers: 480, duplicates: 12 })] },
      formatPaise
    )
    expect(text(body)).toContain('Total imported Vouchers 780')
    expect(text(body)).toContain('Refused in total 2')
    expect(text(body)).toContain('Recognised as already imported 12')
  })

  it('does not mention refusals or duplicates when there were none', () => {
    const body = buildMigrationReport(base, formatPaise)
    expect(text(body)).not.toContain('Refused')
    expect(text(body)).not.toContain('already imported')
  })
})
