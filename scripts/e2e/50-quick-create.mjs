// Scenario 50 — WP 8.4, plain pickers and quick-create in a simple-mode shop. On a bill's party
// field: a new name + Enter creates nothing (Enter selects, never creates); ↓ onto "Create …"
// opens the plain new-account dialog pre-picked as Customer, which saves the customer into
// Sundry Debtors with its phone; a near-duplicate name asks "Did you mean …?" and "Use" picks the
// existing customer; a typed prefix + Enter selects the match. The bill's account is a category
// picker with icons; a new product in an unregistered shop has no GST field and its selling price
// lands on the default price level; in a regular company the product dialog offers the cited GST
// slabs and requires one. Light and dark screenshots of each dialog.
import { scenario, assert, assertEq, PICKER_OPTION } from '../lib/harness.mjs'

await scenario('50-quick-create', async (h) => {
  const page = h.page
  await h.createCompanyUI('Quick Kirana', { mode: 'simple' })
  await h.stubDialogs()
  const cur = await h.invoke('company:current')
  assertEq(cur.ui.mode, 'simple', 'the company is in simple mode')
  assertEq(cur.info.gstRegistrationType, 'unregistered', 'no GSTIN = unregistered')

  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  await h.invoke('master:ledgers:create', {
    name: 'Sales', groupId: gid('Sales Accounts'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const ledgerCount = async () => (await h.invoke('master:ledgers:list')).length

  const theme = async (want) => {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === want) return
    await h.click('btn-theme')
    await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
    await page.waitForTimeout(400)
  }
  // The theme button sits behind an open dialog; switch through the same store the button sets.
  const both = async (name) => {
    await page.waitForTimeout(300)
    for (const want of ['light', 'dark']) {
      await page.evaluate((w) => {
        document.documentElement.dataset.theme = w
      }, want)
      await page.waitForTimeout(350)
      await h.shot(`${name}-${want}`)
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
  }
  const typeIn = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await page.waitForTimeout(150)
    return input
  }

  // ---------- Sell → Make a bill ----------
  await theme('light')
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })

  // A new name + Enter: nothing is created and no dialog opens.
  const before = await ledgerCount()
  let party = await typeIn('picker-party', 'Anita Stores')
  await page.waitForSelector('[data-testid="picker-party-create"]', { timeout: 5000 })
  assert((await page.textContent('[data-testid="picker-party-create"]')).includes('Create “Anita Stores”…'), 'the plain "Create …" row')
  await party.press('Enter')
  await page.waitForTimeout(300)
  assertEq(await page.$('[data-testid="dialog-new-account"]'), null, 'Enter opened no create dialog')
  assertEq(await ledgerCount(), before, 'Enter created nothing')

  // ↓ onto the create row + Enter → the plain dialog, pre-picked as Customer.
  await party.press('ArrowDown')
  await party.press('Enter')
  await page.waitForSelector('[data-testid="dialog-new-account"]', { timeout: 5000 })
  assertEq(await page.getAttribute('[data-testid="account-kind-customer"]', 'aria-checked'), 'true', 'a bill’s party starts as Customer')
  const dialogText = await page.textContent('[data-testid="dialog-new-account"]')
  assert(!/\b(ledger|group|sundry|voucher)\b/i.test(dialogText), `no accounting words in the dialog: ${dialogText}`)
  await page.fill('[data-testid="input-account-phone"]', '98765 43210')
  await both('01-new-account')
  await h.click('btn-account-create')
  await page.waitForSelector('[data-testid="dialog-new-account"]', { state: 'detached', timeout: 5000 })
  const anita = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Anita Stores')
  assert(anita, 'the customer was created')
  assertEq(anita.groupId, gid('Sundry Debtors'), 'in Sundry Debtors')
  assertEq(anita.phone, '98765 43210', 'with its phone')
  assertEq(await page.inputValue('[data-testid="picker-party"]'), 'Anita Stores', 'and picked on the bill')

  // A near-duplicate name: "Did you mean Anita Stores?" → Use it; nothing new.
  const count1 = await ledgerCount()
  party = await typeIn('picker-party', 'Anitha Stores')
  await party.press('ArrowDown')
  await party.press('Enter')
  await page.waitForSelector('[data-testid="dialog-new-account"]', { timeout: 5000 })
  await h.click('btn-account-create')
  await page.waitForSelector('[data-testid="account-did-you-mean"]', { timeout: 5000 })
  assert((await page.textContent('[data-testid="account-did-you-mean"]')).includes('Did you mean Anita Stores?'), 'the near-duplicate prompt')
  await both('02-did-you-mean')
  await h.click(`btn-dup-use-${anita.id}`)
  await page.waitForSelector('[data-testid="dialog-new-account"]', { state: 'detached', timeout: 5000 })
  assertEq(await ledgerCount(), count1, 'no duplicate customer')
  assertEq(await page.inputValue('[data-testid="picker-party"]'), 'Anita Stores', 'the existing customer is on the bill')

  // A prefix + Enter selects the highlighted match.
  party = await typeIn('picker-party', 'Anit')
  await page.waitForSelector(PICKER_OPTION, { timeout: 5000 })
  await party.press('Enter')
  assertEq(await page.inputValue('[data-testid="picker-party"]'), 'Anita Stores', 'Enter selected the match')
  assertEq(await ledgerCount(), count1, 'still nothing new')

  // ---------- the bill's account: a category picker with icons ----------
  await h.click('picker-account-category')
  await page.waitForSelector('[data-testid="picker-account-category-list"]', { timeout: 5000 })
  await both('03-category-picker')
  await h.click('category-sales')
  assert((await page.textContent('[data-testid="picker-account-category"]')).includes('Sales'), 'Sales picked from the categories')

  // ---------- a new product, unregistered shop: no GST field ----------
  const item = await typeIn('picker-item', 'Masala Tea 250g')
  await item.press('ArrowDown')
  await item.press('Enter')
  await page.waitForSelector('[data-testid="dialog-new-product"]', { timeout: 5000 })
  assertEq(await page.$('[data-testid="product-gst"]'), null, 'no GST rate for an unregistered shop')
  assertEq(await page.$('[data-testid="input-product-hsn"]'), null, 'no HSN either')
  await page.fill('[data-testid="input-product-selling"]', '60')
  await page.press('[data-testid="input-product-selling"]', 'Tab')
  await both('04-new-product-unregistered')
  await h.click('btn-product-create')
  await page.waitForSelector('[data-testid="dialog-new-product"]', { state: 'detached', timeout: 5000 })
  const tea = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Masala Tea 250g')
  assert(tea && tea.gstRate == null, 'the product exists without a GST rate')
  const levels = await h.invoke('master:priceLevels:list')
  const def = levels.find((l) => l.isDefault)
  assert(def, 'a default price level exists')
  const rates = await h.invoke('priceLevels:rates', { priceLevelId: def.id })
  assert(rates.some((r) => r.stockItemId === tea.id && r.rate === 6000), 'its selling price is on the default level')

  // The bill saves with the quick-created customer, category and product.
  await page.locator('[data-testid="input-line-qty"]').first().fill('2')
  await page.locator('[data-testid="input-line-rate"]').first().fill('60')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await h.click('btn-save-voucher')
  await page.waitForSelector('[data-testid="save-card"][data-state="saved"]', { timeout: 10000 })
  const bills = await h.invoke('voucher:list', { from: '2000-01-01', to: '2100-01-01' })
  assertEq(bills.length, 1, 'one bill saved')

  // ---------- a regular company: the cited GST slabs, required ----------
  await h.click('btn-back-to-simple')
  await page.evaluate(() => document.querySelector('[data-testid="btn-switch-company"]')?.click())
  await h.waitScreen('company-select')
  await h.createCompanyUI('Quick Traders', { mode: 'simple', gstin: '27AAPFU0939F1ZV' })
  assertEq((await h.invoke('company:current')).info.gstRegistrationType, 'regular', 'a GSTIN = regular')
  const g2 = await h.invoke('master:groups:list')
  await h.invoke('master:ledgers:create', {
    name: 'Mehta & Sons', groupId: g2.find((g) => g.name === 'Sundry Debtors').id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  await h.click('simple-nav-sell')
  await h.click('simple-entry-make-bill')
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  const nb = await typeIn('picker-item', 'Notebook A5')
  await nb.press('ArrowDown')
  await nb.press('Enter')
  await page.waitForSelector('[data-testid="product-gst"]', { timeout: 5000 })
  for (const r of [0, 5, 18]) assert(await page.$(`[data-testid="gst-rate-${r}"]`), `slab ${r}% offered`)
  assertEq(await page.$('[data-testid="gst-rate-12"]'), null, '12% is not a slab since 22 Sep 2025')
  await h.click('btn-product-create')
  await page.waitForSelector('[data-testid="field-error-gstRate"]', { timeout: 5000 })
  await both('05-new-product-regular')
  await h.click('gst-rate-18')
  await h.click('btn-product-create')
  await page.waitForSelector('[data-testid="dialog-new-product"]', { state: 'detached', timeout: 5000 })
  const notebook = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Notebook A5')
  assertEq(notebook?.gstRate, 18, 'the product carries the picked slab')

  // Save the bill (leaving nothing unsaved): an existing customer picked with Enter, Sales from the
  // categories (created on the click, with its key), the new product on the line.
  const p2 = await typeIn('picker-party', 'Mehta')
  await page.waitForSelector(PICKER_OPTION, { timeout: 5000 })
  await p2.press('Enter')
  assertEq(await page.inputValue('[data-testid="picker-party"]'), 'Mehta & Sons', 'Enter selected the customer')
  await h.click('picker-account-category')
  await h.click('category-sales')
  await page.waitForFunction(() => document.querySelector('[data-testid="picker-account-category"]')?.textContent?.includes('Sales'), null, { timeout: 5000 })
  const salesAcc = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Sales')
  assertEq(salesAcc?.simpleCategory, 'sales', 'the Sales account was created from its category, with its key')
  await page.locator('[data-testid="input-line-qty"]').first().fill('1')
  await page.locator('[data-testid="input-line-rate"]').first().fill('50')
  await page.locator('[data-testid="input-line-rate"]').first().press('Tab')
  await h.click('btn-save-voucher')
  await page.waitForSelector('[data-testid="save-card"][data-state="saved"]', { timeout: 10000 })
})
