// Scenario 35 — job work, the section 143 clock, and ITC-04 (roadmap D-89).
//
// The property this exists to prove: a challan whose goods have not come back within a year is a
// DEEMED SUPPLY, dated the day the goods went out — not the day the year ran out — and the screen
// says so in words a person can act on rather than by colouring a row.
//
// Dates are computed from today rather than hardcoded, because "a year ago" is the whole test and
// a fixed date would stop being a year ago.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

/** ISO date `days` before today, in UTC — the same calendar arithmetic the engine uses. */
function daysAgo(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

await scenario('38-job-work', async (h) => {
  await h.createDemoCompany()

  const ledgers = await h.invoke('master:ledgers:list')
  const jobWorker = ledgers.find((l) => l.groupName === 'Sundry Creditors') ?? ledgers[0]

  const sentOn = daysAgo(400) // comfortably past one year
  // The first day of whichever period the ITC-04 tab opens on, so the recent challan below is
  // guaranteed to appear in the Table 4 the screen actually shows. Computing it from the app
  // rather than from the calendar keeps the scenario honest in October as well as in May.
  const recentOn = (await h.invoke('jobWork:itc04', {})).form.period.from

  // ---- a challan the clock has run out on ----
  const stale = await h.invoke('jobWork:save', {
    data: {
      date: sentOn,
      jobWorkerLedgerId: jobWorker.id,
      goodsType: 'input',
      description: 'Brass castings',
      hsn: '7419',
      qtyMilli: 100_000,
      uqc: 'PCS',
      taxablePaise: 10_00_000,
      gstRate: 18
    }
  })
  assertEq(stale.number, 'JW-0001', 'the challan takes its own series')
  assertEq(stale.balanceMilli, 100_000, 'and all of it is out')

  // 40 of the 100 pieces come back. The rest is a PARTIAL deemed supply, not all-or-nothing.
  await h.invoke('jobWork:saveReturn', {
    data: { challanId: stale.id, date: daysAgo(380), qtyMilli: 40_000, disposition: 'returned' }
  })

  const clock = await h.invoke('jobWork:clock', {})
  assertEq(clock.overdue.length, 1, 'one challan has run out of time')
  const row = clock.overdue[0]
  assertEq(row.balanceMilli, 60_000, 'only what did not come back is deemed supplied')
  assertEq(row.deemedValuePaise, 6_00_000, 'valued pro rata — 60 of 100 pieces')
  assertEq(row.deemedTaxPaise, 1_08_000, '18% on that')
  // THE PROPERTY: backdated to the despatch, which is what makes the interest bite.
  assertEq(row.deemedSupplyDate, sentOn, 'the supply is deemed to have happened the day it went out')
  // The anniversary, not 365 days — same month and day, one year on (29 February clamps to the
  // 28th, which is the only case where the day can differ).
  assertEq(Number(row.dueBackBy.slice(0, 4)), Number(sentOn.slice(0, 4)) + 1, 'due back a year later')
  assertEq(row.dueBackBy.slice(5, 7), sentOn.slice(5, 7), 'in the same month')
  assert(row.dueBackBy < clock.asOn, 'which is in the past')
  assert(row.daysOverdue > 30, `overdue by real days (${row.daysOverdue})`)

  // ---- what cannot happen ----
  let overReturned = false
  try {
    await h.invoke('jobWork:saveReturn', {
      data: { challanId: stale.id, date: daysAgo(5), qtyMilli: 70_000, disposition: 'returned' }
    })
  } catch {
    overReturned = true
  }
  assert(overReturned, 'more coming back than went out is refused, not netted')
  assertEq(
    (await h.invoke('jobWork:get', { id: stale.id })).balanceMilli,
    60_000,
    'and the balance never goes negative'
  )

  // ---- a mould has no clock at all (s.143(4)) ----
  const mould = await h.invoke('jobWork:save', {
    data: {
      date: daysAgo(2000),
      jobWorkerLedgerId: jobWorker.id,
      goodsType: 'capital_goods',
      description: 'Injection mould 44-B',
      qtyMilli: 1000,
      uqc: 'NOS',
      taxablePaise: 5_00_000,
      gstRate: 18,
      mouldsDiesJigsTools: true
    }
  })
  const mouldRow = (await h.invoke('jobWork:clock', {})).rows.find((r) => r.challanNumber === mould.number)
  assertEq(mouldRow.dueBackBy, null, 'moulds, dies, jigs, fixtures and tools have no due date')
  assertEq(mouldRow.overdue, false, 'and are never a deemed supply, five years out or not')

  // ---- a recent challan, so this period's table 4 has something in it ----
  await h.invoke('jobWork:save', {
    data: {
      date: recentOn,
      goodsType: 'input',
      description: 'Steel blanks',
      qtyMilli: 20_000,
      uqc: 'PCS',
      taxablePaise: 2_00_000,
      gstRate: 18
    }
  })

  // ---- ITC-04, including the nil case ----
  const working = await h.invoke('jobWork:itc04', {})
  assert(working.periods.length >= 1, 'the FY has at least one filing period')
  assert(['annual', 'half-yearly', 'quarterly'].includes(working.obligation.frequency), 'with a frequency')
  assert(working.obligation.rule.note.length > 0, 'and the rule that decided it')

  const nil = await h.invoke('jobWork:itc04', { fyStartYear: 2009 })
  assertEq(nil.form.nil, true, 'a year with nothing in it is a nil return')
  assertEq(nil.form.table4.length, 0, 'with an empty table 4')
  assert(nil.form.period.dueDate.length === 10, 'and a due date all the same — it still has to be filed')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.goto('job-work')
  await h.page.waitForSelector('[data-testid="rows-jobwork-challans"] tr', { timeout: 15000 })

  const overdueRows = await h.page.$$('[data-testid="rows-jobwork-challans"] tr[data-overdue="true"]')
  assertEq(overdueRows.length, 1, 'the overdue challan is marked on its row')

  const callout = await h.page.textContent('[data-testid="panel-jobwork-overdue"]')
  assert(
    callout.includes('sold to the job worker on the day they were sent out'),
    'the liability is stated in words, not just in a colour'
  )
  assert(callout.includes('section 50(1)'), 'including that interest has been running')
  assert(
    callout.includes('not a departmental clarification'),
    'and the anniversary-boundary reading is surfaced where a user would rely on it'
  )
  await h.shot('01-register')

  await h.click('tab-jobwork-itc04')
  await h.page.waitForSelector('[data-testid="panel-itc04-obligation"]', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="rows-itc04-4"] tr', { timeout: 15000 })
  const periodicity = await h.page.textContent('[data-screen="job-work"]')
  assert(
    periodicity.includes('written from memory, not read from the gazette'),
    'the periodicity citation says how confident it is'
  )
  assert(
    periodicity.includes('Table 5B'),
    'and table 5B names itself, caveat and all'
  )
  await h.shot('02-itc04')
})
