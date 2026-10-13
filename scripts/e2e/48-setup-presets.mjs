// Scenario 48 — WP 8.3 setup wizard and business presets. First run lands on the wizard (the
// accountant "New company (full form)" and "Sample data in the full app" on the same screen);
// an unregistered kirana goes through every step (each refusing to go on until answered) → simple
// Home, with the shop's accounts seeded (no GST accounts), TDS / payroll / orders off and a sale
// that charges no GST. Then a regular services company (GSTIN, quarterly filing) gets the GST
// accounts and its sale carries GST. Settings → Features shows "Turn on" cards. Every wizard
// step, Home and Features are captured light and dark for the visual review.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const attached = (h, sel, timeout = 10000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const step = (h) => h.page.getAttribute('[data-testid="setup-wizard"]', 'data-step')

/** Walk the wizard: `answers` per step; screenshots `<prefix>-<n>-<step>`. */
async function runWizard(h, prefix, a) {
  await attached(h, '[data-testid="setup-wizard"]')
  await h.shot(`${prefix}-1-business`)
  // Nothing typed: the name is asked for under its field.
  await h.click('setup-next')
  assertEq(await step(h), 'business', 'an empty name keeps the wizard on step 1')
  assert((await h.page.textContent('[data-testid="setup-wizard"]')).includes('Type the name of your business.'), 'the name error shows')
  await h.fill('setup-name', a.name)
  await h.click('setup-next')
  assertEq(await step(h), 'type', 'step 2: business type')
  await h.shot(`${prefix}-2-type`)
  await h.click(`setup-type-${a.type}`)
  await h.click('setup-next')
  assertEq(await step(h), 'gst', 'step 3: GST')
  await h.shot(`${prefix}-3-gst`)
  await h.click(`setup-gst-${a.gst}`)
  if (a.gstin) {
    await h.click('setup-next')
    assertEq(await step(h), 'gst', 'a regular registration needs its GSTIN and filing frequency')
    await h.shot(`${prefix}-3b-gst-errors`)
    await h.fill('setup-gstin', a.gstin)
    await h.click(`setup-filing-${a.filing}`)
    await h.shot(`${prefix}-3c-gst-filled`)
  }
  await h.click('setup-next')
  assertEq(await step(h), 'stock', 'step 4: stock')
  await h.shot(`${prefix}-4-stock`)
  await h.click(`setup-stock-${a.stock ? 'yes' : 'no'}`)
  await h.click('setup-next')
  assertEq(await step(h), 'start', 'step 5: start date')
  assert((await h.page.textContent('[data-testid="setup-start-fy"]')).includes('Start of this financial year (1 Apr'), 'the start date in plain words')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.shot(`${prefix}-5-start`)
  await h.click('setup-next')
  assertEq(await step(h), 'tally', 'step 6: coming from Tally?')
  await h.shot(`${prefix}-6-tally`)
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  await attached(h, '[data-testid="simple-nav"]')
  await h.waitIdle()
}

async function shootHomeAndFeatures(h, prefix) {
  // Settings → Features opens in the full app ("Back to simple" returns).
  if (await h.page.$('[data-testid="btn-back-to-simple"]')) await h.click('btn-back-to-simple')
  await attached(h, '[data-testid="simple-nav"]')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home"]')
  await h.waitIdle()
  await h.shot(`${prefix}-home`)
  await h.click('simple-nav-settings')
  await attached(h, '[data-testid="simple-entry-features"]')
  await h.click('simple-entry-features')
  await attached(h, '[data-testid="simple-features"]')
  // The simple Features screen: plain cards inside the simple shell (no accountant sidebar).
  assertEq(await h.page.$('nav[aria-label="Main"]'), null, 'Features stays in the simple shell')
  await h.waitIdle()
  await h.shot(`${prefix}-features`)
}

const header = {
  number: undefined, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
  transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
}

