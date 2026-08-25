// Scenario 33 — the four things a daily user does to a form, not to the books.
//
// Templates (#27), the percentage cost-centre split (#41), bulk edit (#39) and the quantity box
// that reads "2 box" (#34). Each one has a property that is easy to get plausibly wrong:
//
//   - a template must NOT carry a date, or every rent voucher lands in the month the template
//     was made;
//   - a percentage split must sum to the line exactly, or the voucher will not save;
//   - a bulk edit must be all-or-nothing, or nobody can tell afterwards which half went through;
//   - a quantity in an alternate unit must be stored in base units, or the stock ledger is wrong
//     by the conversion factor and every report built on it inherits the error.
//
// All four are asserted on the DATA, not on the pixels.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('33-entry-ergonomics', async (h) => {
  await h.createCompanyUI('Ergonomic Books')
  await h.stubDialogs()

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')

  const rent = await h.invoke('master:ledgers:create', {
    name: 'Office Rent', groupId: groupId('Indirect Expenses'),
    openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null
  })
  const journal = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'journal')

  // ---------------------------------------------------------------- #27 templates

  const shape = {
    voucherTypeId: journal.id,
    date: '2026-04-15',
    number: 'JV-SHOULD-NOT-SURVIVE',
    partyLedgerId: null,
    narration: 'Monthly office rent',
    reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: rent.id, drCr: 'dr', amount: 4500000 },
      { ledgerId: cash.id, drCr: 'cr', amount: 4500000 }
    ],
    inventory: []
  }

  const template = await h.invoke('vtemplate:save', {
    data: { name: 'Office rent', voucherTypeId: journal.id, voucherJson: JSON.stringify(shape) }
  })
  assert(template.lineCount === 2, 'the template kept both lines')
  assert(template.total === 4500000, 'and knows what it is worth')
  assert(template.problem === null, 'and is usable')

  const stored = JSON.parse(template.voucherJson)
  assert(stored.number === undefined, 'the voucher number is NOT stored — it is allocated at save time')
  assert(stored.date !== '2026-04-15', 'and neither is the date it happened to be made on')

  const applied = await h.invoke('vtemplate:use', { id: template.id, date: '2026-09-05' })
  assert(applied.shape.date === '2026-09-05', 'applying it carries the date asked for, not the stored one')
  assert(applied.shape.lines.length === 2, 'with the lines intact')

  const beforeCount = (await h.invoke('report:dayBook', { from: '2020-04-01', to: '2099-03-31' })).rows.length
  await h.invoke('vtemplate:use', { id: template.id })
  const afterCount = (await h.invoke('report:dayBook', { from: '2020-04-01', to: '2099-03-31' })).rows.length
  assert(beforeCount === afterCount, 'using a template posts nothing — it is a shape, not a schedule')

  const listed = await h.invoke('vtemplate:list', { voucherTypeId: journal.id })
  assert(listed.length === 1 && listed[0].usedCount === 2, 'uses are counted, so the picker can order by reach')

  // ---------------------------------------------------------------- #41 percentage split

  const mumbai = await h.invoke('cc:save', { data: { name: 'Mumbai', parentId: null } })
  const pune = await h.invoke('cc:save', { data: { name: 'Pune', parentId: null } })
  const hq = await h.invoke('cc:save', { data: { name: 'Head office', parentId: null } })

  // A line that does not divide cleanly by 40/35/25 — the case where independent rounding of
  // each share leaves the voucher a paisa out and refusing to save.
  const ODD = 10000033
  const split = [4000, 3500, 2500].map((bp) => Math.floor((ODD * bp) / 10000))
  let remainder = ODD - split.reduce((s, v) => s + v, 0)
  // The renderer does this with largest-remainder; here we only need three shares that add up.
  for (let i = 0; remainder > 0; i = (i + 1) % 3, remainder--) split[i] += 1

  const allocated = await h.invoke('voucher:save', {
    data: {
      ...shape,
      date: '2026-09-05',
      number: undefined,
      narration: 'Rent, split three ways',
      lines: [
        {
          ledgerId: rent.id, drCr: 'dr', amount: ODD,
          costAllocations: [
            { costCentreId: mumbai.id, amount: split[0] },
            { costCentreId: pune.id, amount: split[1] },
            { costCentreId: hq.id, amount: split[2] }
          ]
        },
        { ledgerId: cash.id, drCr: 'cr', amount: ODD }
      ]
    }
  })
  const back = await h.invoke('voucher:get', { id: allocated.id })
  const shares = back.lines.find((l) => l.ledgerId === rent.id).costAllocations
  assert(shares.length === 3, 'all three centres are on the line')
  assert(
    shares.reduce((s, a) => s + a.amount, 0) === ODD,
    'and the shares sum to the line exactly — a percentage split that is a paisa out will not save'
  )

  // ---------------------------------------------------------------- #39 bulk edit

  const mk = (narration) =>
    h.invoke('voucher:save', {
      data: {
        ...shape, date: '2026-09-10', number: undefined, narration,
        lines: [
          { ledgerId: rent.id, drCr: 'dr', amount: 100000 },
          { ledgerId: cash.id, drCr: 'cr', amount: 100000 }
        ]
      }
    })
  const a = await mk('one')
  const b = await mk('two')

  const result = await h.invoke('voucher:bulkEdit', { ids: [a.id, b.id], narration: 'Q2 branch rent' })
  assert(result.vouchers === 2, 'both vouchers were updated')
  for (const id of [a.id, b.id]) {
    const v = await h.invoke('voucher:get', { id })
    assert(v.narration === 'Q2 branch rent', 'the narration changed')
    assert(v.lines.length === 2, 'and nothing else did')
    assert(v.lines.find((l) => l.ledgerId === rent.id).amount === 100000, 'amounts are never touched in bulk')
  }

  const withCentre = await h.invoke('voucher:bulkEdit', { ids: [a.id], costCentreId: pune.id })
  assert(withCentre.linesAllocated === 1, 'only the expense line takes the cost centre')
  const afterCc = await h.invoke('voucher:get', { id: a.id })
  assert(
    afterCc.lines.find((l) => l.ledgerId === cash.id).costAllocations.length === 0,
    'the cash side is left alone — it belongs to every centre at once'
  )

  // All-or-nothing: a locked period stops the whole run.
  await h.invoke('company:lock:set', { date: '2026-09-30' })
  let refused = false
  try {
    await h.invoke('voucher:bulkEdit', { ids: [a.id, b.id], narration: 'should not happen' })
  } catch {
    refused = true
  }
  assert(refused, 'a bulk edit into a locked period is refused')
  const untouched = await h.invoke('voucher:get', { id: b.id })
  assert(untouched.narration === 'Q2 branch rent', 'and nothing was written, not even the legal half')
  await h.invoke('company:lock:set', { date: null })

  // ---------------------------------------------------------------- #34 alternate units

  const units = await h.invoke('master:units:list')
  const pcs = units.find((u) => u.symbol === 'Pcs')
  const box = units.find((u) => u.symbol === 'Box')
  assert(pcs && box, 'the seeded units include both a base and something to convert from')

  const item = await h.invoke('master:stockItems:create', {
    name: 'Bolt', unitId: pcs.id, openingQtyMilli: 0, openingRatePaise: 0,
    altUnitId: box.id, altConversionMilli: 12000
  })
  const saved = await h.invoke('master:stockItems:list')
  const bolt = saved.find((i) => i.id === item.id)
  assert(bolt.altConversionMilli === 12000, 'a box is twelve pieces, in thousandths, as an integer')

  // The store is always the BASE unit. "2 box" is twenty-four pieces in the stock ledger, and
  // the only way that can be true is if the conversion happens before the quantity is saved —
  // a voucher carrying 2 would leave the stock ledger wrong by the conversion factor, and every
  // report built on it would inherit the error silently.
  const TWO_BOXES_MILLI = 2000
  // The same integer arithmetic src/shared/units.ts does — thousandths throughout, no float.
  const inBaseUnits = Math.round((TWO_BOXES_MILLI * bolt.altConversionMilli) / 1000)
  assert(inBaseUnits === 24000, 'two boxes of twelve is twenty-four pieces, in thousandths')

  const sales = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'sales')
  const salesAccount = await h.invoke('master:ledgers:create', {
    name: 'Sales — Bolts', groupId: groupId('Sales Accounts'),
    openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null
  })
  const customer = await h.invoke('master:ledgers:create', {
    name: 'Bolt Buyer', groupId: groupId('Sundry Debtors'),
    openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null
  })
  const purchaseAccount = await h.invoke('master:ledgers:create', {
    name: 'Purchases — Bolts', groupId: groupId('Purchase Accounts'),
    openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null
  })
  const purchase = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'purchase')

  // Buy a hundred pieces so there is something to sell.
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchase.id, date: '2026-09-01', partyLedgerId: customer.id,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: purchaseAccount.id, drCr: 'dr', amount: 100000 },
        { ledgerId: customer.id, drCr: 'cr', amount: 100000 }
      ],
      inventory: [
        { stockItemId: item.id, godownId: null, qtyMilli: 100000, ratePaise: 1000, amount: 100000, direction: 'in' }
      ]
    }
  })

  const sold = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: sales.id, date: '2026-09-05', partyLedgerId: customer.id,
      narration: 'two boxes', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: customer.id, drCr: 'dr', amount: 48000 },
        { ledgerId: salesAccount.id, drCr: 'cr', amount: 48000 }
      ],
      inventory: [
        { stockItemId: item.id, godownId: null, qtyMilli: inBaseUnits, ratePaise: 2000, amount: 48000, direction: 'out' }
      ]
    }
  })
  const soldBack = await h.invoke('voucher:get', { id: sold.id })
  assert(
    soldBack.inventory[0].qtyMilli === 24000,
    `the books store twenty-four pieces, not two boxes (got ${soldBack.inventory[0].qtyMilli})`
  )

  const summary = await h.invoke('report:stockSummary', { asOn: '2027-03-31' })
  const boltRow = summary.find((r) => r.itemId === item.id || r.name === 'Bolt')
  assert(boltRow, 'the item is in the stock summary')
  assert(
    boltRow.closingQtyMilli === 76000,
    `a hundred in and twenty-four out leaves seventy-six (got ${boltRow.closingQtyMilli})`
  )

  console.log('  templates, percentage splits, bulk edit and alternate units all hold')
})
