import { describe, it, expect } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import type { DB } from '../db/connection'
import {
  deleteChallan,
  deleteReturn,
  itc04,
  jobWorkClock,
  listChallans,
  nextChallanNumber,
  saveChallan,
  saveReturn,
  turnoverForPeriodicity,
  type ChallanInput
} from './jobWork'

/**
 * Job work, ITC-04, and the section 143 clock (roadmap D-89) — over the database.
 *
 * The arithmetic itself is proved in `src/shared/gst/itc04.test.ts`. What is proved here is the
 * join: that a row saved through this service reaches the engine with every field the clock
 * depends on, and that the two places where the service can produce a WRONG number rather than
 * merely an absent one — a negative balance from an over-return, and a moulds/dies challan whose
 * exclusion silently fails to carry — do not.
 *
 * The property under test throughout: a challan not accounted for within its year is a deemed
 * supply DATED THE DAY IT WENT OUT. Backdating is the whole sting of section 143 — the tax is not
 * due from the day the year ran out — so almost every assertion below checks the date as well as
 * the amount.
 */

const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

/** Books with a registered job worker in our own state, and one in another. */
function books(): { db: DB; local: number; outstation: number } {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const creditors = groupId('Sundry Creditors')
  const local = createLedger(db, {
    ...LEDGER_DEFAULTS,
    name: 'Sharma Polishing Works',
    groupId: creditors,
    gstin: '27AAAPS1234A1ZB',
    stateCode: '27'
  }).id
  const outstation = createLedger(db, {
    ...LEDGER_DEFAULTS,
    name: 'Gujarat Heat Treaters',
    groupId: creditors,
    gstin: '24AAACG1234A1ZK',
    stateCode: '24'
  }).id
  return { db, local, outstation }
}

/** 100 pieces worth ₹10,000, at 18%. Round numbers so the pro-rata split is readable. */
const SENT: Omit<ChallanInput, 'date'> = {
  goodsType: 'input',
  description: 'Brass castings',
  hsn: '7419',
  qtyMilli: 100_000,
  uqc: 'PCS',
  taxablePaise: 10_00_000,
  gstRate: 18
}

const send = (db: DB, over: Partial<ChallanInput> & { date: string }): ReturnType<typeof saveChallan> =>
  saveChallan(db, TEST_INFO, { ...SENT, ...over })

const withBand = (band: CompanyInfo['turnoverBand']): CompanyInfo => ({ ...TEST_INFO, turnoverBand: band })

// ---------------------------------------------------------------------------------------------

describe('sending goods out', () => {
  it('numbers itself in its own series, and the next one follows', () => {
    const { db } = books()
    expect(nextChallanNumber(db)).toBe('JW-0001')
    const c = send(db, { date: '2025-04-10' })
    expect(c.number).toBe('JW-0001')
    expect(nextChallanNumber(db)).toBe('JW-0002')
  })

  it('takes the job worker’s registration as at despatch, not as at today', () => {
    const { db, outstation } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: outstation })
    expect(c.jobWorkerGstin).toBe('24AAACG1234A1ZK')
    expect(c.jobWorkerStateCode).toBe('24')
    expect(c.jobWorkerName).toBe('Gujarat Heat Treaters')

    // The ledger re-registers somewhere else. The challan does not change its mind.
    db.prepare('UPDATE ledgers SET gstin = ?, state_code = ? WHERE id = ?').run('27ZZZZZ9999Z9Z9', '27', outstation)
    expect(listChallans(db, TEST_INFO)[0]!.jobWorkerGstin).toBe('24AAACG1234A1ZK')
  })

  it('refuses a challan with nothing on it', () => {
    const { db } = books()
    expect(() => send(db, { date: '2025-04-10', description: '   ' })).toThrow('needs a description')
    expect(() => send(db, { date: '2025-04-10', qtyMilli: 0 })).toThrow('positive quantity')
  })

  it('will not be edited down below what has already come back', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10' })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-05-01', qtyMilli: 60_000, disposition: 'returned' })
    expect(() =>
      saveChallan(db, TEST_INFO, { ...SENT, date: '2025-04-10', qtyMilli: 40_000 }, c.id)
    ).toThrow('already has 60 accounted for')
  })

  it('will not be deleted out from under its receipts', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10' })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-05-01', qtyMilli: 10_000, disposition: 'returned' })
    expect(() => deleteChallan(db, c.id, TEST_INFO)).toThrow('delete those first')
    deleteReturn(db, listChallans(db, TEST_INFO)[0]!.returns[0]!.id, TEST_INFO)
    deleteChallan(db, c.id, TEST_INFO)
    expect(listChallans(db, TEST_INFO)).toHaveLength(0)
  })
})

