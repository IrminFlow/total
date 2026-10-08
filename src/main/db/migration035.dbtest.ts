// Migration 035 (WP 4.4): forecast items, budget cost-centre / phasing columns and revisions,
// loans + schedules, forex rates / revaluations / settlements. Located by content — on this
// branch it is appended after 031; 032–034 belong to parallel branches.
import { describe, expect, it } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

const M035 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE forecast_items'))

const cols = (db: ReturnType<typeof freshPartialDb>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migration 035 — cash and finance', () => {
  it('is migration 035, after 031–034', () => {
    const m031 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE audit_log_new'))
    expect(M035).toBeGreaterThan(m031)
    expect(M035 + 1).toBe(35)
  })

  it('keeps existing budgets as annual (original behaviour) with no cost centre', () => {
    const db = freshPartialDb(M035)
    seedCompany(db, TEST_INFO)
    const b = Number(db.prepare("INSERT INTO budgets (name, fy_start_year) VALUES ('Old', 2025)").run().lastInsertRowid)
    const ledger = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    db.prepare('INSERT INTO budget_lines (budget_id, ledger_id, month, amount) VALUES (?, ?, NULL, 5000)').run(b, ledger)
    migrate(db)
    expect(db.prepare('SELECT phasing, cost_centre_id, monthly_json FROM budget_lines').get()).toEqual({ phasing: 'annual', cost_centre_id: null, monthly_json: null })
    expect(db.prepare('SELECT seasonal_json FROM budgets').get()).toEqual({ seasonal_json: null })
    expect(() => db.prepare("UPDATE budget_lines SET phasing = 'weekly'").run()).toThrow(/CHECK/)
  })

  it('creates the new tables with their constraints', () => {
    const db = freshPartialDb(M035)
    seedCompany(db, TEST_INFO)
    migrate(db)
    expect(cols(db, 'forecast_items')).toEqual(expect.arrayContaining(['name', 'amount', 'cadence', 'start_date', 'end_date', 'kind', 'active']))
    expect(cols(db, 'budget_revisions')).toEqual(expect.arrayContaining(['budget_id', 'revision_no', 'user_name', 'reason', 'before_json', 'after_json']))
    expect(cols(db, 'loans')).toEqual(expect.arrayContaining(['loan_ledger_id', 'principal', 'annual_rate_milli', 'tenure_months', 'method', 'moratorium_months', 'emi_override']))
    expect(cols(db, 'loan_schedules')).toEqual(expect.arrayContaining(['seq', 'due_date', 'opening', 'payment', 'interest', 'principal', 'closing', 'voucher_id']))
    expect(cols(db, 'fx_rates')).toEqual(expect.arrayContaining(['date', 'currency_code', 'rate_micro']))
    expect(cols(db, 'fx_revaluations')).toEqual(expect.arrayContaining(['as_of', 'voucher_id', 'reversal_voucher_id', 'auto_reverse']))
    expect(cols(db, 'fx_settlements')).toEqual(expect.arrayContaining(['voucher_id', 'party_ledger_id', 'fc_amount', 'gain_loss']))

    // forecast items: inflow / outflow positive, an adjustment may be negative, end ≥ start
    const item = db.prepare('INSERT INTO forecast_items (name, amount, cadence, start_date, end_date, kind) VALUES (?, ?, ?, ?, ?, ?)')
    expect(() => item.run('x', -5, 'once', '2026-01-01', null, 'outflow')).toThrow(/CHECK/)
    expect(() => item.run('x', -5, 'once', '2026-01-01', null, 'adjustment')).not.toThrow()
    expect(() => item.run('x', 5, 'monthly', '2026-02-01', '2026-01-01', 'inflow')).toThrow(/CHECK/)
    expect(() => item.run('x', 5, 'daily', '2026-01-01', null, 'inflow')).toThrow(/CHECK/)

    // one rate per date and currency
    db.prepare("INSERT INTO fx_rates (date, currency_code, rate_micro) VALUES ('2026-03-31', 'USD', 83250000)").run()
    expect(() => db.prepare("INSERT INTO fx_rates (date, currency_code, rate_micro) VALUES ('2026-03-31', 'USD', 1)").run()).toThrow(/UNIQUE/)

    // a schedule row must balance
    const ledger = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const loan = Number(db.prepare(
      "INSERT INTO loans (name, loan_ledger_id, principal, annual_rate_milli, tenure_months, disbursed_on, first_due_date) VALUES ('L', ?, 100, 12000, 1, '2026-01-01', '2026-02-01')"
    ).run(ledger).lastInsertRowid)
    const row = db.prepare('INSERT INTO loan_schedules (loan_id, seq, due_date, kind, opening, payment, interest, principal, closing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    expect(() => row.run(loan, 1, '2026-02-01', 'emi', 100, 101, 1, 100, 0)).not.toThrow()
    expect(() => row.run(loan, 2, '2026-03-01', 'emi', 100, 50, 1, 40, 60)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO loans (name, loan_ledger_id, principal, annual_rate_milli, tenure_months, disbursed_on, first_due_date) VALUES ('M', ?, 100, 12000, 1, '2026-02-01', '2026-01-01')").run(ledger)).toThrow(/CHECK/)
    // deleting a loan cascades its schedule
    db.prepare('DELETE FROM loans WHERE id = ?').run(loan)
    expect((db.prepare('SELECT COUNT(*) AS n FROM loan_schedules').get() as { n: number }).n).toBe(0)
  })
})
