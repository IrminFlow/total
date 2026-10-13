// Scenario 51 — WP 8.7 opening setup. A continuing kirana (setup: "already running") sees Home's
// step "Enter what you had on day one"; enters cash, one customer bill, one supplier bill and two
// products; the confirm step says the difference in one sentence and saves it as the owner's money.
// Afterwards: Home says what customers owe, the opening balances agree (Dr = Cr), Outstandings
// lists the customer's bill under its number, and the stock summary shows the stock's value.
// Every step, the confirm step and Home after are captured light and dark for the visual review.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const attached = (h, sel, timeout = 10000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const text = async (h, id) => (await h.page.textContent(`[data-testid="${id}"]`)) ?? ''
const step = (h) => h.page.getAttribute('[data-testid="openings"]', 'data-step')

async function wizard(h) {
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', 'Ramesh Kirana')
  await h.click('setup-next')
  await h.click('setup-type-retail')
  await h.click('setup-next')
  await h.click('setup-gst-no')
  await h.click('setup-next')
  await h.click('setup-stock-yes')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-continuing')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await h.waitIdle()
}

/** Home → the opening setup, every step filled; screenshots `<prefix>-<n>-<step>`. */
async function enterOpenings(h, prefix, fill) {
  await attached(h, '[data-testid="openings"]')
  assertEq(await step(h), 'money', 'step 1: money')
  if (fill) await h.fill('openings-cash', '5000')
  await h.shot(`${prefix}-1-money`)
  await h.click('openings-next')
  assertEq(await step(h), 'customers', 'step 2: what people owe you')
  if (fill) {
    await h.click('openings-add-customer')
    await h.fill('openings-customer-0-name', 'Sharma Stores')
    await h.fill('openings-customer-0-bill-0-ref', 'B-12')
    await h.fill('openings-customer-0-bill-0-amount', '3000')
    // The same number twice for one customer is refused under the field.
    await h.click('openings-customer-0-add-bill')
    await h.fill('openings-customer-0-bill-1-ref', 'b-12')
    await h.fill('openings-customer-0-bill-1-amount', '500')
    await h.click('openings-next')
    assertEq(await step(h), 'customers', 'a duplicate bill number keeps the step open')
    assert((await text(h, 'openings')).includes('Another bill here has the same number'), 'the duplicate-number message shows')
    await h.shot(`${prefix}-2b-customers-error`)
    await h.click('openings-customer-0-bill-1-remove')
  }
  await h.shot(`${prefix}-2-customers`)
  await h.click('openings-next')
  assertEq(await step(h), 'suppliers', 'step 3: what you owe')
  if (fill) {
    await h.click('openings-add-supplier')
    await h.fill('openings-supplier-0-name', 'Gupta Traders')
    await h.fill('openings-supplier-0-bill-0-ref', 'GT-881')
    await h.fill('openings-supplier-0-bill-0-amount', '8000')
  }
  await h.shot(`${prefix}-3-suppliers`)
  await h.click('openings-next')
  assertEq(await step(h), 'stock', 'step 4: stock on hand')
  if (fill) {
    await h.click('openings-add-item')
    await h.fill('openings-item-0-name', 'Rice 25 kg bag')
    await h.fill('openings-item-0-qty', '10')
    await h.fill('openings-item-0-rate', '1200')
    await h.click('openings-add-item')
    await h.fill('openings-item-1-name', 'Sugar')
    await h.page.selectOption('[data-testid="openings-item-1-unit"]', { label: 'Kg' })
    await h.fill('openings-item-1-qty', '20')
    await h.fill('openings-item-1-rate', '45')
    assertEq(await text(h, 'openings-stock-total'), 'Stock worth ₹12,900.00 in all', 'stock total = quantity × cost')
  }
  await h.shot(`${prefix}-4-stock`)
  await h.click('openings-next')
  assertEq(await step(h), 'confirm', 'step 5: check and confirm')
  await attached(h, '[data-testid="openings-difference-sentence"]', 15000)
  await h.shot(`${prefix}-5-confirm`)
  await h.click('openings-more')
  await attached(h, '[data-testid="openings-other"]')
  await h.shot(`${prefix}-5b-confirm-more`)
}