await scenario('48-setup-presets', async (h) => {
  const page = h.page
  // ---------- first run: the wizard, with the accountant ways in on the same screen ----------
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  for (const id of ['btn-company-create', 'btn-company-demo', 'btn-company-demo-full']) await attached(h, `[data-testid="${id}"]`)

  // ---------- an unregistered kirana ----------
  await runWizard(h, 'light-kirana', { name: 'Ramesh Kirana', type: 'retail', gst: 'no', stock: true })
  const cur = await h.invoke('company:current')
  assertEq(JSON.stringify(cur.ui), JSON.stringify({ mode: 'simple', setup: { businessType: 'retail', gst: 'no', stock: true }, startedFresh: true }), 'meta ui from the wizard')
  assertEq(cur.info.gstRegistrationType, 'unregistered', 'no GST registration')
  const features = await h.invoke('config:features:get')
  assert(!features.tds && !features.tcs && !features.payroll && !features.orders && !features.costCentres && !features.multiCurrency, 'modules off for a new simple company')
  assert(features.inventory && features.manufacturing === false, 'stock on, manufacturing off')
  const ledgers = await h.invoke('master:ledgers:list')
  for (const n of ['Sales', 'Purchases', 'Rent', 'Electricity', 'Packing', 'Shop expenses', "Owner's money", 'Round Off']) assert(ledgers.some((l) => l.name === n), `seeded ${n}`)
  assert(!ledgers.some((l) => l.taxType), 'no GST accounts for an unregistered shop')
  assert(ledgers.filter((l) => !l.isSystem).every((l) => l.simpleCategory), 'every seeded account carries a category')

  // A sale with no GST (the simple Sell flow is Phase 9 — saved through the normal save).
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales')
  const id = (n) => ledgers.find((l) => l.name === n).id
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const sale = await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: salesType.id, date: today, partyLedgerId: id('Cash'), narration: null,
      lines: [
        { ledgerId: id('Cash'), drCr: 'dr', amount: 25000, costAllocations: [] },
        { ledgerId: id('Sales'), drCr: 'cr', amount: 25000, costAllocations: [] }
      ]
    }
  })
  assert(sale.id > 0, 'the sale is saved')
  const tb = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(tb.totalDebit, tb.totalCredit, 'the books balance')

  await shootHomeAndFeatures(h, 'light-kirana')
  assertEq(await page.getAttribute('[data-testid="feature-card-tds"]', 'data-on'), 'false', 'TDS card is off')
  assert((await page.textContent('[data-testid="feature-card-tds"]')).includes('Your CA will tell you'), 'the TDS card says who needs it')
  await h.click('btn-feature-payroll')
  await page.waitForSelector('[data-testid="feature-card-payroll"][data-on="true"]', { timeout: 10000 })
  assertEq((await h.invoke('config:features:get')).payroll, true, '"Turn on" turns payroll on')
  await h.click('btn-feature-payroll')
  await page.waitForSelector('[data-testid="feature-card-payroll"][data-on="false"]', { timeout: 10000 })

  // Dark: Home and Features again.
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await shootHomeAndFeatures(h, 'dark-kirana')

  // ---------- a regular services company (dark wizard) ----------
  await h.click('btn-switch-company')
  await h.waitScreen('company-select')
  await h.click('btn-company-setup')
  await runWizard(h, 'dark-services', { name: 'Asha Design Studio', type: 'services', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'quarterly', stock: false })
  const cur2 = await h.invoke('company:current')
  assertEq(cur2.info.gstRegistrationType, 'regular', 'regular registration')
  assertEq(cur2.info.gstin, '27AAPFU0939F1ZV', 'GSTIN stored')
  assertEq((await h.invoke('gstProfile:get')).filing, 'quarterly', 'filing frequency stored')
  const f2 = await h.invoke('config:features:get')
  assert(!f2.inventory && !f2.tds, 'services: no stock, no TDS')
  const l2 = await h.invoke('master:ledgers:list')
  assertEq(l2.filter((l) => l.taxType).length, 6, 'the GST accounts (output + input CGST / SGST / IGST)')
  const id2 = (n) => l2.find((l) => l.name === n).id
  const gstSale = await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: salesType.id, date: today, partyLedgerId: id2('Cash'), narration: null,
      lines: [
        { ledgerId: id2('Cash'), drCr: 'dr', amount: 11800, costAllocations: [] },
        { ledgerId: id2('Service income'), drCr: 'cr', amount: 10000, costAllocations: [] },
        { ledgerId: id2('Output CGST'), drCr: 'cr', amount: 900, costAllocations: [] },
        { ledgerId: id2('Output SGST'), drCr: 'cr', amount: 900, costAllocations: [] }
      ]
    }
  })
  assert(gstSale.id > 0, 'a regular company sale carries GST')
  await shootHomeAndFeatures(h, 'dark-services')
  await h.click('btn-theme')
  await page.waitForFunction(() => document.documentElement.dataset.theme !== 'dark')
  await shootHomeAndFeatures(h, 'light-services')

  // ---------- the accountant path is unchanged: the full form still creates a key-less company ----------
  await h.click('btn-switch-company')
  await h.createCompanyUI('Full Form Co')
  assertEq(JSON.stringify((await h.invoke('company:current')).ui), JSON.stringify({ mode: 'accountant' }), 'full form = accountant, no ui meta')
  await attached(h, 'nav[aria-label="Main"]')
})
