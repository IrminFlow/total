// Scenario 42 — the purchase order, the receipt note, and the balance between them (#188/#189).
//
// The property under test is not that the documents exist. It is that an order is a BALANCE: an
// order received in three parts stays open with the remainder pending, an over-delivery is
// recorded rather than clipped, goods that arrive with no order say so, and a bill for more than
// arrived is flagged by the three-way match before it is paid.
//
// Everything goes through the same IPC handlers the screen calls, and then the screen itself is
// driven to check that the balance is what a person actually sees.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const iso = (d) => d.toISOString().slice(0, 10)
const today = iso(new Date())

await scenario('44-purchase-chain', async (h) => {
  await h.createCompanyUI('Fasteners Books')

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id

  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Fasteners Ltd', groupId: groupId('Sundry Creditors'), openingBalance: 0, stateCode: '27'
  })
  const purchases = await h.invoke('master:ledgers:create', {
    name: 'Purchases', groupId: groupId('Purchase Accounts'), openingBalance: 0
  })
  const units = await h.invoke('master:units:list')
  const bolt = await h.invoke('master:stockItems:create', {
    name: 'Bolt', unitId: units[0].id, hsn: '7318', gstRate: 18
  })

  // ---- the order ----
  const po = await h.invoke('salesdoc:save', {
    data: {
      stage: 'order',
      side: 'purchase',
      date: today,
      partyLedgerId: supplier.id,
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 90000, ratePaise: 1000 }]
    }
  })
  assertEq(po.number, 'PO-0001', 'the purchase order has its own series')
  assertEq(po.stageLabel, 'Purchase order', 'and its own name')
  assertEq(po.fulfilment.state, 'none', 'nothing has arrived yet')

  // A purchase document addressed to a name rather than a ledger is refused: the bill that
  // follows has to land somewhere.
  const nameOnly = await h.invoke('salesdoc:save', {
    data: {
      stage: 'order', side: 'purchase', date: today, partyName: 'Somebody who rang up',
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 1000, ratePaise: 1000 }]
    }
  }).then(() => null, (err) => err)
  assert(nameOnly && /supplier ledger/.test(String(nameOnly)), 'a purchase order needs a supplier ledger')

  // ---- received in three parts ----
  const lineId = po.lines[0].id
  const states = []
  for (const qty of [20000, 30000]) {
    await h.invoke('salesdoc:convert', { id: po.id, quantities: [{ lineId, qtyMilli: qty }], date: today })
    const mid = await h.invoke('salesdoc:get', { id: po.id })
    states.push(`${mid.status}/${mid.fulfilment.state}/${mid.fulfilment.pendingMilli}`)
  }
  assertEq(
    JSON.stringify(states),
    JSON.stringify(['open/partial/70000', 'open/partial/40000']),
    'two part-receipts leave the order open with the balance still owed'
  )

  await h.invoke('salesdoc:convert', { id: po.id, quantities: [{ lineId, qtyMilli: 40000 }], date: today })
  const closed = await h.invoke('salesdoc:get', { id: po.id })
  assertEq(closed.status, 'converted', 'the third receipt closes it')
  assertEq(closed.fulfilment.state, 'complete', 'and it reports itself fully received')
  const receipts = await h.invoke('salesdoc:list', { side: 'purchase', stage: 'challan' })
  assertEq(receipts.length, 3, 'three receipt notes, one per delivery')
  assertEq(receipts.every((r) => r.unordered === false), true, 'all three know which order they are against')

  // ---- an over-delivery ----
  const over = await h.invoke('salesdoc:save', {
    data: {
      stage: 'order', side: 'purchase', date: today, partyLedgerId: supplier.id,
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 10000, ratePaise: 1000 }]
    }
  })
  const grn = await h.invoke('salesdoc:convert', {
    id: over.id,
    quantities: [{ lineId: over.lines[0].id, qtyMilli: 12000 }],
    allowOver: true,
    date: today
  })
  assertEq(grn.lines[0].qtyMilli, 12000, 'the receipt records what actually arrived, not what was ordered')
  const overAfter = await h.invoke('salesdoc:get', { id: over.id })
  assertEq(overAfter.fulfilment.overMilli, 2000, 'the excess is carried as an over-receipt')
  assertEq(overAfter.fulfilment.pendingMilli, 0, 'and nothing is still owed')

  // Outward the same request is refused: our own challan cannot exceed our own order.
  const buyer = await h.invoke('master:ledgers:create', {
    name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), openingBalance: 0, stateCode: '27'
  })
  const so = await h.invoke('salesdoc:save', {
    data: {
      stage: 'order', date: today, partyLedgerId: buyer.id,
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 1000, ratePaise: 1000 }]
    }
  })
  const refused = await h.invoke('salesdoc:convert', {
    id: so.id, quantities: [{ lineId: so.lines[0].id, qtyMilli: 5000 }], allowOver: true
  }).then(() => null, (err) => err)
  assert(refused && /inward receipt/.test(String(refused)), 'an outward challan may not exceed its order')

  // ---- a receipt note with no order behind it ----
  const bare = await h.invoke('salesdoc:save', {
    data: {
      stage: 'challan', side: 'purchase', date: today, partyLedgerId: supplier.id,
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 5000, ratePaise: 1000 }]
    }
  })
  assertEq(bare.unordered, true, 'goods that arrived unannounced say so')
  const bareMatch = await h.invoke('salesdoc:match', { id: bare.id })
  assertEq(bareMatch.rows[0].status, 'not_ordered', 'and match as not ordered rather than reporting nothing')

  // ---- billed for more than arrived ----
  const short = await h.invoke('salesdoc:save', {
    data: {
      stage: 'order', side: 'purchase', date: today, partyLedgerId: supplier.id,
      lines: [{ stockItemId: bolt.id, description: 'Bolt', qtyMilli: 10000, ratePaise: 1000 }]
    }
  })
  const shortGrn = await h.invoke('salesdoc:convert', {
    id: short.id, quantities: [{ lineId: short.lines[0].id, qtyMilli: 6000 }], date: today
  })
  const types = await h.invoke('master:voucherTypes:list')
  const purchaseType = types.find((t) => t.kind === 'purchase')
  const bill = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchaseType.id, date: today, partyLedgerId: supplier.id,
      lines: [
        { ledgerId: purchases.id, drCr: 'dr', amount: 10000 },
        { ledgerId: supplier.id, drCr: 'cr', amount: 10000 }
      ],
      inventory: [
        { stockItemId: bolt.id, godownId: null, qtyMilli: 10000, ratePaise: 1000, amount: 10000, direction: 'in' }
      ]
    }
  })
  await h.invoke('salesdoc:markInvoiced', { id: shortGrn.id, voucherId: bill.id })
  const match = await h.invoke('salesdoc:match', { id: short.id })
  assertEq(match.clean, false, 'the three documents do not agree')
  assertEq(match.exceptions[0].status, 'over_invoiced', 'and the worst of it is a bill for goods that never came')
  assertEq(match.exceptions[0].invoiceVarianceMilli, 4000, 'by exactly the quantity that did not arrive')

  // ---- the screen ----
  await h.goto('sales-chain')
  await h.click('tab-chain-side-purchase')
  await h.page.waitForSelector('[data-testid="rows-salesdocs-purchase-order"] tr', { timeout: 15000 })

  // The pipeline card reports fulfilment, not just a count of open documents.
  const partial = await h.page.textContent('[data-testid="pipeline-over-order"]')
  assert(/over-received/.test(partial), `the pipeline names the over-receipt (got "${partial}")`)

  const pendingCell = await h.page.textContent(`[data-testid="cell-pending-${short.id}"]`)
  assertEq(pendingCell.trim(), '4', 'the order still owes four units on screen')
  const statusCell = await h.page.textContent(`[data-testid="cell-status-${short.id}"]`)
  assert(/part received/.test(statusCell), `a part-received order says so rather than "open" (got "${statusCell}")`)
  await h.shot('01-purchase-orders')

  // The match, from the row action a person would actually use.
  await h.click(`btn-salesdoc-match-${short.id}`)
  await h.page.waitForSelector('[data-testid="rows-match"] tr', { timeout: 10000 })
  const verdict = await h.page.textContent('[data-testid="match-verdict"]')
  assert(/disagree/.test(verdict), `the match says the three do not agree (got "${verdict}")`)
  await h.shot('02-three-way-match')

  h.assertNoConsoleErrors()
})