describe('the section 143 clock', () => {
  it('a fully returned challan is never a deemed supply, however long ago it was', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-01', qtyMilli: 100_000, disposition: 'returned' })

    const clock = jobWorkClock(db, TEST_INFO, '2030-01-01')
    const row = clock.rows[0]!
    expect(row.balanceMilli).toBe(0)
    expect(row.overdue).toBe(false)
    expect(row.deemedSupplyDate).toBeNull()
    expect(clock.overdue).toHaveLength(0)
    expect(clock.totalDeemedTaxPaise).toBe(0)
  })

  it('a partly returned challan is a partly deemed supply, pro rata on what did not come back', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-01', qtyMilli: 40_000, disposition: 'returned' })

    const row = jobWorkClock(db, TEST_INFO, '2026-06-01').rows[0]!
    expect(row.balanceMilli).toBe(60_000)
    expect(row.overdue).toBe(true)
    // 60 of 100 pieces, so 60% of ₹10,000.
    expect(row.deemedValuePaise).toBe(6_00_000)
    expect(row.deemedTaxPaise).toBe(1_08_000)
    // Same state, so it splits CGST/SGST rather than falling to IGST.
    expect(row.breakup).toMatchObject({ cgst: 54_000, sgst: 54_000, igst: 0 })
    // The sting: dated the day it went out, not the day the year ran out.
    expect(row.deemedSupplyDate).toBe('2025-04-10')
    expect(row.challanId).toBe(c.id)
    expect(row.jobWorkerName).toBe('Sharma Polishing Works')
  })

  it('an input challan is in time on its anniversary and late the day after', () => {
    const { db } = books()
    send(db, { date: '2025-04-10' })
    const on = (asOn: string): ReturnType<typeof jobWorkClock>['rows'][number] =>
      jobWorkClock(db, TEST_INFO, asOn).rows[0]!

    expect(on('2026-04-09').dueBackBy).toBe('2026-04-10')
    expect(on('2026-04-09').overdue).toBe(false)
    // // VERIFY (2026-08-25): the anniversary day itself counting as IN TIME is a reading of
    // // "within one year", not a departmental clarification (see itc04.ts). If CBIC treats the
    // // anniversary as late, this expectation is the one that flips first.
    expect(on('2026-04-10').overdue).toBe(false)
    expect(on('2026-04-11').overdue).toBe(true)
    expect(on('2026-04-11').daysOverdue).toBe(1)
    expect(on('2026-04-11').deemedSupplyDate).toBe('2025-04-10')
  })

  it('capital goods get three years, on the same anniversary boundary', () => {
    const { db } = books()
    send(db, { date: '2023-05-20', goodsType: 'capital_goods', description: 'CNC fixture plate' })
    const on = (asOn: string): ReturnType<typeof jobWorkClock>['rows'][number] =>
      jobWorkClock(db, TEST_INFO, asOn).rows[0]!

    expect(on('2026-05-20').dueBackBy).toBe('2026-05-20')
    expect(on('2026-05-20').overdue).toBe(false)
    // A year in, an input would long since have been deemed supplied. Capital goods are not.
    expect(on('2024-06-01').overdue).toBe(false)
    expect(on('2026-05-21').overdue).toBe(true)
    expect(on('2026-05-21').deemedSupplyDate).toBe('2023-05-20')
  })

  it('moulds, dies, jigs, fixtures and tools have no clock at all', () => {
    const { db } = books()
    send(db, {
      date: '2015-01-01',
      goodsType: 'capital_goods',
      description: 'Injection mould, part 44-B',
      mouldsDiesJigsTools: true
    })
    const row = jobWorkClock(db, TEST_INFO, '2099-12-31').rows[0]!
    expect(row.exemptFromClock).toBe(true)
    expect(row.dueBackBy).toBeNull()
    expect(row.overdue).toBe(false)
    expect(row.deemedValuePaise).toBe(0)
    expect(jobWorkClock(db, TEST_INFO, '2099-12-31').overdue).toHaveLength(0)
  })

  it('goods sent straight from the supplier start the clock on the job worker’s receipt', () => {
    const { db } = books()
    send(db, { date: '2025-04-10', receivedByJobWorkerOn: '2025-05-20' })
    const row = jobWorkClock(db, TEST_INFO, '2026-04-30').rows[0]!
    expect(row.clockStartsOn).toBe('2025-05-20')
    expect(row.dueBackBy).toBe('2026-05-20')
    expect(row.overdue).toBe(false)
    // But the deemed supply, when it comes, is still dated the despatch.
    expect(jobWorkClock(db, TEST_INFO, '2026-05-21').rows[0]!.deemedSupplyDate).toBe('2025-04-10')
  })

  it('a Commissioner’s extension moves the due date and says it was extended', () => {
    const { db } = books()
    send(db, { date: '2025-04-10', extendedDueBackBy: '2027-04-10' })
    const row = jobWorkClock(db, TEST_INFO, '2026-06-01').rows[0]!
    expect(row.extended).toBe(true)
    expect(row.dueBackBy).toBe('2027-04-10')
    expect(row.overdue).toBe(false)
  })

  it('an unregistered job worker is an ordinary row, reported by state', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: null })
    expect(c.jobWorkerGstin).toBeNull()
    // No GSTIN and no ledger: the form still needs a state, and ours is the honest default.
    expect(c.jobWorkerStateCode).toBe(TEST_INFO.stateCode)

    const row = jobWorkClock(db, TEST_INFO, '2026-06-01').rows[0]!
    expect(row.unregisteredJobWorker).toBe(true)
    expect(row.overdue).toBe(true)
    expect(row.deemedValuePaise).toBe(10_00_000)

    const form = itc04(db, TEST_INFO, { fyStartYear: 2025 }).form
    expect(form.table4[0]!.unregisteredJobWorker).toBe(true)
    expect(form.table4[0]!.jobWorkerStateCode).toBe('27')
  })

  it('an inter-state deemed supply is IGST', () => {
    const { db, outstation } = books()
    send(db, { date: '2025-04-10', jobWorkerLedgerId: outstation })
    const row = jobWorkClock(db, TEST_INFO, '2026-06-01').rows[0]!
    expect(row.breakup).toMatchObject({ igst: 1_80_000, cgst: 0, sgst: 0 })
  })
})

