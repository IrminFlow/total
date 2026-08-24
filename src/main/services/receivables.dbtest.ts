import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, updateLedger, getLedger } from './masters'
import { saveVoucher } from './vouchers'
import { setCollectionsPolicy, getCollectionsPolicy, DEFAULT_COLLECTIONS_POLICY } from './config'
import {
  ageingBy,
  advances,
  allocationSuggestions,
  badDebtProvision,
  bulkReminders,
  creditScores,
  interestDue,
  partyStatement,
  paymentSchedule,
  provisionDraft,
  termsFor
} from './receivables'

/**
 * The collections desk.
 *
 * Every function here reads the same FIFO allocation the ageing report does, so the tests care
 * most about the joins between them: that a party's own terms beat the company default, that a
 * provision never touches the party ledger, that the payment schedule counts the money as well as
 * the bills, and that nothing here can post anything.
 */
type Db = ReturnType<typeof seededDb>

function groupId(db: Db, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function party(db: Db, name: string, extra: Record<string, unknown> = {}) {
  return createLedger(db, { name, groupId: groupId(db, 'Sundry Debtors'), creditDays: 30, ...extra })
}

function creditor(db: Db, name: string, extra: Record<string, unknown> = {}) {
  return createLedger(db, { name, groupId: groupId(db, 'Sundry Creditors'), creditDays: 30, ...extra })
}

function counterLedger(db: Db, name: string, group: string): number {
  const existing = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
  if (existing) return existing.id
  return createLedger(db, { name, groupId: groupId(db, group) }).id
}

function post(
  db: Db,
  kind: 'sales' | 'receipt' | 'purchase' | 'payment',
  opts: { date: string; number: string; partyLedgerId: number; amount: number }
) {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const partyDr = kind === 'sales' || kind === 'payment'
  const other =
    kind === 'sales'
      ? counterLedger(db, 'Sales Account', 'Sales Accounts')
      : kind === 'purchase'
        ? counterLedger(db, 'Purchase Account', 'Purchase Accounts')
        : cash
  return saveVoucher(db, {
    voucherTypeId: vt.id,
    date: opts.date,
    number: opts.number,
    partyLedgerId: opts.partyLedgerId,
    lines: [
      { ledgerId: opts.partyLedgerId, drCr: partyDr ? 'dr' : 'cr', amount: opts.amount, costAllocations: [] },
      { ledgerId: other, drCr: partyDr ? 'cr' : 'dr', amount: opts.amount, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null
  } as never)
}

describe('interest on overdue bills', () => {
  it("uses the party's own rate over the company default", () => {
    const db = seededDb()
    setCollectionsPolicy(db, { ...DEFAULT_COLLECTIONS_POLICY, interestRateBp: 1200 })
    const house = party(db, 'House Rate Co')
    const own = party(db, 'Own Rate Co', { interestRateBp: 2400 })
    expect(termsFor(db, { interest_rate_bp: null, interest_grace_days: null }).rateBp).toBe(1200)
    expect(termsFor(db, { interest_rate_bp: 2400, interest_grace_days: null }).rateBp).toBe(2400)

    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: house.id, amount: 10_000_000 })
    post(db, 'sales', { date: '2026-01-01', number: 'B', partyLedgerId: own.id, amount: 10_000_000 })
    const rows = interestDue(db, 'receivable', '2026-12-31')
    expect(rows.map((r) => r.name)).toEqual(['Own Rate Co', 'House Rate Co'])
    // Twice the rate on the same bill for the same days.
    expect(rows[0]!.interest.total).toBe(rows[1]!.interest.total * 2)
  })

  it('lists nobody when the company charges no interest', () => {
    const db = seededDb()
    const p = party(db, 'Late Co')
    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: p.id, amount: 10_000_000 })
    expect(interestDue(db, 'receivable', '2026-12-31')).toEqual([])
  })

  it('holds off while a bill is inside the grace period', () => {
    const db = seededDb()
    const p = party(db, 'Grace Co', { interestRateBp: 1800, interestGraceDays: 30 })
    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: p.id, amount: 10_000_000 })
    // Due 31 Jan (30 credit days); 20 Feb is 20 days overdue, inside the 30-day grace.
    expect(interestDue(db, 'receivable', '2026-02-20')).toEqual([])
    expect(interestDue(db, 'receivable', '2026-04-20')[0]!.interest.total).toBeGreaterThan(0)
  })
})

