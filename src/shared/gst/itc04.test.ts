import { describe, expect, it } from 'vitest'
import {
  addYears,
  buildItc04,
  CLOCK_YEARS,
  deemedSupplies,
  itc04Periodicity,
  itc04PeriodsForFy,
  type Itc04Options,
  type Itc04Period,
  type JobWorkChallan,
  type JobWorkReturn
} from './itc04'
import { CRORE } from './turnover'

const H1: Itc04Period = {
  from: '2025-04-01',
  to: '2025-09-30',
  label: 'Apr–Sep 2025',
  dueDate: '2025-10-25'
}

const OPTS: Itc04Options = { principalStateCode: '27' } // Maharashtra

/** 100 pieces worth ₹1,00,000 at 18%, sent 10 April 2025 to a registered job worker in-state. */
function challan(over: Partial<JobWorkChallan> = {}): JobWorkChallan {
  return {
    challanNumber: 'JW/001',
    challanDate: '2025-04-10',
    jobWorkerGstin: '27AAAPA1234A1Z5',
    jobWorkerStateCode: '27',
    goodsType: 'input',
    description: 'Forged blanks',
    hsn: '73269099',
    qtyMilli: 100_000,
    uqc: 'PCS',
    taxableValuePaise: 1_00_000_00,
    gstRate: 18,
    ...over
  }
}

function ret(over: Partial<JobWorkReturn> = {}): JobWorkReturn {
  return {
    originalChallanNumber: 'JW/001',
    originalChallanDate: '2025-04-10',
    receiptChallanNumber: 'JWR/001',
    receiptChallanDate: '2025-06-15',
    qtyMilli: 100_000,
    disposition: 'returned',
    ...over
  }
}

describe('addYears', () => {
  it('lands on the anniversary, not 365 days later', () => {
    expect(addYears('2025-04-10', 1)).toBe('2026-04-10')
    expect(addYears('2025-04-10', 3)).toBe('2028-04-10')
    // 2028 is a leap year, so the input crossed one; the anniversary is still 10 April.
    expect(addYears('2024-01-31', 1)).toBe('2025-01-31')
  })

  it('clamps 29 February back to 28 February, which is the conservative direction', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28')
    expect(addYears('2024-02-29', 3)).toBe('2027-02-28')
  })
})

describe('a period with no challans is a nil ITC-04, not a crash', () => {
  it('returns a valid empty form with nil set', () => {
    const form = buildItc04(H1, [], [], OPTS)
    expect(form.nil).toBe(true)
    expect(form.table4).toEqual([])
    expect(form.table5A).toEqual([])
    expect(form.table5B).toEqual([])
    expect(form.table5C).toEqual([])
    expect(form.totals.sentQtyMilli).toBe(0)
    expect(form.totals.sentValuePaise).toBe(0)
    expect(form.issues).toEqual([])
    expect(form.deemed.rows).toEqual([])
    expect(form.deemed.totalDeemedTaxPaise).toBe(0)
    expect(form.period.dueDate).toBe('2025-10-25')
  })
})

describe('a fully returned challan', () => {
  const c = challan()
  const r = ret()

  it('appears in Table 4 when sent and Table 5A when received back', () => {
    const form = buildItc04(H1, [c], [r], OPTS)
    expect(form.nil).toBe(false)
    expect(form.table4).toHaveLength(1)
    expect(form.table4[0]!.qtyMilli).toBe(100_000)
    expect(form.table4[0]!.goodsType).toBe('input')
    // Same state, so the rate columns split CGST/SGST 9 + 9 and no IGST.
    expect(form.table4[0]!.supply).toBe('intra')
    expect(form.table4[0]!.tax.cgst).toBe(9_000_00)
    expect(form.table4[0]!.tax.sgst).toBe(9_000_00)
    expect(form.table4[0]!.tax.igst).toBe(0)
    expect(form.table5A).toHaveLength(1)
    expect(form.table5A[0]!.disposition).toBe('returned')
    expect(form.totals.receivedBackQtyMilli).toBe(100_000)
  })

  it('leaves no balance and no deemed supply', () => {
    const d = deemedSupplies([c], [r], '2030-01-01')
    expect(d.rows[0]!.balanceMilli).toBe(0)
    expect(d.rows[0]!.overdue).toBe(false)
    expect(d.rows[0]!.deemedSupplyDate).toBeNull()
    expect(d.totalDeemedTaxPaise).toBe(0)
    expect(d.issues).toEqual([])
  })
})

