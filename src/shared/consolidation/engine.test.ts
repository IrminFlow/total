import { describe, it, expect } from 'vitest'
import { consolidateStatement, lineForLedger, SPECIAL_LINES } from './engine'
import { allocate, mulDiv, shareOf } from './math'
import type { MemberInput, MemberLedger, MemberRow, PairInput, StatementInput, StatementKind, StatementResult } from './types'
import type { Nature } from '../domain'
import { CONSOLIDATION_SOURCES } from './sources'

// ---------------------------------------------------------------- fixtures

const GROUPS: Record<string, { nature: Nature; gp: boolean; path: string[]; equity?: boolean }> = {
  'Capital Account': { nature: 'liability', gp: false, path: ['Capital Account'], equity: true },
  'Sundry Debtors': { nature: 'asset', gp: false, path: ['Current Assets', 'Sundry Debtors'] },
  'Sundry Creditors': { nature: 'liability', gp: false, path: ['Current Liabilities', 'Sundry Creditors'] },
  'Cash-in-Hand': { nature: 'asset', gp: false, path: ['Current Assets', 'Cash-in-Hand'] },
  Investments: { nature: 'asset', gp: false, path: ['Investments'] },
  'Sales Accounts': { nature: 'income', gp: true, path: ['Sales Accounts'] },
  'Purchase Accounts': { nature: 'expense', gp: true, path: ['Purchase Accounts'] },
  'Indirect Expenses': { nature: 'expense', gp: false, path: ['Indirect Expenses'] },
  'Indirect Incomes': { nature: 'income', gp: false, path: ['Indirect Incomes'] }
}

/** A member from [id, name, group, amount] tuples (+ computed rows). */
function member(
  slug: string, rows: [number, string, string, number][],
  extra: Partial<MemberInput> & { computed?: MemberRow[] } = {}
): MemberInput {
  const ledgers: MemberLedger[] = rows.map(([id, name, group]) => {
    const g = GROUPS[group]!
    return { id, name, groupName: group, groupPath: g.path, nature: g.nature, gp: g.gp, equity: !!g.equity }
  })
  const memberRows: MemberRow[] = rows.map(([id, name, group, amount]) => {
    const g = GROUPS[group]!
    return { ledgerId: id, name, groupName: group, nature: g.nature, gp: g.gp, amount, equity: !!g.equity }
  })
  const { computed, ...rest } = extra
  return {
    slug, name: slug.toUpperCase(), role: 'parent', ownershipBp: 10000, included: true, ledgers,
    rows: [...memberRows, ...(computed ?? [])], periodProfit: 0, equityNow: 0, acquisitionEquity: null,
    closingStock: 0, purchases: 0, investmentLedgerId: null, ...rest
  }
}

const pnlCurrent = (amount: number): MemberRow => ({ ledgerId: -3, name: 'Profit & Loss A/c', groupName: 'Profit & Loss A/c', nature: 'liability', gp: false, amount, equity: true, computed: 'pnl_current' })
const closingStock = (amount: number, kind: StatementKind): MemberRow =>
  kind === 'pnl'
    ? { ledgerId: -2, name: 'Closing Stock', groupName: 'Stock-in-Hand', nature: 'income', gp: true, amount: -amount, equity: false, computed: 'closing_stock' }
    : { ledgerId: -2, name: 'Closing Stock', groupName: 'Stock-in-Hand', nature: 'asset', gp: false, amount, equity: false, computed: 'closing_stock' }

function run(kind: StatementKind, members: MemberInput[], pairs: PairInput[] = [], extra: Partial<StatementInput> = {}): StatementResult {
  return consolidateStatement({ kind, members, pairs, mappings: [], icTolerance: 100, unrealisedMarginBp: null, ...extra })
}
const line = (r: StatementResult, key: string) => r.lines.find((l) => l.key === key)
const pair = (id: number, kind: PairInput['kind'], a: [string, number], b: [string, number], extra: Partial<PairInput> = {}): PairInput =>
  ({ id, kind, a: { slug: a[0], ledgerId: a[1] }, b: { slug: b[0], ledgerId: b[1] }, unrealisedMarginBp: null, ...extra })
const sumElims = (r: StatementResult): number[] => r.eliminations.map((e) => e.postings.reduce((s, p) => s + p.amount, 0))