describe('credit scoring', () => {
  it('scores a party who pays on time above one who does not', () => {
    const db = seededDb()
    const good = party(db, 'Prompt Traders')
    const bad = party(db, 'Slow Traders')
    for (let i = 1; i <= 5; i++) {
      post(db, 'sales', { date: `2026-0${i}-01`, number: `G${i}`, partyLedgerId: good.id, amount: 100_000 })
      post(db, 'receipt', { date: `2026-0${i}-20`, number: `GR${i}`, partyLedgerId: good.id, amount: 100_000 })
      post(db, 'sales', { date: `2026-0${i}-01`, number: `B${i}`, partyLedgerId: bad.id, amount: 100_000 })
    }
    // Slow Traders pays everything, very late.
    post(db, 'receipt', { date: '2026-12-01', number: 'BR', partyLedgerId: bad.id, amount: 500_000 })
    const rows = creditScores(db, '2026-12-31')
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get('Prompt Traders')!.score!.band).toBe('excellent')
    expect(byName.get('Slow Traders')!.score!.score).toBeLessThan(byName.get('Prompt Traders')!.score!.score)
    // Worst first — the list is a call sheet.
    expect(rows[0]!.name).toBe('Slow Traders')
  })

  it('returns a null score rather than a guess for a new party', () => {
    const db = seededDb()
    const p = party(db, 'Brand New Co')
    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: p.id, amount: 100_000 })
    const row = creditScores(db, '2026-06-01').find((r) => r.name === 'Brand New Co')!
    expect(row.score).toBeNull()
    expect(row.pending).toBe(100_000)
  })
})

describe('allocation suggestions', () => {
  it('spots the combination of bills a receipt clears', () => {
    const db = seededDb()
    const p = party(db, 'Combo Co')
    post(db, 'sales', { date: '2026-01-01', number: 'INV-1', partyLedgerId: p.id, amount: 500_00 })
    post(db, 'sales', { date: '2026-01-05', number: 'INV-2', partyLedgerId: p.id, amount: 300_00 })
    post(db, 'sales', { date: '2026-01-09', number: 'INV-3', partyLedgerId: p.id, amount: 200_00 })
    const combo = allocationSuggestions(db, p.id, 700_00, '2026-02-01').find((s) => s.kind === 'exact-combination')!
    expect(combo.allocations.map((a) => a.number).sort()).toEqual(['INV-1', 'INV-3'])
  })

  it('suggests nothing for a party with nothing open', () => {
    const db = seededDb()
    const p = party(db, 'Settled Co')
    expect(allocationSuggestions(db, p.id, 100_00, '2026-02-01')).toEqual([])
  })
})