describe('a partly returned challan is a partial deemed supply, not all-or-nothing', () => {
  const c = challan()
  const r = ret({ qtyMilli: 60_000 }) // 60 of 100 pieces back

  it('deems only the unreturned quantity, valued pro rata', () => {
    const d = deemedSupplies([c], [r], '2026-05-01', { principalStateCode: '27' })
    const row = d.rows[0]!
    expect(row.accountedMilli).toBe(60_000)
    expect(row.balanceMilli).toBe(40_000)
    expect(row.overdue).toBe(true)
    // 40% of ₹1,00,000 = ₹40,000; 18% of that is ₹7,200.
    expect(row.deemedValuePaise).toBe(40_000_00)
    expect(row.deemedTaxPaise).toBe(7_200_00)
    expect(row.breakup!.cgst).toBe(3_600_00)
    expect(row.breakup!.sgst).toBe(3_600_00)
    expect(d.totalDeemedValuePaise).toBe(40_000_00)
  })

  it('dates the deemed supply on the day the goods went out, not the day the year ran out', () => {
    // Section 143(3): deemed supplied "on the day when the said inputs were sent out".
    const d = deemedSupplies([c], [r], '2026-05-01')
    expect(d.rows[0]!.deemedSupplyDate).toBe('2025-04-10')
    expect(d.rows[0]!.dueBackBy).toBe('2026-04-10')
    expect(d.rows[0]!.daysOverdue).toBe(21)
  })

  it('is not yet a deemed supply while the year is still running', () => {
    const d = deemedSupplies([c], [r], '2025-12-31')
    expect(d.rows[0]!.balanceMilli).toBe(40_000)
    expect(d.rows[0]!.overdue).toBe(false)
    expect(d.rows[0]!.deemedValuePaise).toBe(0)
  })
})

describe('the one-year clock on inputs (section 143(3))', () => {
  const c = challan() // sent 2025-04-10
  const nothingBack: JobWorkReturn[] = []

  it('is one year', () => {
    expect(CLOCK_YEARS.input).toBe(1)
  })

  it('is still inside the window on the anniversary itself', () => {
    const d = deemedSupplies([c], nothingBack, '2026-04-10')
    expect(d.rows[0]!.dueBackBy).toBe('2026-04-10')
    expect(d.rows[0]!.overdue).toBe(false)
    expect(d.overdue).toHaveLength(0)
  })

  it('is outside the window the very next day, for the whole quantity', () => {
    const d = deemedSupplies([c], nothingBack, '2026-04-11')
    expect(d.rows[0]!.overdue).toBe(true)
    expect(d.rows[0]!.daysOverdue).toBe(1)
    expect(d.rows[0]!.deemedValuePaise).toBe(1_00_000_00)
    expect(d.rows[0]!.deemedTaxPaise).toBe(18_000_00)
    expect(d.overdue).toHaveLength(1)
  })

  it('starts from receipt by the job worker when the goods were sent to him direct', () => {
    // Explanation to section 143: goods sent directly to the job worker start the clock on the
    // date HE receives them.
    const direct = challan({ receivedByJobWorkerOn: '2025-05-01' })
    const d = deemedSupplies([direct], nothingBack, '2026-04-11')
    expect(d.rows[0]!.clockStartsOn).toBe('2025-05-01')
    expect(d.rows[0]!.dueBackBy).toBe('2026-05-01')
    expect(d.rows[0]!.overdue).toBe(false)
    // The deemed supply would still be dated the day the goods left.
    expect(deemedSupplies([direct], nothingBack, '2026-05-02').rows[0]!.deemedSupplyDate).toBe(
      '2025-04-10'
    )
  })
})