// ---------------------------------------------------------------- math

describe('consolidation math', () => {
  it('mulDiv rounds half away from zero and stays exact past 2^53', () => {
    expect(mulDiv(5, 1, 2)).toBe(3)
    expect(mulDiv(-5, 1, 2)).toBe(-3)
    expect(shareOf(1_000_000_000_000_00, 7_333)).toBe(73_330_000_000_000)
    expect(shareOf(333, 5000)).toBe(167)
  })
  it('allocate splits exactly by largest remainder', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(-10, [-3, -7])).toEqual([-3, -7])
    expect(allocate(5, [0, 0])).toEqual([5, 0])
    const parts = allocate(997, [123, 456, 789])
    expect(parts.reduce((s, p) => s + p, 0)).toBe(997)
  })
  it('every source has a rule and a citation; unverified ones are flagged', () => {
    for (const s of CONSOLIDATION_SOURCES) {
      expect(s.rule.length).toBeGreaterThan(10)
      expect(s.citation.length).toBeGreaterThan(10)
    }
    expect(CONSOLIDATION_SOURCES.filter((s) => !s.verified).map((s) => s.id)).toContain('ups-estimate')
  })
})

// ---------------------------------------------------------------- mapping

describe('group chart mapping', () => {
  const led = { id: 7, groupName: 'Sundry Debtors', groupPath: ['Current Assets', 'Sundry Debtors'], nature: 'asset' as const, gp: false }
  it('defaults to the ledger’s own group by name and nature', () => {
    expect(lineForLedger('a', led, [])).toMatchObject({ key: 'asset:sundry debtors', name: 'Sundry Debtors' })
  })
  it('a ledger override beats a group override, which also applies to sub-groups', () => {
    const maps = [
      { companySlug: 'a', ledgerId: null, groupName: 'current assets', targetName: 'Working capital', targetNature: null },
      { companySlug: 'a', ledgerId: 7, groupName: null, targetName: 'Trade receivables', targetNature: null }
    ]
    expect(lineForLedger('a', led, maps).name).toBe('Trade receivables')
    expect(lineForLedger('a', { ...led, id: 8 }, maps).name).toBe('Working capital')
    expect(lineForLedger('b', led, maps).name).toBe('Sundry Debtors') // other member untouched
  })
  it('lines with the same name and nature add up across members', () => {
    const r = run('tb', [
      member('a', [[1, 'Cash', 'Cash-in-Hand', 500], [2, 'Capital', 'Capital Account', -500]]),
      member('b', [[1, 'Petty cash', 'Cash-in-Hand', 200], [2, 'Capital', 'Capital Account', -200]], { role: 'subsidiary' })
    ])
    const cash = line(r, 'asset:cash-in-hand')!
    expect(cash.perMember).toEqual([500, 200])
    expect(cash.sources.map((s) => [s.slug, s.ledgerId, s.amount])).toEqual([['a', 1, 500], ['b', 1, 200]])
  })
})

// ---------------------------------------------------------------- inter-company balances