describe('what came back, and where else it went', () => {
  it('goods supplied straight from the job worker’s premises discharge the clock, in table 5C', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    saveReturn(db, TEST_INFO, {
      challanId: c.id,
      date: '2025-08-20',
      number: 'JWR-9',
      qtyMilli: 100_000,
      disposition: 'supplied_from_job_worker_premises'
    })
    expect(jobWorkClock(db, TEST_INFO, '2030-01-01').overdue).toHaveLength(0)

    const form = itc04(db, TEST_INFO, { fyStartYear: 2025 }).form
    expect(form.table5C).toHaveLength(1)
    expect(form.table5A).toHaveLength(0)
    expect(form.totals.suppliedOutQtyMilli).toBe(100_000)
    expect(form.table5C[0]!.taxableValuePaise).toBe(10_00_000)
  })

  it('waste and scrap sits in 5A but is totalled apart from the goods received back', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-01', qtyMilli: 92_000, disposition: 'returned' })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-01', qtyMilli: 8_000, disposition: 'waste_and_scrap' })

    const form = itc04(db, TEST_INFO, { fyStartYear: 2025 }).form
    expect(form.table5A).toHaveLength(2)
    expect(form.totals.receivedBackQtyMilli).toBe(92_000)
    expect(form.totals.wasteQtyMilli).toBe(8_000)
    // Waste discharges the balance — the scrap is not still sitting out there unaccounted for.
    expect(jobWorkClock(db, TEST_INFO, '2030-01-01').overdue).toHaveLength(0)
  })

  it('goods moved on to another job worker land in 5B, and stop the clock', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    saveReturn(db, TEST_INFO, {
      challanId: c.id, date: '2025-07-01', qtyMilli: 100_000, disposition: 'sent_to_other_job_worker'
    })
    const form = itc04(db, TEST_INFO, { fyStartYear: 2025 }).form
    // // VERIFY (2026-08-25): 5B may be a RECEIPT limb ("received back from a job worker other
    // // than the one the goods were sent to") rather than the despatch modelled here — see the
    // // marker on `Itc04.table5B`. If the notified form disagrees, this row moves table.
    expect(form.table5B).toHaveLength(1)
    expect(form.totals.sentOnwardQtyMilli).toBe(100_000)
    expect(jobWorkClock(db, TEST_INFO, '2030-01-01').overdue).toHaveLength(0)
  })

  it('refuses more coming back than went out, and never shows a negative balance', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10' })
    saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-01', qtyMilli: 70_000, disposition: 'returned' })
    expect(() =>
      saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-06-02', qtyMilli: 40_000, disposition: 'returned' })
    ).toThrow('more than went out')

    const after = listChallans(db, TEST_INFO)[0]!
    expect(after.accountedMilli).toBe(70_000)
    expect(after.balanceMilli).toBe(30_000)
    expect(jobWorkClock(db, TEST_INFO, '2026-06-01').rows[0]!.balanceMilli).toBe(30_000)
    expect(jobWorkClock(db, TEST_INFO, '2026-06-01').issues).toHaveLength(0)
  })

  it('refuses goods coming back before they went out', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10' })
    expect(() =>
      saveReturn(db, TEST_INFO, { challanId: c.id, date: '2025-04-09', qtyMilli: 1_000, disposition: 'returned' })
    ).toThrow('before')
  })

  it('a deleted receipt puts the quantity back out on challan', () => {
    const { db } = books()
    const c = send(db, { date: '2025-04-10' })
    const saved = saveReturn(db, TEST_INFO, {
      challanId: c.id, date: '2025-06-01', qtyMilli: 100_000, disposition: 'returned'
    })
    expect(saved.balanceMilli).toBe(0)
    const after = deleteReturn(db, saved.returns[0]!.id, TEST_INFO)
    expect(after.balanceMilli).toBe(100_000)
    expect(jobWorkClock(db, TEST_INFO, '2026-06-01').overdue).toHaveLength(1)
  })
})

