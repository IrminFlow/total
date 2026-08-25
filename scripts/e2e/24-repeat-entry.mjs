// Scenario 24 — "same as last time, different amount".
//
// Most data entry in a small business is a voucher shaped exactly like one already in the books:
// the rent cheque, the monthly retainer, the standing purchase. Two paths to it — ⌘D on a Day
// Book row, and "Same as last" in voucher entry — and one property both must hold: the date is
// NOT copied, because a new voucher dated a month ago is a mistake.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('24-repeat-entry', async (h) => {
  await h.createCompanyUI('Repeat Books')
  await h.stubDialogs()


  /**
   * Leave the entry form and land on the Gateway.
   *
   * Escape in a field blurs it, so the second press is the one that leaves; the unsaved-changes
   * guard resolves asynchronously, so the confirm has to be waited for rather than probed. And
   * Escape goes back one screen, which is wherever we came from — pressing G is what makes the
   * destination the same every time.
   */
  const leaveForm = async () => {
    // Click the sidebar rather than pressing G: a bare letter is ignored while the cursor is in a
    // field, and after loading a draft it usually is. The unsaved-changes guard resolves
    // asynchronously, so the confirm has to be waited for rather than probed.
    await h.page.click('[data-testid="nav-gateway"]')
    const confirm = await h.page
      .waitForSelector('[data-testid="confirm-ok"]', { timeout: 3000 })
      .catch(() => null)
    if (confirm) await confirm.click()
    await h.waitScreen('gateway', 20000)
  }

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const groups = await h.invoke('master:groups:list')
  const rentLedger = await h.invoke('master:ledgers:create', {
    name: 'Office Rent', groupId: groups.find((g) => g.name === 'Indirect Expenses').id,
    openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })

  const payment = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'payment')
  // Dated well in the past, so a copied date would be unmistakable.
  const OLD_DATE = '2026-04-15'
  const original = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: payment.id, date: OLD_DATE, partyLedgerId: null,
      narration: 'April rent', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: rentLedger.id, drCr: 'dr', amount: 2500000 },
        { ledgerId: cash.id, drCr: 'cr', amount: 2500000 }
      ],
      inventory: []
    }
  })

  // ---- the draft carries the shape but not the date ----
  const draft = await h.invoke('voucher:draftFrom', { voucherId: original.id })
  assert(draft.narration === 'April rent', 'the narration comes across')
  assert(draft.lines.length === 2, 'both lines come across')
  assert(
    draft.lines.some((l) => l.ledgerId === rentLedger.id && l.amount === 2500000 && l.drCr === 'dr'),
    'with their ledgers, sides and amounts'
  )
  assert(draft.date === undefined, 'but NOT the date — a new voucher dated a month ago is a mistake')

  const latest = await h.invoke('voucher:latestOfType', { voucherTypeId: payment.id })
  assert(latest.voucherId === original.id, 'the latest of the type is the one just saved')

  // ---- ⌘D from the Day Book ----
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${original.id}"]`, { timeout: 15000 })
  await h.page.hover(`[data-testid="rows-daybook"] [data-row-id="${original.id}"]`)
  await h.page.keyboard.press('Control+d')
  await h.waitScreen('voucher-entry', 20000)

  const dateShown = await h.page.inputValue('[data-testid="input-date"]')
  assert(!/Apr-26/.test(dateShown), `the new voucher is not dated in April (got ${dateShown})`)
  const narration = await h.page.inputValue('[data-testid="input-narration"]')
  assert(narration === 'April rent', 'but the narration did come across')
  await h.shot('01-duplicated')

  await leaveForm()

  // ---- "Same as last" from voucher entry ----
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry')
  // The screen remembers the last type entered, so select Payment explicitly.
  await h.page.click('[data-testid="tab-voucher-entry-payment"]')
  await h.page.waitForSelector('[data-testid="btn-same-as-last"]', { timeout: 15000 })
  await h.click('btn-same-as-last')
  await h.page.waitForFunction(
    () => document.querySelector('[data-testid="input-narration"]')?.value === 'April rent',
    null,
    { timeout: 15000 }
  )
  const dateShown2 = await h.page.inputValue('[data-testid="input-date"]')
  assert(!/Apr-26/.test(dateShown2), 'and this path does not copy the date either')
  await h.shot('02-same-as-last')

  await leaveForm()

  // ---- the last-used type is remembered ----
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry')
  const activeTab = await h.page.$eval('[data-testid="tab-voucher-entry-payment"]', (el) => el.className)
  assert(/accent/.test(activeTab), 'voucher entry reopens on the type last used, not on Journal')
})