describe('inter-company receivable / payable', () => {
  const a = (): MemberInput => member('a', [[1, 'B Ltd', 'Sundry Debtors', 11800], [2, 'Capital', 'Capital Account', -11800]])
  const b = (payable: number): MemberInput =>
    member('b', [[5, 'A Ltd', 'Sundry Creditors', -payable], [6, 'Cash', 'Cash-in-Hand', payable], [7, 'Capital', 'Capital Account', 0]], { role: 'subsidiary' })

  it('agreeing balances are eliminated in full and the TB still balances', () => {
    const r = run('tb', [a(), b(11800)], [pair(1, 'receivable_payable', ['a', 1], ['b', 5])])
    expect(r.pairs[0]).toMatchObject({ basis: 'balance', difference: 0, status: 'reconciled' })
    expect(line(r, 'asset:sundry debtors')!.consolidated).toBe(0)
    expect(line(r, 'liability:sundry creditors')!.consolidated).toBe(0)
    expect(line(r, SPECIAL_LINES.unreconciledBal.key)).toBeUndefined()
    expect(r.totals.consolidated).toBe(0)
    expect(sumElims(r)).toEqual([0])
    const e = r.eliminations[0]!
    expect(e.postings.map((p) => [p.slug, p.ledgerId, p.amount])).toEqual([['a', 1, -11800], ['b', 5, 11800]])
    expect(line(r, 'asset:sundry debtors')!.eliminationIds).toEqual([e.id])
  })

  it('a difference beyond the tolerance is not eliminated silently — it stays as unreconciled', () => {
    const r = run('bs', [a(), b(10000)], [pair(1, 'receivable_payable', ['a', 1], ['b', 5])])
    expect(r.pairs[0]).toMatchObject({ difference: 1800, status: 'unreconciled' })
    const un = line(r, SPECIAL_LINES.unreconciledBal.key)!
    expect(un.consolidated).toBe(1800)
    expect(un.nature).toBe('asset')
    expect(r.eliminations[0]!.status).toBe('unreconciled')
    expect(r.balance!.assets).toBe(r.balance!.liabilities)
  })

  it('a difference within the tolerance is reconciled but still shown', () => {
    const r = run('bs', [a(), b(11750)], [pair(1, 'receivable_payable', ['a', 1], ['b', 5])])
    expect(r.pairs[0]!.status).toBe('reconciled')
    expect(line(r, SPECIAL_LINES.roundingBal.key)!.consolidated).toBe(50)
    expect(line(r, SPECIAL_LINES.unreconciledBal.key)).toBeUndefined()
  })

  it('a ledger used by two balance pairs is eliminated once; the second pair is skipped', () => {
    const r = run('tb', [a(), b(11800)], [pair(1, 'receivable_payable', ['a', 1], ['b', 5]), pair(2, 'loan', ['a', 1], ['b', 5])])
    expect(r.pairs.map((p) => p.status)).toEqual(['reconciled', 'skipped'])
    expect(line(r, 'asset:sundry debtors')!.consolidated).toBe(0)
  })

  it('skips a pair whose member is left out of the period', () => {
    const r = run('tb', [a(), { ...b(11800), included: false }], [pair(1, 'receivable_payable', ['a', 1], ['b', 5])])
    expect(r.pairs[0]!.status).toBe('skipped')
    expect(r.eliminations).toEqual([])
  })
})

// ---------------------------------------------------------------- sales / purchases, interest, UPS