describe('ITC-04', () => {
  it('a period with no challans at all is a nil return, not the absence of one', () => {
    const { db } = books()
    const working = itc04(db, TEST_INFO, { fyStartYear: 2025 })
    expect(working.form.nil).toBe(true)
    expect(working.form.table4).toEqual([])
    expect(working.form.table5A).toEqual([])
    expect(working.form.table5B).toEqual([])
    expect(working.form.table5C).toEqual([])
    expect(working.form.totals.challanCount).toBe(0)
    expect(working.form.totals.sentValuePaise).toBe(0)
    expect(working.form.deemed.overdue).toEqual([])
    expect(working.form.issues).toEqual([])
    // The obligation to file is unchanged by there being nothing to say.
    expect(working.obligation.frequency).toBe('annual')
    expect(working.form.period.dueDate).toBe('2026-04-25')
  })

  it('a challan out in one period and back in the next appears in both filings', () => {
    const { db, local } = books()
    const info = withBand('5Cr-10Cr') // half-yearly, so the FY has two periods
    const c = saveChallan(db, info, { ...SENT, date: '2025-09-20', jobWorkerLedgerId: local })
    saveReturn(db, info, { challanId: c.id, date: '2025-11-05', qtyMilli: 100_000, disposition: 'returned' })

    const h1 = itc04(db, info, { fyStartYear: 2025, periodIndex: 0 })
    expect(h1.form.period.label).toBe('Apr–Sep 2025')
    expect(h1.form.table4).toHaveLength(1)
    expect(h1.form.table5A).toHaveLength(0)

    const h2 = itc04(db, info, { fyStartYear: 2025, periodIndex: 1 })
    expect(h2.form.period.label).toBe('Oct–Mar 2025-26')
    expect(h2.form.table4).toHaveLength(0)
    expect(h2.form.table5A).toHaveLength(1)
    expect(h2.form.totals.receivedBackQtyMilli).toBe(100_000)
  })

  it('reads the clock at the period end, so a filing says what was overdue when it was filed', () => {
    const { db } = books()
    send(db, { date: '2025-04-10' })
    // FY 2025-26 ends 31 Mar 2026 — the year is not up yet.
    expect(itc04(db, TEST_INFO, { fyStartYear: 2025 }).form.deemed.overdue).toHaveLength(0)
    // FY 2026-27 ends 31 Mar 2027 — long past.
    const later = itc04(db, TEST_INFO, { fyStartYear: 2026 })
    expect(later.form.deemed.overdue).toHaveLength(1)
    expect(later.form.deemed.overdue[0]!.deemedSupplyDate).toBe('2025-04-10')
    // …and the challan itself is not in that year's table 4, which is the point of a clock that
    // is not scoped to the period.
    expect(later.form.table4).toHaveLength(0)
  })

  it('carries the row ids and the job worker names back with the form', () => {
    const { db, local } = books()
    const c = send(db, { date: '2025-04-10', jobWorkerLedgerId: local })
    const working = itc04(db, TEST_INFO, { fyStartYear: 2025 })
    expect(working.challanIds[c.number]).toBe(c.id)
    expect(working.jobWorkerNames[c.number]).toBe('Sharma Polishing Works')
  })

  it('clamps a period index past the end rather than throwing', () => {
    const { db } = books()
    const working = itc04(db, withBand('5Cr-10Cr'), { fyStartYear: 2025, periodIndex: 99 })
    expect(working.periodIndex).toBe(1)
    expect(working.periods).toHaveLength(2)
  })
})