describe('ageing by salesperson or territory', () => {
  it('groups on the field and calls an empty one Unassigned', () => {
    const db = seededDb()
    const a = party(db, 'North Co', { salesperson: 'Ravi', territory: 'North' })
    const b = party(db, 'South Co', { salesperson: 'Ravi', territory: 'South' })
    const c = party(db, 'Nobody Co')
    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: a.id, amount: 100_00 })
    post(db, 'sales', { date: '2026-01-01', number: 'B', partyLedgerId: b.id, amount: 200_00 })
    post(db, 'sales', { date: '2026-01-01', number: 'C', partyLedgerId: c.id, amount: 900_00 })

    const bySalesperson = ageingBy(db, 'receivable', '2026-06-01', 'salesperson')
    // Biggest first: nobody's territory holds three times what Ravi's does.
    expect(bySalesperson.rows.map((r) => r.key)).toEqual(['Unassigned', 'Ravi'])
    expect(bySalesperson.rows.find((r) => r.key === 'Ravi')!.partyCount).toBe(2)
    expect(bySalesperson.total).toBe(1200_00)

    const byTerritory = ageingBy(db, 'receivable', '2026-06-01', 'territory')
    expect(byTerritory.rows.map((r) => r.key).sort()).toEqual(['North', 'South', 'Unassigned'])
  })

  it('honours custom band cuts, columns and totals together', () => {
    const db = seededDb()
    const p = party(db, 'Old Co')
    post(db, 'sales', { date: '2026-01-01', number: 'A', partyLedgerId: p.id, amount: 100_00 })
    const r = ageingBy(db, 'receivable', '2026-06-01', 'party', [45, 90])
    expect(r.bandLabels).toEqual(['0-45 days', '46-90 days', '90+ days'])
    expect(r.totals).toHaveLength(3)
    expect(r.totals.reduce((s, v) => s + v, 0)).toBe(r.total)
  })
})

describe('bad-debt provisioning', () => {
  it('provides against old bills only, and never credits the party', () => {
    const db = seededDb()
    const old = party(db, 'Ancient Co')
    const fresh = party(db, 'Fresh Co')
    post(db, 'sales', { date: '2024-01-01', number: 'OLD', partyLedgerId: old.id, amount: 100_00 })
    post(db, 'sales', { date: '2026-05-01', number: 'NEW', partyLedgerId: fresh.id, amount: 900_00 })

    const result = badDebtProvision(db, '2026-06-01')
    expect(result.parties.map((p) => p.name)).toEqual(['Ancient Co'])
    // 880+ days overdue → the 730-day rung, 100%.
    expect(result.total).toBe(100_00)

    const draft = provisionDraft(db, '2026-06-01')!
    expect(draft.lines.map((l) => l.ledgerName)).toEqual(['Provision for Doubtful Debts', 'Reserve for Doubtful Debts'])
    expect(draft.lines.every((l) => l.ledgerName !== 'Ancient Co')).toBe(true)
    expect(draft.lines.reduce((s, l) => s + (l.drCr === 'dr' ? l.amount : -l.amount), 0)).toBe(0)
    expect(draft.missingLedgers).toHaveLength(2)
    // Proposing is not posting.
    expect(db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE number = 'PROV'").get()).toEqual({ n: 0 })
  })

  it('returns no draft when nothing is doubtful', () => {
    const db = seededDb()
    const p = party(db, 'Fresh Co')
    post(db, 'sales', { date: '2026-05-01', number: 'NEW', partyLedgerId: p.id, amount: 900_00 })
    expect(provisionDraft(db, '2026-06-01')).toBeNull()
  })
})

describe('advances', () => {
  it('surfaces money on account that no bill has claimed', () => {
    const db = seededDb()
    const p = party(db, 'Prepay Co')
    post(db, 'receipt', { date: '2026-01-10', number: 'R1', partyLedgerId: p.id, amount: 500_00 })
    post(db, 'sales', { date: '2026-02-01', number: 'INV', partyLedgerId: p.id, amount: 200_00 })
    const rows = advances(db, 'receivable', '2026-06-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Prepay Co', unapplied: 300_00, openBills: 0, lastReceiptDate: '2026-01-10' })
  })

  it('says nothing when every receipt is matched', () => {
    const db = seededDb()
    const p = party(db, 'Even Co')
    post(db, 'sales', { date: '2026-01-01', number: 'INV', partyLedgerId: p.id, amount: 200_00 })
    post(db, 'receipt', { date: '2026-01-10', number: 'R1', partyLedgerId: p.id, amount: 200_00 })
    expect(advances(db, 'receivable', '2026-06-01')).toEqual([])
  })
})

