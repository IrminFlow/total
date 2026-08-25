import { describe, expect, it } from 'vitest'
import {
  DUE_SOON_DAYS,
  JOB_WORK_MONTHS,
  deemedSupplyDate,
  firstLateDate,
  isJobWorkGodown,
  jobWorkGodownName,
  jobWorkStatus,
  planJobWorkReturn,
  returnDueDate,
  type JobWorkLineFacts
} from './jobWork'

const lines = (over: Partial<JobWorkLineFacts>[] = [{}]): JobWorkLineFacts[] =>
  over.map((o, i) => ({
    stockItemId: i + 1,
    name: `Item ${i + 1}`,
    sentQtyMilli: 100_000,
    returnedQtyMilli: 0,
    ...o
  }))

describe('returnDueDate', () => {
  it('gives inputs one year and capital goods three, per section 143', () => {
    expect(JOB_WORK_MONTHS.input).toBe(12)
    expect(JOB_WORK_MONTHS.capital).toBe(36)
    expect(returnDueDate('2025-03-15', 'input')).toBe('2026-03-15')
    expect(returnDueDate('2025-03-15', 'capital')).toBe('2028-03-15')
  })

  it('does not overflow a month end into the next month', () => {
    // Goods sent on 31 March are due back on 31 March, not on 1 April. That day is the
    // difference between compliant and a backdated liability.
    expect(returnDueDate('2025-03-31', 'input')).toBe('2026-03-31')
    expect(returnDueDate('2024-02-29', 'input')).toBe('2025-02-28')
  })

  it('is inclusive: the first late day is the one after', () => {
    expect(firstLateDate('2025-03-15', 'input')).toBe('2026-03-16')
  })
})

describe('deemedSupplyDate', () => {
  it('is the day the goods went out, not the day the clock ran out', () => {
    // Section 143(3): the supply is deemed to have happened on the day of sending, which is what
    // makes the interest run from then rather than from the anniversary.
    expect(deemedSupplyDate('2025-03-15')).toBe('2025-03-15')
  })
})

describe('jobWorkStatus', () => {
  it('is open while there is time and something still out', () => {
    const s = jobWorkStatus({ sentOn: '2026-01-01', goodsType: 'input', lines: lines() }, '2026-06-01')
    expect(s.state).toBe('open')
    expect(s.pendingQtyMilli).toBe(100_000)
    expect(s.deemedSupplyOn).toBeNull()
  })

  it('warns a month before the deadline', () => {
    const due = returnDueDate('2025-06-01', 'input')
    const s = jobWorkStatus({ sentOn: '2025-06-01', goodsType: 'input', lines: lines() }, '2026-05-15')
    expect(s.dueDate).toBe(due)
    expect(s.daysLeft).toBeLessThanOrEqual(DUE_SOON_DAYS)
    expect(s.state).toBe('due-soon')
  })

  it('goes overdue the day after, and names the date the supply is deemed to have happened', () => {
    const s = jobWorkStatus({ sentOn: '2025-03-15', goodsType: 'input', lines: lines() }, '2026-03-16')
    expect(s.state).toBe('overdue')
    expect(s.daysLeft).toBe(-1)
    expect(s.deemedSupplyOn).toBe('2025-03-15')
  })

  it('is still open ON the due date itself', () => {
    const s = jobWorkStatus({ sentOn: '2025-03-15', goodsType: 'input', lines: lines() }, '2026-03-15')
    expect(s.state).not.toBe('overdue')
    expect(s.daysLeft).toBe(0)
  })

  it('a challan that all came back is closed, not overdue, years later', () => {
    // Otherwise every old challan in the book turns red a year after go-live.
    const s = jobWorkStatus(
      { sentOn: '2020-03-15', goodsType: 'input', lines: lines([{ returnedQtyMilli: 100_000 }]) },
      '2026-06-01'
    )
    expect(s.state).toBe('closed')
    expect(s.pendingQtyMilli).toBe(0)
    expect(s.deemedSupplyOn).toBeNull()
  })

  it('a part return leaves the balance out and the clock running', () => {
    const s = jobWorkStatus(
      { sentOn: '2025-03-15', goodsType: 'input', lines: lines([{ returnedQtyMilli: 60_000 }]) },
      '2026-03-20'
    )
    expect(s.pendingQtyMilli).toBe(40_000)
    expect(s.state).toBe('overdue')
  })

  it('adds the pending quantities across lines', () => {
    const s = jobWorkStatus(
      {
        sentOn: '2026-01-01',
        goodsType: 'input',
        lines: lines([{ returnedQtyMilli: 25_000 }, { sentQtyMilli: 50_000 }])
      },
      '2026-02-01'
    )
    expect(s.pendingQtyMilli).toBe(75_000 + 50_000)
  })

  it('never lets an over-return show as a negative pending quantity', () => {
    const s = jobWorkStatus(
      { sentOn: '2026-01-01', goodsType: 'input', lines: lines([{ returnedQtyMilli: 120_000 }]) },
      '2026-02-01'
    )
    expect(s.pendingQtyMilli).toBe(0)
    expect(s.lines[0]!.pendingQtyMilli).toBe(0)
  })

  it('gives capital goods the longer clock', () => {
    const at = '2027-01-01'
    expect(jobWorkStatus({ sentOn: '2025-06-01', goodsType: 'input', lines: lines() }, at).state).toBe('overdue')
    expect(jobWorkStatus({ sentOn: '2025-06-01', goodsType: 'capital', lines: lines() }, at).state).toBe('open')
  })
})

