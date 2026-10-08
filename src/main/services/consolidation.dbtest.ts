import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { CompanyInfo } from '@shared/domain'
import { companyDbPath } from '../paths'
import { gstinCheckChar } from '@shared/gst/validate'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { createLedger, listGroups } from './masters'
import { saveVoucher } from './vouchers'
import { upsertCompany } from '../registry'
import { consolGroupInputSchema, consolPairInputSchema, consolMappingInputSchema } from '@shared/consolidation/schemas'
import { SPECIAL_LINES } from '@shared/consolidation/engine'
import {
  deleteGroup, deletePair, getGroup, listGroups as listConsolGroups, memberCharts, runGroup, saveGroup, saveMapping, savePair, suggestGroupPairs
} from './consolidation'

// Every member is a real company file in a scratch TOTAL_DATA_DIR; the service reads them
// read-only through withMemberDb, exactly as in the app.
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-group-'))
  process.env.TOTAL_DATA_DIR = dataDir
})
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

const FROM = '2025-04-01'
const TO = '2026-03-31'
const ALPHA_GSTIN = `27AAACA1234A1Z${gstinCheckChar('27AAACA1234A1Z')}`
const BETA_GSTIN = `29AAACB5678B1Z${gstinCheckChar('29AAACB5678B1Z')}`