describe('payment schedule', () => {
  it('stacks overdue bills at the front and finds the day the money runs out', () => {
    const db = seededDb()
    const v = creditor(db, 'Steel Supplier')
    // Cash in: a sale collected in cash, so there are funds to schedule against.
    const cust = party(db, 'Cash Customer')
    post(db, 'sales', { date: '2026-01-01', number: 'S1', partyLedgerId: cust.id, amount: 100_000 })
    post(db, 'receipt', { date: '2026-01-02', number: 'R1', partyLedgerId: cust.id, amount: 100_000 })
    // Two purchase bills: one already overdue, one due later than the funds can cover.
    post(db, 'purchase', { date: '2026-01-01', number: 'P1', partyLedgerId: v.id, amount: 40_000 })
    post(db, 'purchase', { date: '2026-03-01', number: 'P2', partyLedgerId: v.id, amount: 90_000 })

    const sched = paymentSchedule(db, '2026-03-15', '2026-04-30')
    // The purchase bills are unpaid, so the cash is still all there — which is the point: the
    // schedule compares money on hand against money about to leave, not against money spent.
    expect(sched.funds).toBe(100_000)
    expect(sched.overdue.map((b) => b.number)).toEqual(['P1'])
    expect(sched.days.map((d) => d.date)).toEqual(['2026-03-31'])
    expect(sched.total).toBe(130_000)
    expect(sched.shortfallDate).toBe('2026-03-31')
  })

  it('counts only what falls inside the window', () => {
    const db = seededDb()
    const v = creditor(db, 'Far Supplier')
    post(db, 'purchase', { date: '2026-06-01', number: 'P1', partyLedgerId: v.id, amount: 50_000 })
    const sched = paymentSchedule(db, '2026-03-01', '2026-03-31')
    expect(sched.days).toEqual([])
    expect(sched.total).toBe(0)
  })
})

describe('bulk reminders', () => {
  it('writes one message per overdue party, escalating with age', () => {
    const db = seededDb()
    const recent = party(db, 'Recent Co', { phone: '9876543210' })
    const ancient = party(db, 'Ancient Co', { email: 'a@b.com' })
    post(db, 'sales', { date: '2026-05-15', number: 'R', partyLedgerId: recent.id, amount: 100_00 })
    post(db, 'sales', { date: '2025-01-01', number: 'A', partyLedgerId: ancient.id, amount: 200_00 })

    const rows = bulkReminders(db, 'Demo Traders', 'receivable', '2026-06-20')
    expect(rows.map((r) => r.name)).toEqual(['Ancient Co', 'Recent Co'])
    expect(rows[0]!.tone).toBe('final')
    expect(rows[1]!.tone).toBe('gentle')
    expect(rows[0]!.body).toContain('Demo Traders')
    // A party with a number gets a link; one without gets null rather than a broken link.
    expect(rows.find((r) => r.name === 'Recent Co')!.whatsapp).toContain('wa.me/919876543210')
    expect(rows.find((r) => r.name === 'Ancient Co')!.whatsapp).toBeNull()
  })

  it('leaves out parties who are not yet overdue', () => {
    const db = seededDb()
    const p = party(db, 'Within Terms Co')
    post(db, 'sales', { date: '2026-06-01', number: 'A', partyLedgerId: p.id, amount: 100_00 })
    expect(bulkReminders(db, 'Demo Traders', 'receivable', '2026-06-15')).toEqual([])
  })

  it('states interest on the letter only when the party has terms', () => {
    const db = seededDb()
    const p = party(db, 'Charged Co', { interestRateBp: 1800 })
    post(db, 'sales', { date: '2025-01-01', number: 'A', partyLedgerId: p.id, amount: 10_000_000 })
    const [with_] = bulkReminders(db, 'Demo Traders', 'receivable', '2026-06-20')
    expect(with_!.interest).toBeGreaterThan(0)
    expect(with_!.body).toContain('Interest at 18% p.a.')
    expect(bulkReminders(db, 'Demo Traders', 'receivable', '2026-06-20', { includeInterest: false })[0]!.body).not.toContain(
      'Interest at'
    )
  })
})

