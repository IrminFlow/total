// Scenario 29 — the fixed asset register, and the two depreciation schedules.
//
// The point of this feature is that the law asks for two different numbers and doing one and
// calling it depreciation is the mistake. So the assertions are mostly about the two schedules
// disagreeing in the ways they should, and agreeing about nothing they shouldn't.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('29-fixed-assets', async (h) => {
  await h.createDemoCompany()

  const blocks = await h.invoke('assets:blocks')
  assert(blocks.length > 5, 'the common income-tax blocks are seeded on first use')
  const plant = blocks.find((b) => b.name === 'Plant and machinery — general')
  const computers = blocks.find((b) => b.name === 'Computers and software')
  assert(plant.itRate === 15 && computers.itRate === 40, 'with their notified rates')

  // Seeding is idempotent: asking twice must not double the list.
  assert((await h.invoke('assets:blocks')).length === blocks.length, 'and seeding twice changes nothing')

  // ---- the register ----
  const lathe = await h.invoke('assets:save', {
    data: {
      name: 'Lathe', code: 'M-01', blockId: plant.id,
      purchaseDate: '2026-04-01', putToUseDate: '2026-04-01',
      cost: 10_00_000_00, residualValue: 50_000_00, usefulLifeMonths: 180, method: 'slm'
    }
  })
  assert(lathe.cost === 10_00_000_00, 'the asset is recorded')
  assert(lathe.bookValue === lathe.cost, 'and starts at its cost')
  assert(lathe.accumulated === 0, 'with nothing depreciated yet')

  // Schedule II caps the residual at 5% of cost rather than losing a filled-in form.
  const capped = await h.invoke('assets:save', {
    data: {
      name: 'Over-residual', blockId: plant.id, purchaseDate: '2026-04-01',
      cost: 1_00_000_00, residualValue: 50_000_00, usefulLifeMonths: 120
    }
  })
  assert(capped.residualValue === 5_000_00, `residual capped at 5% (${capped.residualValue})`)

  // A late computer: full days in the books, half rate in the return.
  const laptop = await h.invoke('assets:save', {
    data: {
      name: 'Laptop', blockId: computers.id,
      purchaseDate: '2027-01-15', putToUseDate: '2027-01-15',
      cost: 1_00_000_00, usefulLifeMonths: 36, method: 'wdv'
    }
  })

  let costRefused = false
  try {
    await h.invoke('assets:save', { data: { name: 'Free', purchaseDate: '2026-04-01', cost: 0, usefulLifeMonths: 12 } })
  } catch {
    costRefused = true
  }
  assert(costRefused, 'an asset with no cost is refused')

  // ---- the two schedules ----
  const { schedule, draft } = await h.invoke('assets:schedule', { fyStartYear: 2026 })
  assert(schedule.from === '2026-04-01' && schedule.to === '2027-03-31', 'the year runs April to March')
  assert(schedule.companiesAct.length === 3, 'every asset in use is in the books schedule')
  assert(schedule.companiesActTotal > 0 && schedule.incomeTaxTotal > 0, 'both schedules have something to say')
  assert(
    schedule.companiesActTotal !== schedule.incomeTaxTotal,
    'and they disagree, which is the entire point'
  )
  assert(
    schedule.difference === schedule.companiesActTotal - schedule.incomeTaxTotal,
    'the difference is stated for deferred tax'
  )

  const latheRow = schedule.companiesAct.find((r) => r.assetId === lathe.id)
  assert(latheRow.heldFraction === 1, 'an asset in use all year is held for all of it')
  assert(latheRow.depreciation === Math.floor(9_50_000_00 / 15), 'straight line is cost less residual over the life')
  assert(latheRow.closingWdv === latheRow.openingWdv - latheRow.depreciation, 'and closing follows from opening')

  const laptopRow = schedule.companiesAct.find((r) => r.assetId === laptop.id)
  assert(laptopRow.heldFraction < 0.3, 'a January asset is held for a fraction of the year in the books')

  const computerBlock = schedule.incomeTax.find((b) => b.blockName === computers.name)
  assert(computerBlock.additionsHalfRate === 1_00_000_00, 'and gets the half rate in the return')
  assert(computerBlock.depreciation === 20_000_00, `half of 40% on a lakh (${computerBlock.depreciation})`)

  const plantBlock = schedule.incomeTax.find((b) => b.blockName === plant.name)
  assert(plantBlock.additionsFullRate === 11_00_000_00, 'April assets get the full rate')
  assert(plantBlock.depreciation === 1_65_000_00, '15% of eleven lakh')

  for (const b of schedule.incomeTax) {
    assert(
      b.closingWdv === b.writtenDownBeforeDepreciation - b.depreciation,
      `${b.blockName}: the block foots`
    )
  }

  // ---- the draft posts nothing, and carries only the books' figure ----
  const before = (await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).length
  assert(draft.total === schedule.companiesActTotal, 'only the Companies Act figure goes in the books')
  assert(draft.lines.length === 2, 'one debit and one credit')
  assert(draft.lines[0].amount === draft.lines[1].amount, 'and it balances')
  assert(
    (await h.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).length === before,
    'asking for a schedule posted nothing'
  )

  await h.invoke('assets:postDepreciation', { fyStartYear: 2026, voucherId: null })
  const reread = await h.invoke('assets:schedule', { fyStartYear: 2026 })
  assert(reread.schedule.alreadyPosted, 'a posted year says so')

  let twice = false
  try {
    await h.invoke('assets:postDepreciation', { fyStartYear: 2026, voucherId: null })
  } catch {
    twice = true
  }
  assert(twice, 'and cannot be posted again')

  // Next year opens where this one closed, from what was posted rather than a recomputation.
  const year2 = await h.invoke('assets:schedule', { fyStartYear: 2027 })
  const latheYear2 = year2.schedule.companiesAct.find((r) => r.assetId === lathe.id)
  assert(latheYear2.openingWdv === latheRow.closingWdv, 'the opening value is last year\'s closing')

  // ---- disposal ----
  const disposal = await h.invoke('assets:disposalDraft', { assetId: lathe.id, on: '2027-09-30', proceeds: 11_00_000_00 })
  assert(disposal.bookValue > 0, 'the book value is what the register says')
  assert(disposal.profitOrLoss === 11_00_000_00 - disposal.bookValue, 'profit is proceeds less book value')
  assert(disposal.incomeTaxTreatment.includes('no gain or loss'), 'and the return does neither')
  const dr = disposal.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = disposal.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  assert(dr === cr, `the disposal journal balances (${dr} vs ${cr})`)

  await h.invoke('assets:dispose', { assetId: lathe.id, on: '2027-09-30', proceeds: 11_00_000_00 })
  assert(!(await h.invoke('assets:list', {})).some((a) => a.id === lathe.id), 'a sold asset leaves the register')
  assert(
    (await h.invoke('assets:list', { includeDisposed: true })).some((a) => a.id === lathe.id),
    'unless asked for'
  )

  const afterSale = await h.invoke('assets:schedule', { fyStartYear: 2027 })
  const sold = afterSale.schedule.companiesAct.find((r) => r.assetId === lathe.id)
  assert(sold.heldFraction < 1, 'it is depreciated up to the day it left, not for the whole year')
  assert(sold.heldFraction > 0.4, 'and for the half-year it was actually held')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.goto('assets')
  await h.page.waitForSelector('[data-testid="rows-assets"] tr', { timeout: 15000 })
  await h.shot('01-register')

  await h.click('tab-assets-schedule')
  await h.page.waitForSelector('[data-testid="rows-schedule-companies"] tr', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="rows-schedule-tax"] tr', { timeout: 15000 })
  await h.shot('02-schedule')
})
