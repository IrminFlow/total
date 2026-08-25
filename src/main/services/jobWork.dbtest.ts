import { describe, it, expect } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createGodown, createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { stockByGodown } from './stockAnalysis'
import type { DrCr } from '@shared/domain'
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

// ---------------------------------------------------------------------------------------------
// The stock half (roadmap E #127, merged onto this service)
// ---------------------------------------------------------------------------------------------

/**
 * Books with something actually on the shelf.
 *
 * 200 castings bought for ₹20,000 — so the cost is a round ₹100 each and every valuation figure
 * below can be read without a calculator.
 */
function stockedBooks(): {
  db: DB
  local: number
  outstation: number
  castings: number
  otherGodown: number
  buy: (qtyMilli: number, amount: number, date: string, godownId?: number | null) => void
} {
  const b = books()
  const { db } = b
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
  const supplier = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Metal Supplies', groupId: groupId('Sundry Creditors') }).id
  const castings = createStockItem(db, {
    name: 'Brass castings', unitId, groupId: null, hsn: '7419', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
  }).id
  const otherGodown = createGodown(db, { name: 'Main Godown' }).id

  const buy = (qtyMilli: number, amount: number, date: string, godownId: number | null = null): void => {
    saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: supplier, posOverride: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr' as DrCr, amount, costAllocations: [] },
        { ledgerId: supplier, drCr: 'cr' as DrCr, amount, costAllocations: [] }
      ],
      inventory: [{
        stockItemId: castings, godownId, batchId: null, qtyMilli,
        ratePaise: Math.round((amount * 1000) / qtyMilli), discountPaise: 0, amount,
        direction: 'in', isAbsolute: false
      }],
      billRefs: [], tds: null
    })
  }
  buy(200_000, 20_00_000, '2026-01-01')

  return { ...b, castings, otherGodown, buy }
}

/** Closing quantity of the castings in one godown (null = unallocated), as at a date. */
const heldIn = (db: DB, itemId: number, asOn: string, godownName: string | null): number =>
  stockByGodown(db, asOn)
    .filter((r) => r.stockItemId === itemId && (godownName === null ? r.godownName === '' : r.godownName === godownName))
    .reduce((t, r) => t + r.closingQtyMilli, 0)

/** Company-wide closing quantity and value, the figures that reach the balance sheet. */
function closingStock(db: DB, itemId: number, asOn: string): { qtyMilli: number; value: number } {
  const rows = stockByGodown(db, asOn).filter((r) => r.stockItemId === itemId)
  return {
    qtyMilli: rows.reduce((t, r) => t + r.closingQtyMilli, 0),
    value: rows.reduce((t, r) => t + r.closingValue, 0)
  }
}

const JOB_GODOWN = 'Job work — Sharma Polishing Works'

