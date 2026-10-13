// Scenario 49 — WP 8.5, a simple-mode shop: saving a bill with no customer says so UNDER the
// customer field (no corner toast) and the message goes once a customer is picked; a correct
// bill shows the save card ("Bill ₹… saved. Ramesh still owes ₹….") with the figures main
// computed; Undo moves it to the bin (one undo group, audited) and the Day book no longer shows
// it. Light and dark screenshots of the field error, the card and the undo result.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('49-save-card-undo', async (h) => {
  const page = h.page
  await h.createCompanyUI('Undo Kirana', { mode: 'simple' })
  await h.stubDialogs()
  assertEq((await h.invoke('company:current')).ui.mode, 'simple', 'the company is in simple mode')

  // ---------- masters (through the services the dialogs call) ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  await ledger('Sales', 'Sales Accounts')
  const ramesh = await ledger('Ramesh', 'Sundry Debtors')
  const units = await h.invoke('master:units:list')
  await h.invoke('master:stockItems:create', {
    name: 'Sugar 1kg', groupId: null, unitId: units.find((u) => u.symbol === 'Pcs').id, hsn: null, gstRate: null, cessRate: null,
    openingQtyMilli: 50_000, openingValue: 225_000, barcode: null, reorderLevelMilli: null
  })

  const pick = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  const theme = async (want) => {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === want) return
    await h.click('btn-theme')
    await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
    await page.waitForTimeout(400) // let the colour transition finish before a screenshot
  }
  const both = async (name) => {
    await page.waitForTimeout(400)
    await theme('light')
    await h.shot(`${name}-light`)
    await theme('dark')
    await h.shot(`${name}-dark`)
    await theme('light')
  }
  const errorToasts = () =>
    page.$$eval('[role="status"] button', (bs) => bs.map((b) => b.className).filter((c) => c.includes('text-danger')).length)

  // ---------- Sell → Make a bill ----------
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })

  // A wrong entry: Save with no customer → the error sits under the customer field.
  await h.click('btn-save-voucher')
  const err = await page.waitForSelector('[data-testid="field-error-party"]', { timeout: 5000 })
  assertEq((await err.textContent())?.trim(), 'Pick the party account first', 'the accountant screen keeps its wording, under the field')
  const described = await page.$eval('[data-testid="picker-party"]', (el) => el.getAttribute('aria-describedby') ?? '')
  const errId = await err.getAttribute('id')
  assert(described.split(' ').includes(errId), `the party picker is described by its error (${described} / ${errId})`)
  assertEq(await errorToasts(), 0, 'no error toast in the corner')
  await both('01-field-error')

  // Fixing the field clears its error.
  await pick('picker-party', 'Ramesh')
  await page.waitForSelector('[data-testid="field-error-party"]', { state: 'detached', timeout: 5000 })

  // ---------- a correct bill → the save card ----------
  const salesPicker = page.locator('input[placeholder="e.g. Sales"]')
  await salesPicker.click()
  await salesPicker.fill('Sales')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await salesPicker.press('Enter')
  await pick('picker-item', 'Sugar 1kg')
  await page.locator('[data-testid="input-line-qty"]').first().fill('2')
  await page.locator('[data-testid="input-line-rate"]').first().fill('45')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await h.click('btn-save-voucher')
  await page.waitForSelector('[data-testid="save-card"][data-state="saved"]', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="save-card-text"]')?.textContent?.includes('still owes'), null, { timeout: 10000 })
  const cardText = (await page.textContent('[data-testid="save-card-text"]'))?.trim()
  assertEq(cardText, 'Bill ₹90.00 saved. Ramesh still owes ₹90.00.', 'the card says what was saved, with the figures from main')

  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const list = await h.invoke('voucher:list', { from: today, to: today })
  assertEq(list.length, 1, 'one bill saved')
  const bill = list[0]
  const summary = await h.invoke('voucher:saveSummary', { voucherIds: [bill.id] })
  assertEq(summary.party.ledgerId, ramesh.id, 'the card names the bill’s customer')
  assertEq(summary.party.balance, 9000, 'what Ramesh owes comes from the outstandings')
  await both('02-save-card')

  // ---------- Undo → the bin; the Day book no longer shows it ----------
  await h.click('btn-save-card-undo')
  await page.waitForSelector('[data-testid="save-card"][data-state="undone"]', { timeout: 10000 })
  await both('03-undone')
  const bin = await h.invoke('voucher:bin')
  const binned = bin.find((r) => r.id === bill.id)
  assert(binned && binned.undoGroupId != null, 'the bill is in the bin, as an undo group')
  const audit = await h.invoke('audit:list', { entity: 'undo_group', page: 0 })
  assert(audit.rows.some((r) => r.action === 'create'), 'the undo is audited')
  const dayBook = await h.invoke('report:dayBook', { from: today, to: today })
  assert(!dayBook.some((r) => r.voucherId === bill.id), 'the Day book no longer has the bill')

  // The bill form is a full-app screen (until its Phase 9 flow); "Back to simple" returns to Sell.
  await h.click('btn-back-to-simple')
  await h.click('simple-nav-money')
  await h.click('simple-entry-all-entries')
  await h.waitScreen('daybook')
  await h.waitIdle()
  const rows = await page.$$eval('[data-testid="rows-daybook"] tr.dt-row', (trs) => trs.map((tr) => tr.textContent ?? ''))
  assert(!rows.some((t) => t.includes(bill.number) && t.includes('Ramesh')), `the Day book screen doesn't show ${bill.number}`)
  await h.shot('04-daybook-after-undo')
})