describe('inter-company sales / purchases', () => {
  // A sells 10,000 to B (and 5,000 outside). B buys 10,000 from A and 10,000 outside, holds 4,000 of stock.
  const seller = (kind: StatementKind): MemberInput =>
    member('a', [[1, 'Sales', 'Sales Accounts', -15000], [2, 'B Ltd', 'Sundry Debtors', 0]], {
      periodProfit: 15000,
      computed: kind === 'bs' ? [pnlCurrent(-15000)] : []
    })
  const buyer = (kind: StatementKind): MemberInput =>
    member('b', [[1, 'Purchases', 'Purchase Accounts', 20000], [2, 'A Ltd', 'Sundry Creditors', 0]], {
      role: 'subsidiary', periodProfit: -16000, closingStock: 4000, purchases: 20000,
      computed: kind === 'pnl' ? [closingStock(4000, 'pnl')] : kind === 'bs' ? [closingStock(4000, 'bs'), pnlCurrent(16000)] : []
    })
  const spPair = (extra: Partial<PairInput> = {}): PairInput =>
    pair(1, 'sales_purchase', ['a', 2], ['b', 2], { flowsA: [{ ledgerId: 1, amount: -10000 }], flowsB: [{ ledgerId: 1, amount: 10000 }], ...extra })

  it('party-derived flows eliminate revenue against cost; profit is unchanged', () => {
    const r = run('pnl', [seller('pnl'), buyer('pnl')], [spPair()])
    expect(r.pairs[0]).toMatchObject({ basis: 'flow', difference: 0, status: 'reconciled' })
    expect(line(r, 'income:sales accounts')!.consolidated).toBe(-5000)
    expect(line(r, 'expense:purchase accounts')!.consolidated).toBe(10000)
    expect(r.profit!.netProfit).toBe(r.profit!.perMember.reduce((s, v) => s + v, 0))
    expect(line(r, 'income:sales accounts')!.sources[0]).toMatchObject({ slug: 'a', ledgerId: 1 })
  })

  it('P&L-ledger pairs use the ledgers’ own amounts', () => {
    const a = member('a', [[3, 'Interest received', 'Indirect Incomes', -900]])
    const b = member('b', [[4, 'Interest paid', 'Indirect Expenses', 1000]], { role: 'subsidiary' })
    const r = run('pnl', [a, b], [pair(1, 'other', ['a', 3], ['b', 4])])
    expect(r.pairs[0]).toMatchObject({ basis: 'flow', difference: 100, status: 'reconciled' })
    expect(line(r, 'income:indirect incomes')!.consolidated).toBe(0)
    expect(line(r, SPECIAL_LINES.roundingFlow.key)!.consolidated).toBe(100)
    const r2 = run('pnl', [a, b], [pair(1, 'other', ['a', 3], ['b', 4])], { icTolerance: 0 })
    expect(line(r2, SPECIAL_LINES.unreconciledFlow.key)!.consolidated).toBe(100)
    expect(r2.profit!.netProfit).toBe(-100) // the difference still hits profit
  })

  it('unrealised profit in the buyer’s closing stock reduces stock and profit', () => {
    // held = 4,000 × 10,000 / 20,000 = 2,000; × 25 % = 500
    const pnl = run('pnl', [seller('pnl'), buyer('pnl')], [spPair()], { unrealisedMarginBp: 2500 })
    const ups = pnl.eliminations.find((e) => e.rule === 'unrealised_profit')!
    expect(ups.postings).toEqual([expect.objectContaining({ lineKey: 'computed:closing_stock', slug: 'b', amount: 500 })])
    expect(pnl.profit!.netProfit).toBe(15000 - 16000 - 500)
    expect(line(pnl, 'computed:closing_stock')!.consolidated).toBe(-3500)

    const bs = run('bs', [seller('bs'), buyer('bs')], [spPair()], { unrealisedMarginBp: 2500 })
    expect(line(bs, SPECIAL_LINES.upsStock.key)!.consolidated).toBe(-500)
    expect(bs.totals.elimination).toBe(0)
    const tb = run('tb', [seller('tb'), buyer('tb')], [spPair()], { unrealisedMarginBp: 2500 })
    expect(line(tb, SPECIAL_LINES.upsExpense.key)!.consolidated).toBe(500)
    expect(tb.totals.consolidated).toBe(tb.totals.perMember.reduce((s, v) => s + v, 0))
  })

  it('a pair margin overrides the group’s; 0 switches it off', () => {
    const r = run('pnl', [seller('pnl'), buyer('pnl')], [spPair({ unrealisedMarginBp: 1000 })], { unrealisedMarginBp: 2500 })
    expect(r.eliminations.find((e) => e.rule === 'unrealised_profit')!.postings[0]!.amount).toBe(200)
    const off = run('pnl', [seller('pnl'), buyer('pnl')], [spPair({ unrealisedMarginBp: 0 })], { unrealisedMarginBp: 2500 })
    expect(off.eliminations.some((e) => e.rule === 'unrealised_profit')).toBe(false)
  })
})

// ---------------------------------------------------------------- investment, goodwill, minority

