// PR #156 — the cash forecast with MSME deadlines OFF (the default) must be byte-identical to the
// forecast before `msmeDue` existed. The fixture `__fixtures__/cashForecastMsmeOff.main.json` was
// generated from origin/main's services (before the option) with
//   TOTAL_MSME_PARITY_WRITE=1 npm run test:db -- src/main/services/cashForecastMsmeParity.dbtest.ts
// on that checkout — never regenerate it from the code under test to make this pass.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { forecastBase } from './cashForecast'
import { cashNext30 } from './simpleReports'
import { buildForecast, SCENARIO_PRESETS } from '@shared/cashForecast'
import { createToolRegistry } from '../ai/tools'
import type { ToolContext } from '../ai/tools/registry'

const FIXTURE = join(__dirname, '__fixtures__', 'cashForecastMsmeOff.main.json')
const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const lid = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const ledger = (db: DB, name: string, group: string, creditDays: number | null = null, openingBalance = 0): number =>
  createLedger(db, {
    name, groupId: gid(db, group), openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays, exportType: null
  }).id
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const post = (db: DB, kind: string, date: string, lines: VoucherInput['lines'], extra: Partial<VoucherInput> = {}): number =>
  saveVoucher(db, { voucherTypeId: vt(db, kind), date, partyLedgerId: null, narration: null, reference: null, lines, inventory: [], billRefs: [], tds: null, ...extra }).id
const dr = (ledgerId: number, amount: number) => ({ ledgerId, drCr: 'dr' as const, amount, costAllocations: [] })
const cr = (ledgerId: number, amount: number) => ({ ledgerId, drCr: 'cr' as const, amount, costAllocations: [] })

describe('cash forecast with msmeDue off = origin/main (pinned fixture)', () => {
  it('forecasts, the simple Cash next 30 days and the AI tool equal the pre-option output', async () => {
    const db = seededDb()
    const cash = lid(db, 'Cash')
    const bank = ledger(db, 'HDFC Current', 'Bank Accounts', null, 3_00_000_00)
    const sales = ledger(db, 'Sales Account', 'Sales Accounts')
    const purchases = ledger(db, 'Purchases', 'Purchase Accounts')
    const cust = ledger(db, 'Acme Buyer', 'Sundry Debtors', 30)
    const micro = ledger(db, 'Micro Castings', 'Sundry Creditors', 60)
    const small = ledger(db, 'Small Forge', 'Sundry Creditors', 10)
    const medium = ledger(db, 'Medium Mills', 'Sundry Creditors', 30)
    const late = ledger(db, 'Late Registrant', 'Sundry Creditors', 60)
    db.prepare("UPDATE ledgers SET msme_registered = 1, msme_category = 'micro' WHERE id IN (?, ?)").run(micro, late)
    db.prepare("UPDATE ledgers SET msme_registered = 1, msme_category = 'small', agreed_credit_days = 40 WHERE id = ?").run(small)
    db.prepare("UPDATE ledgers SET msme_registered = 1, msme_category = 'medium' WHERE id = ?").run(medium)
    db.prepare("UPDATE ledgers SET msme_registered_from = '2026-05-15' WHERE id = ?").run(late)
    post(db, 'receipt', '2026-04-20', [dr(cash, 8_000_00), cr(sales, 8_000_00)])
    post(db, 'journal', '2026-04-25', [dr(cust, 90_000_00), cr(sales, 90_000_00)], { partyLedgerId: cust })
    post(db, 'journal', '2026-05-01', [dr(purchases, 40_000_00), cr(micro, 40_000_00)], { partyLedgerId: micro })
    post(db, 'journal', '2026-05-25', [dr(purchases, 10_000_00), cr(micro, 10_000_00)], { partyLedgerId: micro })
    post(db, 'journal', '2026-05-20', [dr(purchases, 25_000_00), cr(small, 25_000_00)], { partyLedgerId: small })
    post(db, 'journal', '2026-04-15', [dr(purchases, 15_000_00), cr(medium, 15_000_00)], { partyLedgerId: medium })
    post(db, 'journal', '2026-05-10', [dr(purchases, 5_000_00), cr(late, 5_000_00)], { partyLedgerId: late })
    post(db, 'payment', '2026-06-20', [dr(micro, 30_000_00), cr(bank, 30_000_00)], { partyLedgerId: micro, postDated: true })
    post(db, 'receipt', '2026-06-18', [dr(bank, 50_000_00), cr(cust, 50_000_00)], { partyLedgerId: cust, postDated: true, instrumentNo: '000777' })

    const AS_ON = '2026-06-01'
    const base = forecastBase(db, TEST_INFO, AS_ON, '2026-09-30')
    const run = (extra: Record<string, unknown>) =>
      buildForecast({ asOn: AS_ON, unit: 'week', count: 13, openingCash: base.openingCash, flows: base.flows, scenario: SCENARIO_PRESETS.expected, ...extra })
    const registry = createToolRegistry()
    const ctx = { db, company: TEST_INFO, role: 'viewer', userName: null, threadId: null, messageId: null, today: AS_ON, period: { from: '2026-04-01', to: '2027-03-31' } } as unknown as ToolContext
    const tool = await registry.run('forecast_summary', '{}', ctx)
    const got = {
      weekly: run({}),
      monthly: run({ unit: 'month', count: 4 }),
      worst: run({ scenario: SCENARIO_PRESETS.worst }),
      pdc: run({ includePdc: true }),
      simple: cashNext30(db, TEST_INFO, AS_ON),
      tool: tool.ok ? tool.data : tool
    }
    const json = JSON.stringify(got, null, 1)
    if (process.env.TOTAL_MSME_PARITY_WRITE === '1') {
      writeFileSync(FIXTURE, json + '\n')
      return
    }
    expect(existsSync(FIXTURE)).toBe(true)
    const expected = readFileSync(FIXTURE, 'utf8').trimEnd()
    expect(json).toBe(expected)
    // An explicit `msmeDue: false` is the default too.
    expect(JSON.stringify(run({ msmeDue: false }), null, 1)).toBe(JSON.stringify(got.weekly, null, 1))
    expect(JSON.stringify(run({ includePdc: true, msmeDue: false }), null, 1)).toBe(JSON.stringify(got.pdc, null, 1))
  })
})