function company(slug: string, name: string, gstin: string | null): DB {
  const db = openCompanyDb(slug)
  const info: CompanyInfo = {
    name, stateCode: '27', gstin, gstRegistrationType: gstin ? 'regular' : 'unregistered', address: '', booksFrom: 2025,
    email: null, phone: null, pan: null, tan: null
  }
  seedCompany(db, info)
  upsertCompany({ slug, name, stateCode: info.stateCode, gstin, lastOpenedAt: null })
  return db
}
function ledger(db: DB, name: string, group: string, openingBalance = 0, gstin: string | null = null): number {
  const groupId = listGroups(db).find((g) => g.name === group)!.id
  return createLedger(db, {
    name, groupId, openingBalance, gstin, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}
function journal(db: DB, date: string, dr: number, cr: number, amount: number): void {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
  saveVoucher(db, {
    voucherTypeId: vt, date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
}
const cash = (db: DB): number => (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

interface World {
  alpha: DB
  ids: { aInvest: number; aBeta: number; aSales: number; bAlpha: number; bPurchase: number; bSales: number; bCapital: number }
}

/** Alpha Holdings owns 80 % of Beta Traders (cost 90,000 for equity of 1,00,000). Alpha sells
 *  50,000 to Beta (and 20,000 outside); Beta sells 80,000 outside. `betaBooks` = what Beta booked. */
function world(betaBooks = 50000): World {
  const alpha = company('alpha', 'Alpha Holdings', ALPHA_GSTIN)
  const aCapital = ledger(alpha, 'Capital', 'Capital Account', -100000)
  const aInvest = ledger(alpha, 'Investment in Beta', 'Investments', 90000)
  void aCapital
  const aCash = cash(alpha)
  alpha.prepare('UPDATE ledgers SET opening_balance = 10000 WHERE id = ?').run(aCash)
  const aBeta = ledger(alpha, 'Beta Traders', 'Sundry Debtors', 0, BETA_GSTIN)
  const aSales = ledger(alpha, 'Sales', 'Sales Accounts')
  journal(alpha, '2025-06-01', aBeta, aSales, 50000)
  journal(alpha, '2025-06-02', aCash, aSales, 20000)

  const beta = company('beta', 'Beta Traders', BETA_GSTIN)
  const bCapital = ledger(beta, 'Share capital', 'Capital Account', -100000)
  const bCash = cash(beta)
  beta.prepare('UPDATE ledgers SET opening_balance = 100000 WHERE id = ?').run(bCash)
  const bAlpha = ledger(beta, 'Alpha Holdings', 'Sundry Creditors', 0, ALPHA_GSTIN)
  const bPurchase = ledger(beta, 'Purchases', 'Purchase Accounts')
  const bSales = ledger(beta, 'Sales', 'Sales Accounts')
  journal(beta, '2025-06-05', bPurchase, bAlpha, betaBooks)
  journal(beta, '2025-07-01', bCash, bSales, 80000)
  beta.close()
  return { alpha, ids: { aInvest, aBeta, aSales, bAlpha, bPurchase, bSales, bCapital } }
}

function defineGroup(w: World, extraMembers: { slug: string; role: 'subsidiary' | 'associate' }[] = []): number {
  const g = saveGroup(w.alpha, consolGroupInputSchema.parse({
    name: 'Alpha group',
    members: [
      { companySlug: 'alpha', role: 'parent' },
      { companySlug: 'beta', role: 'subsidiary', ownershipBp: 8000, acquiredOn: '2025-04-01', investmentLedgerId: w.ids.aInvest },
      ...extraMembers.map((m) => ({ companySlug: m.slug, role: m.role }))
    ]
  }))
  for (const kind of ['receivable_payable', 'sales_purchase'] as const) {
    savePair(w.alpha, consolPairInputSchema.parse({ groupId: g.id, memberA: 'alpha', ledgerAId: w.ids.aBeta, memberB: 'beta', ledgerBId: w.ids.bAlpha, kind }))
  }
  return g.id
}

const line = (s: { lines: { key: string }[] }, key: string) => (s.lines as { key: string; consolidated: number; perMember: number[]; elimination: number; sources: { slug: string; ledgerId: number; amount: number }[]; eliminationIds: string[] }[]).find((l) => l.key === key)

describe('group consolidation (WP 6.5)', () => {
  it('the migration is the last one and stores the definition with its constraints', () => {
    const idx = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE consolidation_groups'))
    expect(idx).toBe(MIGRATIONS.length - 1)
    const w = world()
    const id = defineGroup(w)
    expect(() => w.alpha.prepare("INSERT INTO consolidation_members (group_id, company_slug, role) VALUES (?, 'x', 'parent')").run(id)).toThrow(/UNIQUE/)
    expect(() => w.alpha.prepare("INSERT INTO intercompany_pairs (group_id, member_a, ledger_a_id, member_b, ledger_b_id, kind) VALUES (?, 'a', 1, 'a', 2, 'other')").run(id)).toThrow(/CHECK/)
    expect(() => w.alpha.prepare("INSERT INTO consolidation_mappings (group_id, company_slug, ledger_id, group_name, target_name) VALUES (?, 'alpha', 1, 'X', 'Y')").run(id)).toThrow(/CHECK/)
    w.alpha.close()
  })

  it('combines the members, eliminates the inter-company sale and balance, and every statement adds up', () => {
    const w = world()
    const id = defineGroup(w)
    const r = runGroup(w.alpha, id, FROM, TO, { openSlug: 'alpha' })
    expect(r.warnings).toEqual([])
    expect(r.pnl.members.map((m) => m.slug)).toEqual(['alpha', 'beta'])

    // P&L: 70,000 + 80,000 sales less the 50,000 inter-company sale; inter-company purchases gone.
    const sales = line(r.pnl, 'income:sales accounts')!
    expect(sales.perMember).toEqual([-70000, -80000])
    expect(sales.elimination).toBe(50000)
    expect(sales.consolidated).toBe(-100000)
    expect(line(r.pnl, 'expense:purchase accounts')!.consolidated).toBe(0)
    expect(r.pnl.profit).toEqual({ perMember: [70000, 30000], netProfit: 100000, minorityInterest: 6000, ownersProfit: 94000 })

    // Drill-down: the consolidated line carries each member's ledger id and the elimination entry.
    expect(sales.sources.map((s) => [s.slug, s.ledgerId, s.amount])).toEqual([['alpha', w.ids.aSales, -70000], ['beta', w.ids.bSales, -80000]])
    const flowElim = r.pnl.eliminations.find((e) => e.rule === 'ic_flow')!
    expect(sales.eliminationIds).toContain(flowElim.id)
    expect(flowElim.postings.map((p) => [p.slug, p.ledgerId, p.amount])).toEqual([['alpha', w.ids.aSales, 50000], ['beta', w.ids.bPurchase, -50000]])

    // Trial balance and balance sheet balance after eliminations.
    expect(r.tb.totals.consolidated).toBe(0)
    expect(r.tb.totals.perMember).toEqual([0, 0])
    expect(r.bs.balance!.assets).toBe(r.bs.balance!.liabilities)
    expect(line(r.bs, 'asset:sundry debtors')!.consolidated).toBe(0)
    expect(line(r.bs, 'liability:sundry creditors')!.consolidated).toBe(0)

    // Goodwill = 90,000 − 80 % × 1,00,000; minority = 20 % × (1,00,000 + 30,000).
    expect(line(r.bs, SPECIAL_LINES.goodwill.key)!.consolidated).toBe(10000)
    expect(line(r.bs, SPECIAL_LINES.minorityInterest.key)!.consolidated).toBe(-26000)
    expect(line(r.bs, 'asset:investments')!.consolidated).toBe(0)
    expect(line(r.tb, SPECIAL_LINES.minorityInterest.key)!.consolidated).toBe(-26000)

    // Reconciliation statement: both pairs agree; the balance pair has ageing.
    expect(r.recon.map((x) => [x.kind, x.status, x.flowStatus, x.difference, x.flowDifference])).toEqual([
      ['receivable_payable', 'reconciled', 'n/a', 0, null],
      ['sales_purchase', 'n/a', 'reconciled', null, 0]
    ])
    expect(r.recon[0]!.ageingA.reduce((s, v) => s + v, 0)).toBe(50000)
    expect(r.recon[0]!.memberBName).toBe('Beta Traders')
    w.alpha.close()
  })

  it('an unreconciled balance is shown, not eliminated silently', () => {
    const w = world(45000) // Beta booked only 45,000
    const id = defineGroup(w)
    const r = runGroup(w.alpha, id, FROM, TO)
    const rp = r.recon.find((x) => x.kind === 'receivable_payable')!
    expect(rp).toMatchObject({ balanceA: 50000, balanceB: -45000, difference: 5000, status: 'unreconciled' })
    expect(line(r.bs, SPECIAL_LINES.unreconciledBal.key)!.consolidated).toBe(5000)
    expect(line(r.pnl, SPECIAL_LINES.unreconciledFlow.key)!.consolidated).toBe(-5000)
    expect(r.bs.balance!.assets).toBe(r.bs.balance!.liabilities)
    expect(r.tb.totals.consolidated).toBe(0)
    w.alpha.close()
  })

  it('applies ledger and group mappings, and compares with the prior year', () => {
    const w = world()
    const id = defineGroup(w)
    saveMapping(w.alpha, consolMappingInputSchema.parse({ groupId: id, companySlug: 'beta', groupName: 'Sales Accounts', targetName: 'Revenue from operations' }))
    saveMapping(w.alpha, consolMappingInputSchema.parse({ groupId: id, companySlug: 'alpha', ledgerId: w.ids.aSales, targetName: 'Revenue from operations' }))
    const r = runGroup(w.alpha, id, FROM, TO, { comparePrior: true })
    const rev = line(r.pnl, 'income:revenue from operations')!
    expect(rev.consolidated).toBe(-100000)
    expect(line(r.pnl, 'income:sales accounts')).toBeUndefined()
    expect(r.prior!.period).toEqual({ from: '2024-04-01', to: '2025-03-31' })
    expect(r.prior!.netProfit).toBe(0)
    expect(getGroup(w.alpha, id).mappings).toHaveLength(2)
    w.alpha.close()
  })

  it('skips a member whose schema differs, with a warning, and never writes to its file', () => {
    const w = world()
    const stale = company('gamma', 'Gamma Stale', null)
    ledger(stale, 'Something', 'Indirect Expenses')
    stale.prepare('DELETE FROM migrations WHERE id = (SELECT MAX(id) FROM migrations)').run()
    const before = (stale.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n
    stale.close()
    const id = defineGroup(w, [{ slug: 'gamma', role: 'subsidiary' }])
    const r = runGroup(w.alpha, id, FROM, TO)
    expect(r.warnings.some((x) => /Gamma Stale: schema is out of date/.test(x))).toBe(true)
    expect(r.pnl.members.find((m) => m.slug === 'gamma')!.included).toBe(false)
    expect(r.tb.totals.consolidated).toBe(0)
    const raw = new Database(companyDbPath('gamma'), { readonly: true })
    expect((raw.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(before)
    raw.close()
    expect(before).toBe(MIGRATIONS.length - 1)
    w.alpha.close()
  })

  it('suggests pairs from GSTINs, lists member charts, and audits every write', () => {
    const w = world()
    const g = saveGroup(w.alpha, consolGroupInputSchema.parse({
      name: 'G', members: [{ companySlug: 'alpha', role: 'parent' }, { companySlug: 'beta', role: 'subsidiary' }]
    }))
    const s = suggestGroupPairs(w.alpha, g.id)
    expect(s.map((x) => [x.ledgerAId, x.ledgerBId, x.kind, x.reason])).toEqual([
      [w.ids.aBeta, w.ids.bAlpha, 'receivable_payable', 'gstin'],
      [w.ids.aBeta, w.ids.bAlpha, 'sales_purchase', 'gstin']
    ])
    const charts = memberCharts(w.alpha, g.id)
    expect(charts.map((c) => [c.slug, c.available, c.gstin])).toEqual([['alpha', true, ALPHA_GSTIN], ['beta', true, BETA_GSTIN]])
    const p = savePair(w.alpha, consolPairInputSchema.parse({ groupId: g.id, memberA: 'alpha', ledgerAId: w.ids.aBeta, memberB: 'beta', ledgerBId: w.ids.bAlpha, kind: 'loan' }))
    expect(() => savePair(w.alpha, consolPairInputSchema.parse({ groupId: g.id, memberA: 'beta', ledgerAId: w.ids.bAlpha, memberB: 'alpha', ledgerBId: w.ids.aBeta, kind: 'loan' }))).toThrow(/already exists/)
    deletePair(w.alpha, p.id)
    // Removing a member drops its pairs and mappings.
    savePair(w.alpha, consolPairInputSchema.parse({ groupId: g.id, memberA: 'alpha', ledgerAId: w.ids.aBeta, memberB: 'beta', ledgerBId: w.ids.bAlpha, kind: 'other' }))
    saveGroup(w.alpha, consolGroupInputSchema.parse({ name: 'G', members: [{ companySlug: 'alpha', role: 'parent' }] }), g.id)
    expect(getGroup(w.alpha, g.id).pairs).toEqual([])
    deleteGroup(w.alpha, g.id)
    expect(listConsolGroups(w.alpha)).toEqual([])
    const audit = w.alpha.prepare("SELECT entity, action FROM audit_log WHERE entity IN ('consolidation_group', 'intercompany_pair') ORDER BY id").all()
    expect(audit).toEqual([
      { entity: 'consolidation_group', action: 'create' },
      { entity: 'intercompany_pair', action: 'create' },
      { entity: 'intercompany_pair', action: 'delete' },
      { entity: 'intercompany_pair', action: 'create' },
      { entity: 'consolidation_group', action: 'update' },
      { entity: 'consolidation_group', action: 'delete' }
    ])
    expect(() => saveGroup(w.alpha, consolGroupInputSchema.parse({ name: 'H', members: [{ companySlug: 'nope', role: 'parent' }] }))).toThrow(/No company/)
    w.alpha.close()
  })
})
