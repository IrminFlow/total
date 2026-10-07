// Scenario 21 — deeper manufacturing (WP 2.4), driven through the UI: a two-level BOM with a
// version picked by the voucher date, "Explode sub-assemblies" (raw rows = the leaves), a scrap
// row that comes off the production cost, save; a backdated purchase re-prices the register
// ("cost now" vs "cost at save"); send steel to a job worker from the Stock journal, receive the
// finished frames back in Manufacture's job-work mode (job charges credited to the job worker);
// the manufacturing reports. With WP24_SHOTS set, the key screens are also captured in both
// themes at 1440×900 into that directory.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('21-manufacturing-depth', async (h) => {
  await h.createCompanyUI('Depth Works')
  const page = h.page
  const shotsDir = process.env.WP24_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const both = async (name, { top = true } = {}) => {
    if (top) await page.evaluate(() => document.querySelectorAll('main, [data-screen]').forEach((el) => el.scrollTo?.(0, 0)))
    await h.shot(name)
    if (!shotsDir) return
    for (const theme of ['light', 'dark']) {
      const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
      // A JS click: a modal's scrim may cover the header button.
      if (now !== theme) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${theme}.png`) })
    }
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }

  const unit = (await h.invoke('master:units:list'))[0]
  const mkItem = (name, openingQtyMilli = 0, openingValue = 0) =>
    h.invoke('master:stockItems:create', {
      name, groupId: null, unitId: unit.id, hsn: '7308', gstRate: null, cessRate: null,
      openingQtyMilli, openingValue, barcode: null, reorderLevelMilli: null
    })
  const steel = await mkItem('E2E Steel', 10_000, 150_000) // 10 @ ₹150
  const paint = await mkItem('E2E Paint', 2_000, 80_000) // 2 @ ₹400
  const frame = await mkItem('E2E Frame')
  const chair = await mkItem('E2E Chair')
  const offcut = await mkItem('E2E Offcut')
  const groups = await h.invoke('master:groups:list')
  const gid = (n) => groups.find((g) => g.name === n).id
  const ravi = await h.invoke('master:ledgers:create', { name: 'Ravi Fabricators', groupId: gid('Sundry Creditors'), openingBalance: 0 })
  const purchasesL = await h.invoke('master:ledgers:create', { name: 'Purchases', groupId: gid('Purchase Accounts'), openingBalance: 0 })
  const cash = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash')
  const main = await h.invoke('master:godowns:create', { name: 'Main' })
  const jw = await h.invoke('master:godowns:create', { name: 'Ravi (job work)', kind: 'job_worker', partyLedgerId: ravi.id })
  // Chair = 1 Frame + 0.25 Paint (v1, default); Frame = 2 Steel.
  const v1 = await h.invoke('bom:saveVersion', { itemId: chair.id, name: 'v1', isDefault: true, lines: [{ componentId: frame.id, qtyMilliPerUnit: 1000 }, { componentId: paint.id, qtyMilliPerUnit: 250 }] })
  await h.invoke('bom:saveVersion', { itemId: chair.id, name: 'v2-2099', isDefault: false, effectiveFrom: '2099-01-01', lines: [{ componentId: frame.id, qtyMilliPerUnit: 1000 }] })
  await h.invoke('bom:saveVersion', { itemId: frame.id, name: 'v1', isDefault: true, lines: [{ componentId: steel.id, qtyMilliPerUnit: 2000 }] })
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (k) => types.find((t) => t.kind === k).id
  const today = new Date().toISOString().slice(0, 10)

  const text = async (testId) => (await page.locator(`[data-testid="${testId}"]`).first().textContent()) ?? ''
  const value = async (testId) => page.locator(`[data-testid="${testId}"]`).first().inputValue()
  const waitText = async (testId, needle) =>
    page.waitForFunction(
      ([id, n]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').includes(n),
      [testId, needle],
      { timeout: 10000 }
    )
  const waitValue = async (testId, v) =>
    page.waitForFunction(([id, x]) => document.querySelector(`[data-testid="${id}"]`)?.value === x, [testId, v], { timeout: 10000 })
  const pick = async (testId, name) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(name)
    await page.locator('[role="option"]', { hasText: name }).first().waitFor({ timeout: 10000 })
    await input.press('Enter')
    await waitValue(testId, name)
  }

  // ---------- multi-level BOM: version by date, explode, scrap ----------
  await h.goto('manufacture')
  await page.waitForSelector('[data-testid="manufacture-form"]')
  await pick('picker-manufacture-item', 'E2E Chair')
  await h.fill('input-manufacture-qty', '2')
  await h.fill('input-manufacture-sale-rate', '1000')
  await waitValue('input-manufacture-bom-version', String(v1.id))
  await waitValue('picker-manufacture-raw-0', 'E2E Frame')
  assertEq(await value('input-manufacture-raw-qty-1'), '0.5', 'paint scaled from v1 for 2 chairs')
  assert((await text('manufacture-subassemblies')).includes('E2E Frame'), 'the frame is listed as a sub-assembly')
  await page.click('[data-testid="input-manufacture-explode"]')
  await waitValue('picker-manufacture-raw-0', 'E2E Steel')
  assertEq(await value('input-manufacture-raw-qty-0'), '4', 'exploded: 2 chairs × 1 frame × 2 steel')
  await waitText('manufacture-materials', '800.00') // 4 × ₹150 + 0.5 × ₹400
  await h.click('btn-manufacture-add-byproduct')
  await pick('picker-manufacture-bp-0', 'E2E Offcut')
  await h.fill('input-manufacture-bp-qty-0', '0.5')
  await page.selectOption('[data-testid="input-manufacture-bp-kind-0"]', 'scrap')
  await h.fill('input-manufacture-bp-value-0', '50')
  await h.fill('input-manufacture-labour', '300')
  await waitText('manufacture-production-cost', '1,050.00') // 800 + 300 − 50
  await waitText('manufacture-profit', '950.00')
  assertEq(await page.locator('[data-testid="manufacture-match"]').getAttribute('data-match'), 'true', 'both sides match')
  await both('01-manufacture-exploded-scrap')
  await h.click('btn-save-manufacture')
  await page.waitForFunction(() => document.querySelector('[data-testid="input-manufacture-qty"]')?.value === '', null, { timeout: 10000 })
  let reg = await h.invoke('manufacture:register', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(reg.length, 1, 'one manufacture')
  assertEq(reg[0].productionCost, 105000, 'production cost net of the scrap')
  assertEq(reg[0].byProductPaise, 5000, 'scrap value')
  const md = await h.invoke('manufacture:get', { id: reg[0].voucherId })
  assertEq(md.details.bomVersionId, v1.id, 'version recorded')
  assertEq(md.details.bomExploded, true, 'explode recorded')
  assertEq(md.details.byProducts.length, 1, 'scrap row stored')

  // ---------- a backdated purchase re-prices the register ----------
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('purchase'), date: yesterday, partyLedgerId: null,
      lines: [{ ledgerId: purchasesL.id, drCr: 'dr', amount: 250_000 }, { ledgerId: cash.id, drCr: 'cr', amount: 250_000 }],
      inventory: [{ stockItemId: steel.id, godownId: main.id, qtyMilli: 10_000, ratePaise: 25_000, amount: 250_000, direction: 'in' }]
    }
  })
  reg = await h.invoke('manufacture:register', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(reg[0].costAtSave, 105000, 'cost at save unchanged')
  assertEq(reg[0].productionCost, 105000 + 4 * 5000, 'cost now: steel average ₹150 → ₹200')
  assert(reg[0].repriced, 'flagged re-priced')
  await h.click('btn-manufacture-register')
  await h.waitScreen('manufacture-register')
  await page.waitForSelector('[data-testid="register-cost-now"][data-repriced="true"]', { timeout: 10000 })
  assert((await text('register-repriced-note')).includes('re-priced'), 'the register explains the re-pricing')
  await both('02-register-repriced')

  // ---------- job work: send from the stock journal ----------
  await h.goto('stock-journal')
  await page.click('[data-testid="stock-journal-mode-jobWork"]')
  await page.waitForSelector('[data-testid="form-job-work-challan"]')
  await pick('picker-job-worker', 'Ravi (job work)')
  await h.fill('input-job-work-nature', 'Bending and welding')
  await pick('picker-transfer-item', 'E2E Steel')
  await pick('picker-transfer-from', 'Main')
  await page.locator('[data-testid="input-transfer-qty"]').first().fill('4')
  await waitText('transfer-total', '800.00') // 4 × ₹200
  await both('03-send-to-job-worker')
  await h.click('btn-save-transfer')
  await page.waitForFunction(() => document.querySelector('[data-testid="input-transfer-qty"]')?.value === '', null, { timeout: 10000 })
  const pending = await h.invoke('jobWork:pending', { asOn: today, pendingDays: 30 })
  assertEq(pending.length, 1, 'material at the job worker')
  assertEq(pending[0].qtyMilli, 4000, '4 steel at Ravi')
  const challans = await h.invoke('jobWork:sendChallans', { id: jw.id })
  assertEq(challans.length, 1, 'one send challan')

  // ---------- receive finished frames back (Manufacture, job-work mode) ----------
  await h.goto('manufacture')
  await page.click('[data-testid="manufacture-mode-job"]')
  await page.waitForSelector('[data-testid="manufacture-job-work"]')
  await pick('picker-manufacture-job-worker', 'Ravi (job work)')
  await waitText('manufacture-job-work', 'Ravi Fabricators')
  await pick('picker-manufacture-item', 'E2E Frame')
  await h.fill('input-manufacture-qty', '2')
  await waitValue('picker-manufacture-raw-0', 'E2E Steel')
  await h.fill('input-manufacture-raw-loss-0', '0.1')
  await h.fill('input-manufacture-labour', '150')
  await h.fill('input-manufacture-jw-challan', 'RF/112')
  await h.fill('input-manufacture-jw-nature', 'Bending and welding')
  await page.selectOption('[data-testid="input-manufacture-jw-original"]', String(challans[0].voucherId))
  await h.fill('input-manufacture-sale-rate', '600')
  await waitText('manufacture-production-cost', '950.00') // 4 steel @ ₹200 + ₹150 job charges
  await both('04-receive-from-job-worker')
  await h.click('btn-save-manufacture')
  await page.waitForFunction(() => document.querySelector('[data-testid="input-manufacture-qty"]')?.value === '', null, { timeout: 10000 })
  reg = await h.invoke('manufacture:register', { from: '2000-01-01', to: '2100-12-31' })
  const receipt = reg.find((r) => r.jobWork)
  assert(receipt, 'the receipt is in the register as job work')
  assertEq(receipt.productionCost, 95000, 'frames at materials + job charges')
  const rv = await h.invoke('voucher:get', { id: receipt.voucherId })
  assertEq(JSON.stringify(rv.inventory.map((l) => [l.stockItemId, l.godownId, l.direction])), JSON.stringify([[steel.id, jw.id, 'out'], [frame.id, null, 'in']]), 'consumed at the job worker')
  assert(rv.lines.some((l) => l.ledgerId === ravi.id && l.drCr === 'cr' && l.amount === 15000), 'job charges credited to the job worker')
  const itc = await h.invoke('jobWork:itc04', { from: '2000-01-01', to: '2100-12-31' })
  assertEq(itc.sent.length, 1, 'ITC-04: one line sent')
  assertEq(itc.received.length, 1, 'ITC-04: one receipt')
  assertEq(itc.received[0].challanNo, 'RF/112', "ITC-04: the job worker's challan")
  assertEq(itc.received[0].inputs[0].lossQtyMilli, 100, 'ITC-04: loss')
  assertEq((await h.invoke('jobWork:pending', { asOn: today, pendingDays: 30 })).length, 0, 'nothing left at the job worker')
  // A second challan (via IPC) so the job-work report has a row to show.
  await h.invoke('jobWork:saveChallan', {
    voucher: {
      voucherTypeId: typeOf('stock_journal'), date: today, lines: [],
      inventory: [
        { stockItemId: steel.id, godownId: main.id, qtyMilli: 2000, ratePaise: 20000, amount: 40000, direction: 'out' },
        { stockItemId: steel.id, godownId: jw.id, qtyMilli: 2000, ratePaise: 20000, amount: 40000, direction: 'in' }
      ]
    },
    challan: { kind: 'send', godownId: jw.id, natureOfProcessing: 'Cutting' }
  })

  // ---------- reports ----------
  await h.click('btn-manufacture-register')
  await h.waitScreen('manufacture-register')
  await h.click('btn-register-production')
  await h.waitScreen('manufacture-reports')
  await page.waitForSelector('[data-testid="rows-manufacture-production"] [data-row-id]', { timeout: 10000 })
  await both('05-production-register')
  await h.click('tab-manufacture-reports-cost-sheet')
  await page.waitForSelector('[data-testid="cost-sheet-unit"]', { timeout: 10000 })
  await both('06-cost-sheet')
  await h.click('tab-manufacture-reports-variance')
  await page.waitForSelector('[data-testid="rows-manufacture-variance"] tr', { timeout: 10000 })
  await both('07-variance')
  await h.click('tab-manufacture-reports-margin')
  await page.waitForSelector('[data-testid="rows-manufacture-margin"] [data-row-id]', { timeout: 10000 })
  await both('08-margin')
  await h.click('tab-manufacture-reports-job-work')
  await page.waitForSelector('[data-testid="rows-manufacture-job-workers"] [data-row-id]', { timeout: 10000 })
  await both('10-material-at-job-workers')
  const variance = await h.invoke('manufacture:variance', { from: '2000-01-01', to: '2100-12-31' })
  assert(variance.length >= 2, 'variance rows for the BOM-based manufactures')
  assert(variance.every((r) => r.qtyVarianceMilli === 0), 'BOM-exact runs have no quantity variance')

  // ---------- masters: BOM versions editor + job-worker godown ----------
  await h.goto('masters')
  await h.click('tab-masters-items')
  await page.click(`[data-testid="rows-masters-items"] [data-row-id="${chair.id}"]`, { clickCount: 2 })
  await page.waitForSelector('[data-testid="bom-editor"]', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="input-bom-version"] option').length >= 3, null, { timeout: 10000 })
  assertEq(await value('input-bom-version-name'), 'v1', 'the default version opens first')
  await both('09-masters-bom-versions')
})
