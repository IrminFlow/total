// Scenario 28 — shelf life, item codes, alternate units and inherited tax.
//
// Four properties. A batch's value in the shelf-life report is the same money the balance sheet
// counts, not a second opinion about it. A batch with no expiry date is reported as a gap rather
// than as safe. An item's rate follows its group until the item says otherwise. And an alternate
// unit is stored as a pair or not at all, because half of one is a silent no-op.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('28-inventory-master', async (h) => {
  await h.createDemoCompany()

  const units = await h.invoke('master:units:list')
  const pcs = units[0]
  const box = units[1] ?? pcs

  // ---- tax inherited from the group ----
  const group = await h.invoke('master:stockGroups:create', { name: 'Packaged Food', gstRate: 5, hsn: '2106' })
  const inheriting = await h.invoke('master:stockItems:create', {
    name: 'Test Biscuit', unitId: pcs.id, groupId: group.id, code: 'TB100'
  })
  const inherited = await h.invoke('stock:effectiveTax', { stockItemId: inheriting.id })
  assert(inherited.gstRate === 5, `the item takes its group's rate (${inherited.gstRate})`)
  assert(inherited.hsn === '2106', 'and its HSN')
  assert(inherited.inherited.gstRate === true, 'and says the rate was inherited rather than stated')
  assert(inherited.fromGroup === 'Packaged Food', 'naming where it came from')

  const overriding = await h.invoke('master:stockItems:create', {
    name: 'Test Chocolate', unitId: pcs.id, groupId: group.id, gstRate: 18
  })
  const overridden = await h.invoke('stock:effectiveTax', { stockItemId: overriding.id })
  assert(overridden.gstRate === 18, 'an item can override its group')
  assert(overridden.inherited.gstRate === false, 'and that is reported as its own')
  assert(overridden.hsn === '2106', 'while the HSN it did not override still follows the group')

  // ---- finding an item the way a person at a counter would ----
  const found = await h.invoke('stock:find', { query: 'TB100' })
  assert(found && found.id === inheriting.id, 'an item is found by its code')
  assert((await h.invoke('stock:find', { query: 'tb100' })).id === inheriting.id, 'case does not matter')
  assert((await h.invoke('stock:find', { query: 'Test Biscuit' })).id === inheriting.id, 'and by exact name')
  assert((await h.invoke('stock:find', { query: 'no such thing' })) === null, 'and not otherwise')

  let duplicateRefused = false
  try {
    await h.invoke('master:stockItems:create', { name: 'Another', unitId: pcs.id, code: 'TB100' })
  } catch {
    duplicateRefused = true
  }
  assert(duplicateRefused, 'two items cannot share a code')

  // Any number of items may have no code at all — the unique index must not treat blanks as equal.
  await h.invoke('master:stockItems:create', { name: 'Uncoded One', unitId: pcs.id })
  await h.invoke('master:stockItems:create', { name: 'Uncoded Two', unitId: pcs.id })

  // ---- alternate units are stored as a pair or not at all ----
  const boxed = await h.invoke('master:stockItems:create', {
    name: 'Boxed Item', unitId: pcs.id, altUnitId: box.id, altConversionMilli: 12_000
  })
  assert(boxed.altUnitId === box.id && boxed.altConversionMilli === 12_000, 'both halves are stored')

  const halfPair = await h.invoke('master:stockItems:create', {
    name: 'Half Pair', unitId: pcs.id, altUnitId: box.id
  })
  assert(halfPair.altUnitId === null, 'a unit with no conversion is not stored — it would be a no-op')
  assert(halfPair.altConversionMilli === null, 'and neither is the other half')

  // ---- shelf life ----
  const asOn = '2027-03-31'
  const report = await h.invoke('stock:nearExpiry', { asOn })
  assert(report.summary.length === 5, 'every bucket is reported, so the table keeps its shape')
  assert(
    report.summary.map((s) => s.bucket).join(',') === 'expired,within30,within90,later,none',
    'worst first'
  )
  assert(
    report.summary.reduce((s, b) => s + b.value, 0) === report.rows.reduce((s, r) => s + r.value, 0),
    'the buckets foot to the rows'
  )
  for (let i = 1; i < report.rows.length; i++) {
    assert(
      report.rows[i - 1].daysToExpiry <= report.rows[i].daysToExpiry,
      'the soonest to die is listed first'
    )
  }
  for (const r of report.rows) {
    assert(r.closingQtyMilli > 0, `${r.batchName} is still on the shelf`)
    assert(Number.isInteger(r.value), `${r.batchName}'s value is integer paise`)
    assert(r.expiryDate !== null, 'every ranked row has a date; the undated are counted separately')
  }
  const atRisk = report.rows
    .filter((r) => r.bucket !== 'later')
    .reduce((s, r) => s + r.value, 0)
  assert(report.atRisk === atRisk, 'at-risk is expired plus the next ninety days, and nothing beyond')
  assert(report.undatedBatches >= 0 && report.undatedQtyMilli >= 0, 'undated batches are counted, not hidden')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.goto('stock-summary')
  await h.page.waitForSelector('[data-testid="rows-stock-summary"] tr', { timeout: 15000 })
  await h.shot('01-stock-summary')

  await h.goto('masters')
  await h.page.waitForSelector('[data-testid="input-item-code"], [data-testid="tab-masters-items"]', { timeout: 15000 })
  await h.shot('02-masters')
})