describe('planJobWorkReturn', () => {
  const status = jobWorkStatus(
    { sentOn: '2026-01-01', goodsType: 'input', lines: lines([{ returnedQtyMilli: 40_000 }]) },
    '2026-02-01'
  )

  it('accepts a return within what is still out', () => {
    const plan = planJobWorkReturn({
      status,
      requested: [{ stockItemId: 1, qtyMilli: 60_000, kind: 'goods' }],
      returnedOn: '2026-02-01',
      sentOn: '2026-01-01'
    })
    expect(plan.errors).toEqual([])
  })

  it('refuses more than is out, and says which item', () => {
    const plan = planJobWorkReturn({
      status,
      requested: [{ stockItemId: 1, qtyMilli: 61_000, kind: 'goods' }],
      returnedOn: '2026-02-01',
      sentOn: '2026-01-01'
    })
    expect(plan.errors[0]).toContain('Item 1')
    expect(plan.errors[0]).toContain('still out')
  })

  it('adds up two lines for the same item before deciding', () => {
    // Splitting a return into "goods" and "waste" must not let the total exceed what is out.
    const plan = planJobWorkReturn({
      status,
      requested: [
        { stockItemId: 1, qtyMilli: 55_000, kind: 'goods' },
        { stockItemId: 1, qtyMilli: 10_000, kind: 'waste' }
      ],
      returnedOn: '2026-02-01',
      sentOn: '2026-01-01'
    })
    expect(plan.errors).toHaveLength(1)
  })

  it('refuses an item that was never sent out', () => {
    const plan = planJobWorkReturn({
      status,
      requested: [{ stockItemId: 99, qtyMilli: 1000, kind: 'goods' }],
      returnedOn: '2026-02-01',
      sentOn: '2026-01-01'
    })
    expect(plan.errors[0]).toContain('was not on the challan')
  })

  it('refuses a return dated before the goods went out', () => {
    const plan = planJobWorkReturn({
      status,
      requested: [{ stockItemId: 1, qtyMilli: 1000, kind: 'goods' }],
      returnedOn: '2025-12-31',
      sentOn: '2026-01-01'
    })
    expect(plan.errors[0]).toContain('before they were sent')
  })

  it('refuses an empty receipt and a zero quantity', () => {
    expect(
      planJobWorkReturn({ status, requested: [], returnedOn: '2026-02-01', sentOn: '2026-01-01' }).errors[0]
    ).toContain('Nothing to receive')
    expect(
      planJobWorkReturn({
        status,
        requested: [{ stockItemId: 1, qtyMilli: 0, kind: 'goods' }],
        returnedOn: '2026-02-01',
        sentOn: '2026-01-01'
      }).errors[0]
    ).toContain('not a return')
  })
})

describe('jobWorkGodownName', () => {
  it('names a godown per job worker, and recognises one again', () => {
    const name = jobWorkGodownName('Sharma Fabrication')
    expect(name).toBe('Job work — Sharma Fabrication')
    expect(isJobWorkGodown(name)).toBe(true)
    expect(isJobWorkGodown('Main Warehouse')).toBe(false)
  })

  it('fits the godown name column', () => {
    expect(jobWorkGodownName('X'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})