describe('the three-year clock on capital goods (section 143(4))', () => {
  const cg = challan({
    challanNumber: 'JW/CG1',
    goodsType: 'capital_goods',
    description: 'CNC fixture plate',
    qtyMilli: 1_000,
    taxableValuePaise: 5_00_000_00,
    gstRate: 18
  })

  it('is three years', () => {
    expect(CLOCK_YEARS.capital_goods).toBe(3)
  })

  it('is in time on the three-year boundary and late the day after', () => {
    const onBoundary = deemedSupplies([cg], [], '2028-04-10')
    expect(onBoundary.rows[0]!.dueBackBy).toBe('2028-04-10')
    expect(onBoundary.rows[0]!.overdue).toBe(false)

    const dayAfter = deemedSupplies([cg], [], '2028-04-11')
    expect(dayAfter.rows[0]!.overdue).toBe(true)
    expect(dayAfter.rows[0]!.deemedValuePaise).toBe(5_00_000_00)
    expect(dayAfter.rows[0]!.deemedTaxPaise).toBe(90_000_00)
  })

  it('has no clock at all for moulds, dies, jigs, fixtures and tools', () => {
    // Section 143(4) applies to "capital goods, other than moulds and dies, jigs and fixtures,
    // or tools" — those never become a deemed supply however long they stay out.
    const tool = challan({ ...cg, mouldsDiesJigsOrTools: true })
    const d = deemedSupplies([tool], [], '2040-01-01')
    expect(d.rows[0]!.exemptFromClock).toBe(true)
    expect(d.rows[0]!.dueBackBy).toBeNull()
    expect(d.rows[0]!.overdue).toBe(false)
    expect(d.rows[0]!.balanceMilli).toBe(1_000)
  })

  it('honours a Commissioner extension in place of the statutory date', () => {
    const extended = challan({ ...cg, extendedDueBackBy: '2030-04-10' })
    const d = deemedSupplies([extended], [], '2028-04-11')
    expect(d.rows[0]!.extended).toBe(true)
    expect(d.rows[0]!.dueBackBy).toBe('2030-04-10')
    expect(d.rows[0]!.overdue).toBe(false)
  })
})

describe('an unregistered job worker is reported, never dropped', () => {
  const c = challan({
    challanNumber: 'JW/UR1',
    jobWorkerGstin: null,
    jobWorkerStateCode: '29' // Karnataka — out of state, so IGST
  })

  it('keeps the row and reports the state in place of a GSTIN', () => {
    const form = buildItc04(H1, [c], [], OPTS)
    expect(form.table4).toHaveLength(1)
    expect(form.table4[0]!.jobWorkerGstin).toBeNull()
    expect(form.table4[0]!.unregisteredJobWorker).toBe(true)
    expect(form.table4[0]!.jobWorkerStateCode).toBe('29')
    expect(form.table4[0]!.supply).toBe('inter')
    expect(form.table4[0]!.tax.igst).toBe(18_000_00)
    expect(form.table4[0]!.tax.cgst).toBe(0)
  })

  it('still runs the section 143 clock against it', () => {
    const d = deemedSupplies([c], [], '2026-04-11', { principalStateCode: '27' })
    expect(d.rows[0]!.unregisteredJobWorker).toBe(true)
    expect(d.rows[0]!.overdue).toBe(true)
    expect(d.rows[0]!.breakup!.igst).toBe(18_000_00)
  })
})

describe('goods supplied directly from the job worker’s premises (section 143(1)(b))', () => {
  const c = challan()
  const r = ret({
    receiptChallanNumber: 'JWS/001',
    receiptChallanDate: '2025-08-20',
    qtyMilli: 100_000,
    disposition: 'supplied_from_job_worker_premises'
  })

  it('goes to Table 5C, not 5A', () => {
    const form = buildItc04(H1, [c], [r], OPTS)
    expect(form.table5C).toHaveLength(1)
    expect(form.table5A).toHaveLength(0)
    expect(form.totals.suppliedOutQtyMilli).toBe(100_000)
    expect(form.totals.receivedBackQtyMilli).toBe(0)
    expect(form.table5C[0]!.taxableValuePaise).toBe(1_00_000_00)
  })

  it('discharges the clock as fully as a physical return does', () => {
    const d = deemedSupplies([c], [r], '2030-01-01')
    expect(d.rows[0]!.balanceMilli).toBe(0)
    expect(d.rows[0]!.overdue).toBe(false)
  })
})