describe('the goods actually move', () => {
  it('puts them in a godown named for the job worker, and leaves them in closing stock', () => {
    // This is the whole reason the merge grafted #127 onto this service. Goods at a job worker are
    // still the principal's stock: they belong in his CLOSING STOCK, which is a figure that goes
    // on the balance sheet, and they belong at the job worker's rather than on our own shelf.
    const b = stockedBooks()
    const before = closingStock(b.db, b.castings, '2026-02-28')
    expect(before).toEqual({ qtyMilli: 200_000, value: 20_00_000 })

    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })

    expect(challan.godownName).toBe(JOB_GODOWN)
    expect(challan.voucherId).not.toBeNull()
    expect(heldIn(b.db, b.castings, '2026-02-28', JOB_GODOWN)).toBe(60_000)
    expect(heldIn(b.db, b.castings, '2026-02-28', null)).toBe(140_000)

    // And the company-wide figure has not moved at all — neither quantity nor value. A transfer
    // that changed the valuation would be a transfer that quietly rewrote the balance sheet.
    expect(closingStock(b.db, b.castings, '2026-02-28')).toEqual(before)
  })

  it('does it with a stock journal that has no ledger lines at all', () => {
    // Sending goods for job work is not a supply (section 143). One ledger line here would put a
    // despatch into the trial balance as though something had been bought or sold.
    const b = stockedBooks()
    const linesBefore = (b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }).n
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    const linesAfter = (b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }).n
    expect(linesAfter).toBe(linesBefore)

    const kind = b.db
      .prepare('SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?')
      .get(challan.voucherId) as { kind: string }
    expect(kind.kind).toBe('stock_journal')

    const inv = b.db
      .prepare('SELECT direction, godown_id AS godownId, amount FROM inventory_lines WHERE voucher_id = ?')
      .all(challan.voucherId) as { direction: string; godownId: number | null; amount: number }[]
    expect(inv).toHaveLength(2)
    expect(inv.find((l) => l.direction === 'out')!.godownId).toBeNull()
    expect(inv.find((l) => l.direction === 'in')!.godownId).toBe(challan.godownId)
    // Both legs at the same value, which is what makes the pair cancel.
    expect(inv[0]!.amount).toBe(inv[1]!.amount)
  })

  it('takes them from the godown they were standing in, when one is named', () => {
    const b = stockedBooks()
    b.buy(50_000, 5_00_000, '2026-01-10', b.otherGodown)
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 30_000,
      fromGodownId: b.otherGodown
    })
    expect(challan.fromGodownId).toBe(b.otherGodown)
    const out = b.db
      .prepare("SELECT godown_id AS godownId FROM inventory_lines WHERE voucher_id = ? AND direction = 'out'")
      .get(challan.voucherId) as { godownId: number | null }
    expect(out.godownId).toBe(b.otherGodown)
    expect(heldIn(b.db, b.castings, '2026-02-28', 'Main Godown')).toBe(20_000)
    expect(heldIn(b.db, b.castings, '2026-02-28', JOB_GODOWN)).toBe(30_000)
  })

  it('brings them home again when they come back', () => {
    const b = stockedBooks()
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    const after = saveReturn(b.db, TEST_INFO, {
      challanId: challan.id, date: '2026-03-01', qtyMilli: 60_000, disposition: 'returned'
    })
    expect(after.balanceMilli).toBe(0)
    expect(after.returns[0]!.voucherId).not.toBeNull()
    expect(heldIn(b.db, b.castings, '2026-03-31', JOB_GODOWN)).toBe(0)
    expect(heldIn(b.db, b.castings, '2026-03-31', null)).toBe(200_000)
    expect(closingStock(b.db, b.castings, '2026-03-31')).toEqual({ qtyMilli: 200_000, value: 20_00_000 })
  })

  it('waste leaves the job worker and does NOT come back into stock', () => {
    // Section 143(5): waste and scrap generated at the job worker's premises may be supplied by
    // him directly. Bringing it back would inflate closing stock by the scrap of every job the
    // business has ever sent out — and the scrap is not there to count.
    const b = stockedBooks()
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    saveReturn(b.db, TEST_INFO, {
      challanId: challan.id, date: '2026-03-01', qtyMilli: 57_000, disposition: 'returned'
    })
    const after = saveReturn(b.db, TEST_INFO, {
      challanId: challan.id, date: '2026-03-01', qtyMilli: 3_000, disposition: 'waste_and_scrap'
    })
    expect(after.balanceMilli).toBe(0)

    const waste = after.returns.find((r) => r.disposition === 'waste_and_scrap')!
    const legs = b.db
      .prepare('SELECT direction FROM inventory_lines WHERE voucher_id = ?')
      .all(waste.voucherId) as { direction: string }[]
    expect(legs).toHaveLength(1)
    expect(legs[0]!.direction).toBe('out')

    // The job worker is holding nothing, and the company is 3 pieces lighter than it started.
    expect(heldIn(b.db, b.castings, '2026-03-31', JOB_GODOWN)).toBe(0)
    expect(closingStock(b.db, b.castings, '2026-03-31').qtyMilli).toBe(197_000)
  })

  it('leaves a paperwork-only challan exactly as it was — no godown, no voucher, no movement', () => {
    // The form has always allowed describing something that is not in the item master. Inventing
    // an item to move would be worse than moving nothing.
    const b = stockedBooks()
    const challan = send(b.db, { date: '2026-02-01', jobWorkerLedgerId: b.local })
    expect(challan.stockItemId).toBeNull()
    expect(challan.godownId).toBeNull()
    expect(challan.voucherId).toBeNull()
    expect(closingStock(b.db, b.castings, '2026-02-28')).toEqual({ qtyMilli: 200_000, value: 20_00_000 })
  })

  it('reuses a job worker godown that already exists rather than making a second one', () => {
    const b = stockedBooks()
    createGodown(b.db, { name: JOB_GODOWN })
    send(b.db, { date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 10_000 })
    send(b.db, { date: '2026-02-05', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 10_000 })
    const n = b.db.prepare("SELECT COUNT(*) AS n FROM godowns WHERE name LIKE 'Job work%'").get() as { n: number }
    expect(n.n).toBe(1)
    expect(heldIn(b.db, b.castings, '2026-02-28', JOB_GODOWN)).toBe(20_000)
  })

  it('gives each job worker his own godown, so "what is lying with whom" has an answer', () => {
    const b = stockedBooks()
    send(b.db, { date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 10_000 })
    send(b.db, { date: '2026-02-01', jobWorkerLedgerId: b.outstation, stockItemId: b.castings, qtyMilli: 25_000 })
    expect(heldIn(b.db, b.castings, '2026-02-28', JOB_GODOWN)).toBe(10_000)
    expect(heldIn(b.db, b.castings, '2026-02-28', 'Job work — Gujarat Heat Treaters')).toBe(25_000)
  })

  it('re-posts the movement when the challan is edited, instead of moving the goods twice', () => {
    const b = stockedBooks()
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    const edited = saveChallan(
      b.db, TEST_INFO,
      { ...SENT, date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 40_000 },
      challan.id
    )
    expect(edited.voucherId).toBe(challan.voucherId)
    expect(heldIn(b.db, b.castings, '2026-02-28', JOB_GODOWN)).toBe(40_000)
    expect(closingStock(b.db, b.castings, '2026-02-28').qtyMilli).toBe(200_000)
  })

  it('withdraws the movement when the challan or the receipt is deleted', () => {
    const b = stockedBooks()
    const challan = send(b.db, {
      date: '2026-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    const withReturn = saveReturn(b.db, TEST_INFO, {
      challanId: challan.id, date: '2026-03-01', qtyMilli: 20_000, disposition: 'returned'
    })
    deleteReturn(b.db, withReturn.returns[0]!.id, TEST_INFO)
    // The goods are back out with the job worker.
    expect(heldIn(b.db, b.castings, '2026-03-31', JOB_GODOWN)).toBe(60_000)

    deleteChallan(b.db, challan.id, TEST_INFO)
    expect(heldIn(b.db, b.castings, '2026-03-31', JOB_GODOWN)).toBe(0)
    expect(heldIn(b.db, b.castings, '2026-03-31', null)).toBe(200_000)
    // Binned, not purged: a movement is recoverable like any other voucher.
    const binned = b.db.prepare('SELECT deleted_at AS d FROM vouchers WHERE id = ?').get(challan.voucherId) as
      | { d: string | null }
      | undefined
    expect(binned!.d).not.toBeNull()
  })

  it('the clock and ITC-04 still read the same rows the stock moved on', () => {
    // The point of keeping ONE implementation: the return, the clock and the movement are three
    // views of one challan and cannot disagree about what went out.
    const b = stockedBooks()
    send(b.db, {
      date: '2025-02-01', jobWorkerLedgerId: b.local, stockItemId: b.castings, qtyMilli: 60_000
    })
    const clock = jobWorkClock(b.db, TEST_INFO, '2026-06-01')
    expect(clock.overdue).toHaveLength(1)
    expect(clock.overdue[0]!.deemedSupplyDate).toBe('2025-02-01')
    expect(heldIn(b.db, b.castings, '2026-06-01', JOB_GODOWN)).toBe(60_000)

    const working = itc04(b.db, TEST_INFO, { fyStartYear: 2024 })
    expect(working.form.table4).toHaveLength(1)
  })
})
