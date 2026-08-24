// Scenario 18 — the composition scheme end to end.
//
// Composition dealers used to reach a blocking GSTR-1 error and nothing else: the app told them
// they file CMP-08/GSTR-4 and then offered neither form. This asserts the whole path — the block
// still fires (a composition GSTR-1 would be rejected by the portal), CMP-08 computes turnover
// out of the same books, GSTR-4 rolls the quarters up without disagreeing with them, and the
// screen behind accelerator 4 actually renders figures rather than the not-applicable notice.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('18-composition', async (h) => {
  await h.createDemoCompany()

  // Switch the demo books onto the composition scheme the way a dealer would: through the
  // Company details form. Driving it over raw IPC would leave the renderer's cached company
  // info stale, so the screen under test would never see the change.
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-palette"]', 'company details')
  await h.page.keyboard.press('Enter')
  await h.waitScreen('company-info')
  await h.page.selectOption('[data-testid="select-registration-type"]', 'composition')
  await h.click('btn-company-info-save')
  // The save round-trips through the session store; wait for it rather than racing it.
  await h.page.waitForFunction(
    () => !!document.querySelector('[data-testid="select-registration-type"]')?.matches('select'),
    null,
    { timeout: 10000 }
  )

  const today = new Date()
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  const m = today.getMonth() + 1
  const q = Math.floor(((m - 4 + 12) % 12) / 3) + 1
  const qStartMonth = 4 + (q - 1) * 3
  const qStart = new Date(Date.UTC(fyStartYear, qStartMonth - 1, 1))
  const qEnd = new Date(Date.UTC(fyStartYear, qStartMonth + 2, 0))
  const iso = (d) => d.toISOString().slice(0, 10)

  // ---- GSTR-1 stays blocked, and says where to go instead ----
  const v = await h.invoke('gst:validate', { from: iso(qStart), to: iso(qEnd) })
  const block = v.issues.find((i) => i.code === 'composition')
  assert(block, 'GSTR-1 validation blocks a composition dealer')
  assert(block.severity === 'blocking', 'the composition issue is blocking, not a warning')
  assert(/CMP-08/.test(block.message), 'the block names the form they do file')

  // ---- CMP-08 computes off the demo book ----
  const cmp = await h.invoke('gst:cmp08', {
    from: iso(qStart), to: iso(qEnd), category: 'trader'
  })
  assert(cmp.ratePercent === 1, `trader rate is 1% (got ${cmp.ratePercent})`)
  assert(cmp.outwardTurnover > 0, `CMP-08 reads turnover from the books (got ${cmp.outwardTurnover})`)
  // The halves must re-add to the whole: a statement that does not foot gets rejected.
  const tax = Math.floor((cmp.outwardTurnover * cmp.ratePercent) / 100)
  assert(cmp.cgst + cmp.sgst === tax, `CGST+SGST foots to the tax on turnover (${cmp.cgst}+${cmp.sgst} vs ${tax})`)
  assert(
    cmp.totalPayable === cmp.cgst + cmp.sgst + cmp.reverseChargeTax + cmp.interest + cmp.lateFee,
    'total payable is the sum of its parts'
  )

  const restaurant = await h.invoke('gst:cmp08', { from: iso(qStart), to: iso(qEnd), category: 'restaurant' })
  assert(
    restaurant.cgst + restaurant.sgst > cmp.cgst + cmp.sgst,
    'a restaurant at 5% owes more than a trader at 1% on the same turnover'
  )

  // ---- GSTR-4 agrees with the quarters it presents ----
  const annual = await h.invoke('gst:gstr4', { fyStartYear, category: 'trader' })
  const summed = annual.quarters.reduce((t, x) => t + x.cmp08.outwardTurnover, 0)
  assert(annual.totalTurnover === summed, `annual turnover equals its quarters (${annual.totalTurnover} vs ${summed})`)
  assert(
    annual.quarters.length + annual.missingQuarters.length === 4,
    `every quarter is either present or reported missing (${annual.quarters.length}+${annual.missingQuarters.length})`
  )
  // Quarters that have not started must be named, not silently shown as filed-nil.
  assert(
    annual.quarters.some((x) => x.quarter === `Q${q}`),
    `the current quarter Q${q} is in the annual return`
  )

  // ---- the printed document is a bill of supply, not a tax invoice ----
  // A composition dealer may not collect tax and may not issue a tax invoice. Before this the
  // print said TAX INVOICE with nil CGST/SGST rows, which is a document they are barred from
  // issuing — so this asserts on the real rendered HTML, not on a helper.
  const invoices = await h.invoke('edoc:list', { from: iso(qStart), to: iso(qEnd) })
  assert(invoices.length > 0, 'the demo books have sales invoices in the quarter')
  const { html } = await h.invoke('invoice:previewHtml', {
    voucherId: invoices[0].voucherId ?? invoices[0].id
  })
  assert(/BILL OF SUPPLY/.test(html), 'the printed document is headed BILL OF SUPPLY')
  assert(!/TAX INVOICE/.test(html), 'it is not headed TAX INVOICE')
  assert(
    /Composition taxable person, not eligible to collect tax on supplies/.test(html),
    'it carries the rule 5(1)(f) declaration'
  )
  for (const tax of ['>CGST<', '>SGST<', '>IGST<']) {
    assert(!html.includes(tax), `no ${tax} column on a bill of supply`)
  }

  // ---- the screen behind accelerator 4 ----
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway')
  await h.page.keyboard.press('4')
  await h.waitScreen('composition')

  // The screen remembers its last tab across sessions, so select the one under test rather than
  // assuming a default — otherwise this scenario passes or fails depending on how it last ended.
  await h.page.click('[data-testid="tab-composition-cmp08"]')
  await h.page.waitForSelector('[data-testid="rows-cmp08"] tr', { timeout: 15000 })
  const rows = await h.page.$$eval('[data-testid="rows-cmp08"] tr', (els) => els.length)
  assert(rows >= 6, `CMP-08 renders its lines rather than the not-applicable notice (found ${rows})`)
  await h.shot('01-cmp08')

  // The category selector changes the rate on screen, which is the one number that decides the
  // whole liability — a dealer has to be able to see it.
  await h.page.selectOption('[data-testid="select-composition-category"]', 'service')
  await h.page.waitForFunction(
    () => /\b6%/.test(document.querySelector('[data-testid="rows-cmp08"]')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  await h.shot('02-service-rate')

  // GSTR-4 tab renders the quarters.
  await h.page.click('[data-testid="tab-composition-gstr4"]')
  await h.page.waitForSelector('[data-testid="rows-gstr4"] tr', { timeout: 15000 })
  const qRows = await h.page.$$eval('[data-testid="rows-gstr4"] tr', (els) => els.length)
  assert(qRows >= 2, `GSTR-4 renders a row per quarter plus the total (found ${qRows})`)
  await h.shot('03-gstr4')
})