describe('goods moved on to another job worker', () => {
  const c = challan()
  const r = ret({
    receiptChallanNumber: 'JWT/001',
    receiptChallanDate: '2025-07-05',
    qtyMilli: 100_000,
    disposition: 'sent_to_other_job_worker'
  })

  it('goes to the other-job-worker table (5B) and clears the balance', () => {
    const form = buildItc04(H1, [c], [r], OPTS)
    expect(form.table5B).toHaveLength(1)
    expect(form.table5A).toHaveLength(0)
    expect(form.totals.sentOnwardQtyMilli).toBe(100_000)
    expect(form.deemed.rows[0]!.balanceMilli).toBe(0)
  })
})

describe('waste and scrap', () => {
  const c = challan()
  const returns = [
    ret({ qtyMilli: 95_000 }),
    ret({
      receiptChallanNumber: 'JWW/001',
      receiptChallanDate: '2025-06-15',
      qtyMilli: 5_000,
      disposition: 'waste_and_scrap'
    })
  ]

  it('is reported in 5A with losses and wastes, and totalled separately', () => {
    const form = buildItc04(H1, [c], returns, OPTS)
    expect(form.table5A).toHaveLength(2)
    expect(form.totals.receivedBackQtyMilli).toBe(95_000)
    expect(form.totals.wasteQtyMilli).toBe(5_000)
  })

  it('accounts for the quantity, so the challan is not left with a deemed supply', () => {
    const d = deemedSupplies([c], returns, '2030-01-01')
    expect(d.rows[0]!.accountedMilli).toBe(100_000)
    expect(d.rows[0]!.balanceMilli).toBe(0)
    expect(d.rows[0]!.overdue).toBe(false)
  })
})

describe('more coming back than went out is an error, never a negative balance', () => {
  const c = challan()
  const r = ret({ qtyMilli: 120_000 })

  it('clamps the balance at zero and raises an over-returned issue', () => {
    const d = deemedSupplies([c], [r], '2030-01-01')
    expect(d.rows[0]!.balanceMilli).toBe(0)
    expect(d.rows[0]!.balanceMilli).toBeGreaterThanOrEqual(0)
    expect(d.rows[0]!.overReturnedMilli).toBe(20_000)
    expect(d.issues.map((i) => i.code)).toEqual(['over-returned'])
    expect(d.issues[0]!.challanNumber).toBe('JW/001')
  })

  it('does not let the excess cancel a real deemed supply on another challan', () => {
    const other = challan({ challanNumber: 'JW/002' })
    const d = deemedSupplies([c, other], [r], '2026-04-11')
    expect(d.rows[1]!.balanceMilli).toBe(100_000)
    expect(d.rows[1]!.overdue).toBe(true)
    expect(d.totalDeemedValuePaise).toBe(1_00_000_00)
  })

  it('surfaces the same issue through the form', () => {
    const form = buildItc04(H1, [c], [r], OPTS)
    expect(form.issues.map((i) => i.code)).toContain('over-returned')
  })
})

describe('receipts that do not match a challan', () => {
  it('are reported rather than silently dropped', () => {
    const d = deemedSupplies([challan()], [ret({ originalChallanNumber: 'JW/999' })], '2025-12-31')
    expect(d.issues.map((i) => i.code)).toEqual(['unknown-challan'])
    // The real challan is untouched by the stray receipt.
    expect(d.rows[0]!.balanceMilli).toBe(100_000)
  })

  it('flags a receipt dated before the goods left', () => {
    const d = deemedSupplies(
      [challan()],
      [ret({ receiptChallanDate: '2025-04-01' })],
      '2025-12-31'
    )
    expect(d.issues.map((i) => i.code)).toContain('return-before-challan')
  })

  it('flags a unit the portal will not accept', () => {
    const d = deemedSupplies([challan({ uqc: 'pieces' })], [], '2025-12-31')
    expect(d.issues.map((i) => i.code)).toContain('invalid-uqc')
  })
})

describe('the form is period-bounded on both sides', () => {
  it('takes challans by challan date and receipts by receipt date', () => {
    const c = challan({ challanDate: '2025-09-25' })
    const r = ret({ receiptChallanDate: '2025-11-04', qtyMilli: 100_000 })
    const h1 = buildItc04(H1, [c], [r], OPTS)
    expect(h1.table4).toHaveLength(1)
    expect(h1.table5A).toHaveLength(0)

    const h2: Itc04Period = {
      from: '2025-10-01',
      to: '2026-03-31',
      label: 'Oct–Mar 2025-26',
      dueDate: '2026-04-25'
    }
    const secondHalf = buildItc04(h2, [c], [r], OPTS)
    expect(secondHalf.table4).toHaveLength(0)
    expect(secondHalf.table5A).toHaveLength(1)
    expect(secondHalf.nil).toBe(false)
  })
})

