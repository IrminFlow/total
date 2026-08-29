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

async function dismissToasts(page) {
  const buttons = page.locator('[role="status"] > div > button:first-child')
  while (await buttons.count()) await buttons.first().click()
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
  const chain = await h.invoke('jobWork:save', {
    data: {
      date: recentOn,
      jobWorkerLedgerId: jobWorker.id,
      jobWorkerIsSez: true,
      goodsType: 'input',
      description: 'Steel blanks',
      qtyMilli: 20_000,
      uqc: 'PCS',
      taxablePaise: 2_00_000,
      gstRate: 18,
      cessPaise: 1_234
    }
  })

  // ---- ITC-04, including the nil case ----
  const working = await h.invoke('jobWork:itc04', {})
  assert(working.periods.length >= 1, 'the FY has at least one filing period')
  assert(['annual', 'half-yearly', 'quarterly'].includes(working.obligation.frequency), 'with a frequency')
  assert(working.obligation.rule.note.length > 0, 'and the rule that decided it')

  const nil = await h.invoke('jobWork:itc04', { fyStartYear: 2009 })
  assertEq(nil.form.nil, true, 'a year with nothing in it is an empty working')
  assertEq(nil.form.table4.length, 0, 'with an empty table 4')
  assertEq(nil.form.portalFile.ready, false, 'and no portal-file claim')
  assert(
    nil.form.portalFile.blockers.some((b) => b.includes('cannot generate a nil JSON')),
    'because GSTN explicitly refuses a nil offline JSON'
  )
  assertEq(working.form.portalFile.offlineToolVersionShown, 'v2.15', 'the audited utility version is current')
  assertEq(working.form.portalFile.utilitySha256.length, 64, 'the official utility download is hash-pinned')

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
    callout.includes('General Clauses Act'),
    'and the anniversary boundary names its statutory construction source'
  )
  await h.shot('01-register')

  // ---- the full worker chain through the real UI ----
  const destination = ledgers.find((l) => l.id !== jobWorker.id)
  assert(destination, 'the demo company has a second ledger for the onward destination')
  await h.click(`btn-jobwork-receive-${chain.id}`)
  await h.page.getByTestId('select-jwreturn-disposition').selectOption('sent_to_other_job_worker')
  await h.page.getByTestId('select-jwreturn-destination-worker').selectOption(String(destination.id))
  await h.page.getByTestId('select-jwreturn-provenance').selectOption('fresh')
  await h.fill('input-jwreturn-number', 'ONWARD-UI-1')
  await h.fill('input-jwreturn-qty', '11')
  await h.fill('input-jwreturn-notes', 'Cutting and finishing')
  await h.shot('02-chain-modal')
  await h.click('btn-jwreturn-save')
  await h.page.waitForSelector(`[data-testid="btn-jobwork-receive-${chain.id}"]`, { timeout: 15000 })

  let chained = await h.invoke('jobWork:get', { id: chain.id })
  assertEq(chained.balanceMilli, 20_000, 'moving goods onward does not clear or restart the first clock')
  assertEq(chained.returns[0].destinationJobWorkerLedgerId, destination.id, 'the destination identity is durable')
  assertEq(chained.returns[0].onwardChallanProvenance, 'fresh', 'fresh-challan provenance is durable')
  assertEq(chained.returns[0].lossWasteQtyMilli, 0, 'an onward despatch does not invent a notified loss row')

  await h.click(`btn-jobwork-receive-${chain.id}`)
  await h.page.getByTestId('select-jwreturn-source-worker').selectOption(String(destination.id))
  await h.fill('input-jwreturn-number', 'BACK-UI-2')
  await h.fill('input-jwreturn-qty', '10')
  await h.fill('input-jwreturn-loss-qty', '1')
  await h.fill('input-jwreturn-loss-uqc', 'PCS')
  await h.fill('input-jwreturn-notes', 'Finished goods returned')
  await h.click('btn-jwreturn-save')
  chained = await h.invoke('jobWork:get', { id: chain.id })
  assertEq(chained.balanceMilli, 9_000, 'the destination worker can return only what the onward move gave him')
  const chainWorking = await h.invoke('jobWork:itc04', {})
  const differentWorker = chainWorking.form.table5B.find((r) => r.receiptChallanNumber === 'BACK-UI-2')
  assert(differentWorker, 'the actual different-worker return reaches Table 5B')
  assertEq(differentWorker.lossWasteQtyMilli, 1_000, 'the Table 5B row preserves its own loss/waste quantity')
  assertEq(
    differentWorker.jobWorkerGstin,
    chained.returns.find((r) => r.number === 'BACK-UI-2').sourceJobWorkerGstin,
    'Table 5B carries the durable returning-worker identity, not the first worker'
  )
  await dismissToasts(h.page)
  await h.shot('03-chain-register')

  await h.click('tab-jobwork-itc04')
  await h.page.waitForSelector('[data-testid="panel-itc04-obligation"]', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="rows-itc04-4"] tr', { timeout: 15000 })
  const periodicity = await h.page.textContent('[data-screen="job-work"]')
  assert(
    periodicity.includes('Notification 35/2021-Central Tax'),
    'the periodicity citation is pinned to the gazette notification'
  )
  assert(
    periodicity.includes('Table 5B — received back from a different job worker'),
    'and table 5B uses GSTN’s actual receipt heading'
  )
  assert(periodicity.includes('Portal JSON is disabled'), 'the screen does not claim an upload file')
  assert(periodicity.includes('cannot generate a nil JSON'), 'the nil limitation is visible')
  assert(periodicity.includes('v2.15'), 'the screen states the audited current utility version')
  assert(periodicity.includes('contradicts itself'), 'the official Table 5B contradiction is exposed')
  await dismissToasts(h.page)
  await h.shot('04-itc04')
})