describe('investment vs equity and minority interest (AS 21 para 13)', () => {
  // Parent paid 900 for 80 % of S; S's equity at acquisition 1,000 (capital); today 1,200 (+200 profit).
  const parent = (kind: StatementKind): MemberInput =>
    member('p', [[1, 'Investment in S', 'Investments', 900], [2, 'Cash', 'Cash-in-Hand', 100], [3, 'Capital', 'Capital Account', -1000]], {
      computed: kind === 'bs' ? [] : []
    })
  const sub = (kind: StatementKind, ownershipBp = 8000, extra: Partial<MemberInput> = {}): MemberInput =>
    member('s', [[1, 'Share capital', 'Capital Account', -1000], [2, 'Cash', 'Cash-in-Hand', 1200], ...(kind === 'tb' ? [[3, 'Sales', 'Sales Accounts', -200] as [number, string, string, number]] : [])], {
      role: 'subsidiary', ownershipBp, periodProfit: 200, equityNow: 1200, acquisitionEquity: 1000, investmentLedgerId: 1,
      computed: kind === 'bs' ? [pnlCurrent(-200)] : [], ...extra
    })

  it('goodwill, minority interest and post-acquisition reserves on the balance sheet', () => {
    const r = run('bs', [parent('bs'), sub('bs')])
    expect(line(r, SPECIAL_LINES.goodwill.key)!.consolidated).toBe(100) // 900 − 80 % × 1,000
    expect(line(r, SPECIAL_LINES.minorityInterest.key)!.consolidated).toBe(-240) // 20 % × 1,200
    expect(line(r, SPECIAL_LINES.postAcq.key)!.consolidated).toBe(-160) // 80 % × 200
    expect(line(r, 'asset:investments')!.consolidated).toBe(0)
    // S's share capital is gone; only the parent's remains.
    expect(line(r, 'liability:capital account')!.consolidated).toBe(-1000)
    expect(r.balance!.assets).toBe(r.balance!.liabilities)
    expect(sumElims(r)).toEqual([0])
    expect(r.eliminations[0]!.source).toBe('as21-13ab')
  })

  it('cost below the parent’s share of equity is a capital reserve', () => {
    const r = run('bs', [parent('bs'), sub('bs', 10000)])
    expect(line(r, SPECIAL_LINES.capitalReserve.key)!.consolidated).toBe(-100)
    expect(line(r, SPECIAL_LINES.goodwill.key)).toBeUndefined()
    expect(line(r, SPECIAL_LINES.minorityInterest.key)).toBeUndefined()
    expect(r.eliminations[0]!.source).toBe('as21-13c')
  })

  it('the minority share of profit is shown below net profit on the P&L', () => {
    const p = member('p', [[9, 'Sales', 'Sales Accounts', -500]], { periodProfit: 500 })
    const s = member('s', [[9, 'Sales', 'Sales Accounts', -200]], { role: 'subsidiary', ownershipBp: 8000, periodProfit: 200 })
    const r = run('pnl', [p, s])
    expect(r.profit).toEqual({ perMember: [500, 200], netProfit: 700, minorityInterest: 40, ownersProfit: 660 })
    expect(line(r, SPECIAL_LINES.minorityProfit.key)!.section).toBe('appropriation')
  })

  it('the trial balance carries the minority share of profit and still balances', () => {
    const p = member('p', [[1, 'Investment in S', 'Investments', 900], [2, 'Cash', 'Cash-in-Hand', 100], [3, 'Capital', 'Capital Account', -1000]])
    const r = run('tb', [p, sub('tb')])
    expect(r.totals.consolidated).toBe(0)
    expect(sumElims(r).every((v) => v === 0)).toBe(true)
    // closed equity 1,000: MI 200 + profit share 40 = 240, like the balance sheet
    expect(line(r, SPECIAL_LINES.minorityInterest.key)!.consolidated).toBe(-240)
    expect(line(r, SPECIAL_LINES.minorityProfit.key)!.consolidated).toBe(40)
  })

  it('without an investment ledger only the minority interest is carved out (with a warning)', () => {
    const r = run('bs', [parent('bs'), sub('bs', 7500, { investmentLedgerId: null })])
    expect(line(r, SPECIAL_LINES.minorityInterest.key)!.consolidated).toBe(-300)
    expect(line(r, SPECIAL_LINES.goodwill.key)).toBeUndefined()
    expect(r.warnings.join(' ')).toMatch(/no investment ledger/)
    expect(r.totals.consolidated).toBe(0)
  })

  it('an associate is not added line by line: share of profit on the P&L, equity-method on the BS', () => {
    const assoc = member('x', [[1, 'Capital', 'Capital Account', -1000], [2, 'Sales', 'Sales Accounts', -400]], {
      role: 'associate', ownershipBp: 3000, periodProfit: 400, equityNow: 1400, acquisitionEquity: 1000, investmentLedgerId: 1
    })
    const pnl = run('pnl', [member('p', [[9, 'Sales', 'Sales Accounts', -500]], { periodProfit: 500 }), assoc])
    expect(pnl.members.map((m) => m.slug)).toEqual(['p'])
    expect(pnl.profit!.netProfit).toBe(620)
    const bs = run('bs', [parent('bs'), { ...assoc, rows: [] }])
    expect(line(bs, 'asset:investments')!.consolidated).toBe(900 + 120)
    expect(line(bs, SPECIAL_LINES.postAcq.key)!.consolidated).toBe(-120)
    expect(bs.totals.consolidated).toBe(0)
  })
})