describe('itc04Periodicity — the ₹5 crore threshold (rule 45(3))', () => {
  const CURRENT = '2026-08-25'

  it('files half-yearly above ₹5 crore', () => {
    const o = itc04Periodicity(5 * CRORE + 1, CURRENT)
    expect(o.frequency).toBe('half-yearly')
    expect(o.thresholdPaise).toBe(5 * CRORE)
    expect(o.rule.effectiveFrom).toBe('2021-10-01')
  })

  it('files annually at exactly ₹5 crore — the rule reads "up to five crore rupees"', () => {
    expect(itc04Periodicity(5 * CRORE, CURRENT).frequency).toBe('annual')
  })

  it('files annually below ₹5 crore', () => {
    expect(itc04Periodicity(4_99_99_999_00, CURRENT).frequency).toBe('annual')
    expect(itc04Periodicity(0, CURRENT).frequency).toBe('annual')
  })

  it('still answers quarterly for a period before the 2021 amendment', () => {
    // A ₹10 crore principal filing for FY 2019-20 filed quarterly, and re-opening that period
    // must not restate it under today's rule.
    expect(itc04Periodicity(10 * CRORE, '2019-08-01').frequency).toBe('quarterly')
    expect(itc04Periodicity(1 * CRORE, '2019-08-01').frequency).toBe('quarterly')
  })
})

describe('itc04PeriodsForFy — due dates', () => {
  it('gives Apr–Sep due 25 October and Oct–Mar due 25 April', () => {
    const periods = itc04PeriodsForFy(2025, 'half-yearly')
    expect(periods).toHaveLength(2)
    expect(periods[0]!.from).toBe('2025-04-01')
    expect(periods[0]!.to).toBe('2025-09-30')
    expect(periods[0]!.dueDate).toBe('2025-10-25')
    expect(periods[1]!.from).toBe('2025-10-01')
    expect(periods[1]!.to).toBe('2026-03-31')
    expect(periods[1]!.dueDate).toBe('2026-04-25')
  })

  it('gives one annual period for the whole FY, due 25 April', () => {
    const periods = itc04PeriodsForFy(2025, 'annual')
    expect(periods).toHaveLength(1)
    expect(periods[0]!.from).toBe('2025-04-01')
    expect(periods[0]!.to).toBe('2026-03-31')
    expect(periods[0]!.dueDate).toBe('2026-04-25')
    expect(periods[0]!.label).toBe('FY 2025-26')
  })

  it('gives four quarters under the pre-2021 rule, each due the 25th after', () => {
    const periods = itc04PeriodsForFy(2019, 'quarterly')
    expect(periods.map((p) => p.dueDate)).toEqual([
      '2019-07-25',
      '2019-10-25',
      '2020-01-25',
      '2020-04-25'
    ])
    expect(periods[3]!.to).toBe('2020-03-31')
  })
})

describe('pro-rata value stays exact on large challans', () => {
  it('does not lose paise on a crore-rupee challan split by quantity', () => {
    // ₹10 crore over 99,000 units, a third of them unreturned. Value × quantity is 1e17 here,
    // past 2^53 — plain multiplication would drop whole paise. A third of ₹10,00,00,000 is
    // ₹3,33,33,333.33 and a third of a paise, which rounds down to the paise below.
    const big = challan({ qtyMilli: 99_000_000, taxableValuePaise: 10 * CRORE })
    const d = deemedSupplies([big], [ret({ qtyMilli: 66_000_000 })], '2026-04-11')
    expect(d.rows[0]!.balanceMilli).toBe(33_000_000)
    expect(d.rows[0]!.deemedValuePaise).toBe(3_33_33_333_33)
    expect(Number.isSafeInteger(d.rows[0]!.deemedValuePaise)).toBe(true)
    // 18% of that, again exact.
    expect(d.rows[0]!.deemedTaxPaise).toBe(60_00_000_00)
  })
})