await scenario('51-openings', async (h) => {
  const page = h.page
  await h.waitScreen('company-select')
  await wizard(h)
  assertEq((await h.invoke('company:current')).ui.startedFresh, false, 'a continuing business')

  // ---------- Home: the step, nothing entered yet ----------
  await attached(h, '[data-testid="simple-home-openings"][data-done="false"]', 15000)
  assertEq(await text(h, 'simple-home-openings-progress'), '0 of 4 parts entered', 'progress before')
  await h.shot('light-0-home-before')
  await h.click('simple-home-openings-start')

  // ---------- the steps (light) ----------
  await enterOpenings(h, 'light', true)
  // have = 5,000 + 3,000 + 12,900 = 20,900; owe = 8,000 → 12,900 owner's money.
  assertEq(
    await text(h, 'openings-difference-sentence'),
    'Your assets are ₹12,900.00 more than what you owe. We will record that as your own money in the business (capital).',
    'the difference in one sentence'
  )
  await h.click('openings-confirm')
  await attached(h, '[data-testid="openings-done"]', 15000)
  await h.shot('light-6-done')

  // ---------- the books ----------
  const ledgers = await h.invoke('master:ledgers:list')
  const opening = (n) => ledgers.find((l) => l.name === n)?.openingBalance
  assertEq(opening('Cash'), 500000, 'cash opening')
  assertEq(opening('Sharma Stores'), 300000, 'customer opening (debit)')
  assertEq(opening('Gupta Traders'), -800000, 'supplier opening (credit)')
  assertEq(opening("Owner's money"), -1290000, 'the difference on the capital account')
  const cur = await h.invoke('company:current')
  const begin = cur.info.booksBeginDate
  const tb = await h.invoke('report:trialBalance', { asOn: begin })
  assertEq(tb.totalDebit, tb.totalCredit, 'opening balances agree (Dr = Cr)')
  const rec = await h.invoke('analysis:outstandings', { side: 'receivable', asOn: begin })
  const sharma = rec.find((p) => p.name === 'Sharma Stores')
  assertEq(JSON.stringify(sharma.bills.map((b) => [b.number, b.date, b.pending])), JSON.stringify([['B-12', begin, 300000]]), 'the opening bill, dated the books-begin day')
  const state = await h.invoke('simple:openings:get')
  assert(state.appliedAt, 'the setup is marked done')

  // ---------- Home after ----------
  await h.click('openings-done-home')
  await attached(h, '[data-testid="simple-home-openings"][data-done="true"]', 15000)
  await h.waitIdle()
  assertEq(await text(h, 'simple-home-customers-owe'), 'Customers owe you ₹3,000.00', 'Home: customers owe you')
  assertEq(await text(h, 'simple-home-you-owe'), 'You owe suppliers ₹8,000.00', 'Home: you owe suppliers')
  await h.shot('light-7-home-after')

  // ---------- Outstandings lists the bill ----------
  await h.click('simple-nav-people')
  await attached(h, '[data-testid="simple-entry-who-owes"]')
  await h.click('simple-entry-who-owes')
  await h.waitScreen('outstandings')
  await h.waitIdle()
  const row = page.locator('tr', { hasText: 'Sharma Stores' }).first()
  await row.locator('td').first().click()
  await attached(h, '[data-testid^="outstandings-bills-"]')
  assert((await page.textContent('[data-testid^="outstandings-bills-"]')).includes('B-12'), 'Outstandings shows the bill number')
  await h.shot('light-8-outstandings')
  await h.click('btn-back-to-simple')

  // ---------- the stock summary shows the value ----------
  await h.click('simple-nav-stock')
  await attached(h, '[data-testid="simple-entry-products"]')
  await h.click('simple-entry-products')
  await h.waitScreen('stock-summary')
  await h.waitIdle()
  const stockText = await page.textContent('[data-screen="stock-summary"]')
  assert(stockText.includes('12,000.00') && stockText.includes('900.00'), 'stock summary: each product at quantity × cost')
  await h.shot('light-9-stock-summary')
  await h.click('btn-back-to-simple')

  // ---------- dark: Home and every step again (from Settings, the figures as saved) ----------
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home-openings"][data-done="true"]')
  await h.shot('dark-7-home-after')
  await h.click('simple-nav-settings')
  await attached(h, '[data-testid="simple-entry-openings"]')
  await h.click('simple-entry-openings')
  await enterOpenings(h, 'dark', false)
  // Unchanged figures: confirming again changes nothing.
  await h.click('openings-confirm')
  await attached(h, '[data-testid="openings-done"]', 15000)
  assert((await text(h, 'openings-done')).includes('Nothing changed'), 'a re-run of the same figures changes nothing')
  await h.shot('dark-6-done-unchanged')
})