describe('party statement', () => {
  it('runs the balance forward from an opening figure and ages what is still open', () => {
    const db = seededDb()
    const p = party(db, 'Statement Co')
    post(db, 'sales', { date: '2026-01-10', number: 'S1', partyLedgerId: p.id, amount: 100_00 })
    post(db, 'receipt', { date: '2026-02-10', number: 'R1', partyLedgerId: p.id, amount: 40_00 })
    post(db, 'sales', { date: '2026-03-10', number: 'S2', partyLedgerId: p.id, amount: 50_00 })

    const st = partyStatement(db, p.id, '2026-02-01', '2026-03-31')
    expect(st.openingBalance).toBe(100_00)
    expect(st.lines.map((l) => l.number)).toEqual(['R1', 'S2'])
    expect(st.closingBalance).toBe(110_00)
    expect(st.lines[st.lines.length - 1]!.balance).toBe(st.closingBalance)
    expect(st.buckets.reduce((s, v) => s + v, 0)).toBe(110_00)
    expect(st.bandLabels).toEqual(['0-30 days', '31-60 days', '61-90 days', '90+ days'])
    expect(st.interest).toBeNull()
  })

  it('refuses a party that does not exist rather than returning an empty statement', () => {
    const db = seededDb()
    expect(() => partyStatement(db, 99999, '2026-01-01', '2026-03-31')).toThrow('Party not found')
  })
})

describe('collections policy', () => {
  it('round-trips and rejects a ladder that goes backwards', () => {
    const db = seededDb()
    const saved = setCollectionsPolicy(db, {
      ...DEFAULT_COLLECTIONS_POLICY,
      interestRateBp: 1500,
      bandCuts: [45, 90, 180],
      contact: 'Call 98765 43210'
    })
    expect(saved.bandCuts).toEqual([45, 90, 180])
    expect(getCollectionsPolicy(db).contact).toBe('Call 98765 43210')
    expect(() =>
      setCollectionsPolicy(db, { ...DEFAULT_COLLECTIONS_POLICY, bandCuts: [90, 30] })
    ).toThrow('ascending')
    expect(() =>
      setCollectionsPolicy(db, {
        ...DEFAULT_COLLECTIONS_POLICY,
        provisionPolicy: [{ afterDays: 180, pct: 50 }, { afterDays: 365, pct: 10 }]
      })
    ).toThrow('rise with age')
  })

  it('falls back to defaults when meta holds nonsense', () => {
    const db = seededDb()
    db.prepare("INSERT INTO meta (key, value) VALUES ('collections', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify({ bandCuts: [90, 30], interestRateBp: 99999, provisionPolicy: 'nope' })
    )
    const policy = getCollectionsPolicy(db)
    expect(policy.bandCuts).toEqual([30, 60, 90])
    expect(policy.interestRateBp).toBe(0)
    expect(policy.provisionPolicy).toHaveLength(3)
  })
})

describe('party master carries its own terms', () => {
  it('round-trips interest, salesperson and territory through create and update', () => {
    const db = seededDb()
    const p = party(db, 'Terms Co', { interestRateBp: 2400, interestGraceDays: 7, salesperson: 'Ravi', territory: 'West' })
    expect(getLedger(db, p.id)).toMatchObject({
      interestRateBp: 2400,
      interestGraceDays: 7,
      salesperson: 'Ravi',
      territory: 'West'
    })
    updateLedger(db, p.id, { name: 'Terms Co', groupId: groupId(db, 'Sundry Debtors'), salesperson: 'Meena' } as never)
    expect(getLedger(db, p.id)!.salesperson).toBe('Meena')
  })
})