describe('how often it has to be filed', () => {
  it('takes both branches of the ₹5 crore test from the declared band', () => {
    const { db } = books()
    const small = itc04(db, withBand('1.5Cr-5Cr'), { fyStartYear: 2025 })
    expect(small.obligation.frequency).toBe('annual')
    expect(small.periods).toHaveLength(1)
    expect(small.periods[0]!.dueDate).toBe('2026-04-25')
    expect(small.turnoverSource).toBe('declared-band')

    const big = itc04(db, withBand('5Cr-10Cr'), { fyStartYear: 2025 })
    expect(big.obligation.frequency).toBe('half-yearly')
    expect(big.periods.map((p) => p.dueDate)).toEqual(['2025-10-25', '2026-04-25'])
  })

  it('an exact figure the user gives overrides the band, and the test is strict', () => {
    const { db } = books()
    const info = withBand('1.5Cr-5Cr')
    const at = itc04(db, info, { fyStartYear: 2025, aggregateTurnoverPaise: 5_00_00_000_00 })
    expect(at.obligation.frequency).toBe('annual') // "up to five crore" files annually
    expect(at.turnoverSource).toBe('given')

    const over = itc04(db, info, { fyStartYear: 2025, aggregateTurnoverPaise: 5_00_00_000_01 })
    expect(over.obligation.frequency).toBe('half-yearly')
  })

  it('a band that straddles the line is resolved toward filing more often', () => {
    // '5Cr-10Cr' floors at exactly ₹5 crore, which is the one figure that would file annually.
    // A paisa is added so the ambiguity costs an afternoon rather than a late return.
    expect(turnoverForPeriodicity(withBand('5Cr-10Cr'))).toBe(5_00_00_000_01)
    expect(turnoverForPeriodicity(withBand(null))).toBe(0)
  })

  it('answers an old year under the law that was in force then, not today’s', () => {
    const { db } = books()
    // Before Notification 35/2021 everyone filed quarterly, whatever their turnover.
    // // VERIFY (2026-08-25): that notification's number and date were recalled rather than read
    // // from the gazette — see ITC04_PERIODICITY_HISTORY. The ₹5 crore split itself is confident.
    const old = itc04(db, withBand('upto-50L'), { fyStartYear: 2019 })
    expect(old.obligation.frequency).toBe('quarterly')
    expect(old.periods).toHaveLength(4)
    expect(old.periods[0]!.label).toBe('Q1 2019-20')
    expect(old.obligation.rule.effectiveFrom).toBe('2017-07-01')

    const now = itc04(db, withBand('upto-50L'), { fyStartYear: 2025 })
    expect(now.obligation.frequency).toBe('annual')
    expect(now.obligation.rule.effectiveFrom).toBe('2021-10-01')
  })
})
