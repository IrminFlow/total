// WP 6.2 — comparatives and ratio analysis against real databases: ratio values on a
// hand-computed fixture, and the comparative P&L's columns equal the P&L of each period.
// (The report builder and scheduled packs of WP 6.1 were removed; their migration's tables stay,
// so old books still open — the schema check below keeps them honest.)
import { describe, expect, it } from 'vitest'
import type { DB } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { freshPartialDb, seededDb } from '../db/testdb'
import { migrate } from '../db/migrate'
import type { VoucherInputParsed } from '@shared/schemas'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { comparativePnl, ratioReport } from './reportAnalytics'
import { profitAndLoss } from './reports'

const M038 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE saved_reports'))

// ---------------------------------------------------------------- fixtures

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}
function ledger(db: DB, name: string, group: string, openingBalance = 0, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(db, group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
    hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  } as Parameters<typeof createLedger>[1]).id
}
function voucher(
  db: DB, kind: string, date: string, lines: [number, 'dr' | 'cr', number, { costCentreId: number; amount: number }[]?][],
  extra: Partial<VoucherInputParsed> = {}
): number {
  const vt = (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  return saveVoucher(db, {
    voucherTypeId: vt, date, number: undefined, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map(([ledgerId, drCr, amount, cc]) => ({ ledgerId, drCr, amount, costAllocations: cc ?? [] })),
    inventory: [], billRefs: [], tds: null, ...extra
  } as VoucherInputParsed).id
}

// ---------------------------------------------------------------- migration 037 (tables kept)

describe('report-builder migration — saved reports and report packs', () => {
  it('is migration 037 (number by position): after 032–036, before WP 6.3’s import wizard (038)', () => {
    // Array position = migration number − 1. Later branches append after it.
    expect(M038 + 1).toBeGreaterThanOrEqual(37) // after 032–035 (Phase 4) and 036 (AI)
    expect(M038).toBeLessThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE import_batches')))
  })

  it('creates the three tables with their constraints, from the previous schema', () => {
    const db = freshPartialDb(M038)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'saved_reports'").get()).toBeUndefined()
    migrate(db)
    db.prepare("INSERT INTO saved_reports (name, model_json) VALUES ('Sales', '{}')").run()
    expect(() => db.prepare("INSERT INTO saved_reports (name, model_json) VALUES ('sales', '{}')").run()).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO saved_reports (name, model_json, pinned) VALUES ('X', '{}', 2)").run()).toThrow(/CHECK/)
    expect(db.prepare('SELECT pinned FROM saved_reports').get()).toEqual({ pinned: 0 })
    expect((db.prepare('PRAGMA table_info(saved_reports)').all() as { name: string }[]).map((c) => c.name)).not.toContain('schedule_json')
    db.prepare("INSERT INTO report_packs (name, reports_json, period_rule, frequency) VALUES ('Monthly', '[]', 'lastMonth', 'monthly')").run()
    expect(() => db.prepare("INSERT INTO report_packs (name, reports_json, period_rule, frequency) VALUES ('B', '[]', 'nextYear', 'monthly')").run()).toThrow(/CHECK/)
    expect(db.prepare('SELECT formats_json, active, output_dir FROM report_packs').get()).toEqual({ formats_json: '["pdf","csv"]', active: 1, output_dir: null })
    db.prepare("INSERT INTO report_pack_runs (pack_id, trigger, started_at, period_from, period_to, status) VALUES (1, 'manual', 'x', 'a', 'b', 'ok')").run()
    db.prepare('DELETE FROM report_packs').run()
    expect((db.prepare('SELECT COUNT(*) AS n FROM report_pack_runs').get() as { n: number }).n).toBe(0)
  })
})

describe('comparatives and ratios', () => {
  it('the comparative P&L puts the period, the period before and last year side by side', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand')
    const fees = ledger(db, 'Fees', 'Direct Incomes')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    voucher(db, 'receipt', '2025-05-05', [[cash, 'dr', 30_000], [fees, 'cr', 30_000]])
    voucher(db, 'receipt', '2026-05-05', [[cash, 'dr', 45_000], [fees, 'cr', 45_000]])
    voucher(db, 'payment', '2026-05-06', [[rent, 'dr', 9_000], [cash, 'cr', 9_000]])
    const cmp = comparativePnl(db, '2026-04-01', '2026-06-30')
    expect(cmp.columns.map((c) => [c.key, c.from, c.to])).toEqual([
      ['current', '2026-04-01', '2026-06-30'], ['previous', '2026-01-01', '2026-03-31'], ['lastYear', '2025-04-01', '2025-06-30']
    ])
    expect(cmp.statements.map((s) => s.netProfit)).toEqual([36_000, 0, 30_000])
    expect(cmp.statements[0]!.netProfit).toBe(profitAndLoss(db, '2026-04-01', '2026-06-30').netProfit)
  })

  it('ratio values on a fixture match the published formulas', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand', 1_000_000)
    ledger(db, 'Owner', 'Capital Account', -1_000_000)
    const debtor = ledger(db, 'Asha Stores', 'Sundry Debtors')
    const creditor = ledger(db, 'Bharat Mills', 'Sundry Creditors')
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const purchase = ledger(db, 'Purchases', 'Purchase Accounts')
    const loan = ledger(db, 'Term loan', 'Unsecured Loans')
    voucher(db, 'purchase', '2025-05-03', [[purchase, 'dr', 400_000], [creditor, 'cr', 400_000]], { partyLedgerId: creditor })
    voucher(db, 'sales', '2025-05-10', [[debtor, 'dr', 600_000], [sales, 'cr', 600_000]], { partyLedgerId: debtor })
    voucher(db, 'journal', '2025-05-15', [[cash, 'dr', 200_000], [loan, 'cr', 200_000]])
    voucher(db, 'receipt', '2025-05-20', [[cash, 'dr', 100_000], [debtor, 'cr', 100_000]], { partyLedgerId: debtor })
    const r = ratioReport(db, '2025-05-01', '2025-05-31').period.ratios
    expect(r).toEqual({
      currentRatio: 4.5, quickRatio: 4.5, cashRatio: 3.25,
      grossMarginPct: 33.33, netMarginPct: 33.33, returnOnEquityPct: 18.18, returnOnAssetsPct: 14.29,
      debtEquity: 0.17, equityRatio: 0.67,
      inventoryTurnover: null, receivablesTurnover: 2.4, payablesTurnover: 2, netCapitalTurnover: 0.43, assetTurnover: 0.43,
      debtorDays: 12.92, creditorDays: 15.5, inventoryDays: null, cashConversionDays: null
    })
    const months = ratioReport(db, '2025-04-01', '2025-06-30').months
    expect(months.map((m) => m.key)).toEqual(['2025-04', '2025-05', '2025-06'])
    expect(months[1]!.ratios.currentRatio).toBe(4.5)
  })
})
