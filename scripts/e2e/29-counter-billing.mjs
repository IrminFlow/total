// Scenario 29 — pricing and counter billing (WP 2.6), driven through the UI on the demo company:
//   a GST-inclusive default price level + a quantity-slab scheme (IPC setup), barcodes on two
//   items → Counter billing: scan both by barcode (keyboard only; the second twice, so it
//   increments and crosses the scheme's slab), ↑/+/− on a line, split the payment cash + UPI with
//   cash tendered → the sale posts a sales invoice (GST + round-off) and a receipt against it →
//   print (thermal receipt) → Day book shows both, the receipt allocates against the invoice →
//   Day end. Also: the invoice grid's price hint, the Masters pricing tabs.
// The scan latency (keydown → line on screen with its price) is read from the screen's
// data-scan-ms / data-scan-seq markers (written in the same commit that shows the priced line).
// A dedicated phase at the end scans on a fresh bill up to LATENCY_ATTEMPTS times and fails when
// no sample arrives or any sample is ≥ 100 ms; the samples taken during the flow are logged. With WP26_SHOTS set, screens are captured in
// both themes there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('29-counter-billing', async (h) => {
  await h.createDemoCompany()
  const page = h.page
  await h.stubDialogs()

  const shotsDir = process.env.WP26_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
  const both = async (name) => {
    await h.shot(name)
    if (!shotsDir) return
    for (const want of ['light', 'dark']) {
      if ((await theme()) !== want) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${want}.png`) })
    }
    if ((await theme()) !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }
  const printShot = async (name, html, width = '100vw') => {
    if (!shotsDir) return
    await page.evaluate(([srcdoc, w]) => {
      const f = document.createElement('iframe')
      f.id = 'e2e-print-preview'
      f.srcdoc = srcdoc
      f.style.cssText = `position:fixed;top:0;left:0;width:${w};height:100vh;z-index:9999;background:#fff;border:0`
      document.body.appendChild(f)
    }, [html, width])
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
    await page.evaluate(() => document.getElementById('e2e-print-preview')?.remove())
  }

  // ---------- setup: barcodes, a GST-inclusive default level, a slab scheme ----------
  const items = await h.invoke('master:stockItems:list')
  const mouse = items.find((i) => i.name === 'Wireless Mouse')
  const notebook = items.find((i) => i.name === 'Notebook Pack')
  assert(mouse && notebook, 'demo items exist')
  const { id: _m, ...mouseData } = mouse
  const { id: _n, ...notebookData } = notebook
  await h.invoke('master:stockItems:update', { id: mouse.id, data: { ...mouseData, barcode: '8901000000011' } })
  await h.invoke('master:stockItems:update', { id: notebook.id, data: { ...notebookData, barcode: '8901000000028' } })
  const level = await h.invoke('master:priceLevels:create', { name: 'Shop MRP', inclusiveOfTax: true, isDefault: true })
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10))
  await h.invoke('pricing:setGridRate', { priceLevelId: level.id, stockItemId: mouse.id, date: '2000-01-01', rate: 94400 }) // ₹944 incl. 18% = ₹800
  await h.invoke('pricing:setGridRate', { priceLevelId: level.id, stockItemId: notebook.id, date: '2000-01-01', rate: 47250 }) // ₹472.50 incl. 5% = ₹450
  await h.invoke('pricing:saveScheme', {
    data: { name: 'Notebooks 2+ 10%', kind: 'qty_slab', appliesTo: 'item', targetId: notebook.id, slabs: [{ minQtyMilli: 2000, discountBp: 1000 }], priority: 1 }
  })
  const daybookCount = async () => (await h.invoke('report:dayBook', { from: today, to: today })).length

  // ---------- Masters › Price lists / Schemes ----------
  await h.goto('masters')
  await h.clickText('Price lists')
  await page.waitForSelector(`[data-testid="input-price-${level.id}-${mouse.id}"]`, { timeout: 10000 })
  assertEq(await page.inputValue(`[data-testid="input-price-${level.id}-${mouse.id}"]`), '944.00', 'the grid shows the level rate')
  await both('01-masters-price-lists')
  await h.clickText('Schemes')
  await page.waitForSelector('[data-testid="rows-masters-schemes"] tr.dt-row', { timeout: 10000 })
  await page.locator('[data-testid="rows-masters-schemes"] tr.dt-row').first().click()
  await page.waitForSelector('[data-testid="scheme-try-it"]', { timeout: 5000 })
  await page.fill('[data-testid="input-scheme-try-qty"]', '3')
  await page.waitForFunction(() => document.querySelector('[data-testid="scheme-try-net"]')?.textContent === '270.00', null, { timeout: 5000 })
  await both('02-scheme-editor-try-it')
  await page.keyboard.press('Escape')

  // ---------- the counter ----------
  const before = await daybookCount()
  await h.goto('counter-billing')
  await page.waitForSelector('[data-testid="input-counter-search"]', { timeout: 10000 })
  await both('03-counter-empty')
  const search = page.locator('[data-testid="input-counter-search"]')
  assert(await search.evaluate((el) => el === document.activeElement), 'the search box has the focus')

  const scanSeq = () => page.evaluate(() => Number(document.querySelector('[data-testid="counter-billing"]')?.getAttribute('data-scan-seq') ?? 0))
  let seqBeforeScan = 0
  const scan = async (code) => {
    seqBeforeScan = await scanSeq()
    // A scanner types the code and Enter in one burst.
    await page.keyboard.type(code, { delay: 5 })
    await page.keyboard.press('Enter')
  }
  /** The latency sample of the last scan, or null when none arrived within `timeout`. */
  const scanSample = async (timeout = 3000) => {
    try {
      await page.waitForFunction(
        (before) => Number(document.querySelector('[data-testid="counter-billing"]')?.getAttribute('data-scan-seq') ?? 0) > before,
        seqBeforeScan,
        { timeout }
      )
    } catch {
      return null
    }
    const ms = Number(await page.getAttribute('[data-testid="counter-billing"]', 'data-scan-ms'))
    return Number.isFinite(ms) ? ms : null
  }
  const flowLatencies = []
  const waitPriced = async (n) => {
    await page.waitForFunction(
      (want) => {
        const rows = [...document.querySelectorAll('[data-testid="counter-line"]')]
        return rows.length === want && rows.every((r) => !r.querySelector('[data-testid="counter-cell-rate"]')?.textContent?.includes('…'))
      },
      n,
      { timeout: 5000 }
    )
    flowLatencies.push(await scanSample())
  }
  await scan('8901000000011')
  await waitPriced(1)
  await scan('8901000000028')
  await waitPriced(2)
  await scan('8901000000028') // the same barcode again: one more on that line
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="counter-line"]')[1]?.querySelector('[data-testid="counter-cell-qty"]')?.textContent?.startsWith('2'), null, { timeout: 5000 })
  // Crossing the slab re-prices the notebook line: the scheme's 10% shows as its source.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="line-price-hint"]')[1]?.textContent === 'Scheme: Notebooks 2+ 10%', null, { timeout: 5000 })
  assertEq(await page.locator('[data-testid="line-price-hint"]').first().textContent(), 'Level: Shop MRP', 'the mouse is priced from the default level')
  assert(await search.evaluate((el) => el === document.activeElement), 'focus is back in the search box after scanning')

  // Keyboard editing: ↑ to the mouse, + to 2, − back to 1.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('+')
  await page.waitForFunction(() => document.querySelector('[data-testid="counter-line"] [data-testid="counter-cell-qty"]')?.textContent?.startsWith('2'), null, { timeout: 3000 })
  await page.keyboard.press('-')
  await page.waitForFunction(() => document.querySelector('[data-testid="counter-line"] [data-testid="counter-cell-qty"]')?.textContent?.startsWith('1'), null, { timeout: 3000 })

  // Mouse ₹800 + 18% = ₹944; notebooks 2 × ₹472.50 = ₹945 less 10% = ₹850.50 incl. → total ₹1,794.50 → ₹1,795 (rounded).
  await page.waitForFunction(() => document.querySelector('[data-testid="counter-total"]')?.textContent === '₹1,795.00', null, { timeout: 5000 })
  await both('04-counter-two-items')

  // Split: F5 cash ₹1,000 (tendered ₹2,000), F6 UPI the rest.
  await page.keyboard.press('F5')
  await page.waitForSelector('[data-testid="input-counter-pay-cash"]', { timeout: 3000 })
  await page.fill('[data-testid="input-counter-pay-cash"]', '1000')
  await page.keyboard.press('F6')
  await page.waitForFunction(() => document.querySelector('[data-testid="input-counter-pay-upi"]')?.value === '795.00', null, { timeout: 3000 })
  await page.fill('[data-testid="input-counter-tendered"]', '2000')
  await page.waitForFunction(() => document.querySelector('[data-testid="counter-change-due"]')?.textContent?.includes('1,000.00'), null, { timeout: 3000 })
  await both('05-counter-split-payment')
  await page.keyboard.press('F9')
  await page.waitForSelector('[data-testid="counter-last-sale"]', { timeout: 10000 })
  assert((await page.textContent('[data-testid="counter-change"]')).includes('1,000.00'), 'the change is shown')
  assertEq(await page.locator('[data-testid="counter-line"]').count(), 0, 'the screen is ready for the next bill')
  await both('06-counter-saved')

  // ---------- the books: an invoice and a receipt against it ----------
  assertEq(await daybookCount(), before + 2, 'the day book has the invoice and the receipt')
  const day = await h.invoke('counter:dayEnd', { date: today })
  assertEq(day.bills, 1, 'one counter bill today')
  const bill = day.invoices[0]
  assertEq(bill.totalPaise, 179_500, 'the invoice totals ₹1,795')
  const inv = await h.invoke('voucher:get', { id: bill.voucherId })
  const rc = await h.invoke('voucher:get', { id: bill.receiptVoucherId })
  const sum = (v, side) => v.lines.filter((l) => l.drCr === side).reduce((s, l) => s + l.amount, 0)
  assertEq(sum(inv, 'dr'), sum(inv, 'cr'), 'the invoice balances')
  assertEq(sum(rc, 'dr'), 179_500, 'the receipt takes ₹1,795')
  assertEq(rc.billRefs.map((b) => `${b.kind}:${b.name}:${b.amount}`).join(), `against:${inv.number}:179500`, 'the receipt is against the invoice')
  assertEq(inv.inventory.map((l) => [l.qtyMilli, l.ratePaise, l.discountPaise, l.amount].join('/')).join(' '), '1000/80000/0/80000 2000/45000/9000/81000', 'inclusive prices backed out exactly; the scheme discount on the notebooks')
  assertEq(day.byMode.map((m) => `${m.mode}:${m.amountPaise}`).join(), 'cash:100000,upi:79500', 'day end by payment mode')

  // Print: the thermal receipt (PDF opened — stubbed) and its HTML.
  await h.click('btn-counter-print')
  // The thermal PDF: an 80 mm page, written to the company's exports folder.
  const { path: pdfPath } = await h.invoke('counter:print', { voucherId: inv.id, templateId: 'receipt-80mm' })
  assert(fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000, `the receipt PDF was written (${pdfPath})`)
  const pdfHead = fs.readFileSync(pdfPath).toString('latin1')
  const box = pdfHead.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/)
  assert(box && Math.abs(Number(box[1]) - (80 / 25.4) * 72) < 2, `the receipt page is 80 mm wide (MediaBox ${box?.[0]})`)
  const { path: a4Path } = await h.invoke('counter:print', { voucherId: inv.id, templateId: 'classic' })
  assert(fs.existsSync(a4Path), 'the A4 invoice PDF was written')
  const { html } = await h.invoke('counter:printHtml', { voucherId: inv.id, templateId: 'receipt-80mm' })
  assert(html.includes('Wireless Mouse') && html.includes('Paid · Cash') && html.includes('1,795.00'), 'the receipt prints the items, the total and the payments')
  await printShot('07-receipt-80mm', html, '80mm')

  await h.goto('daybook')
  // Today's two entries: the counter invoice (Cash sale) and its receipt.
  await page.fill('input[aria-label="Filter rows"]', 'Cash sale')
  await page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${inv.id}"]`, { state: 'attached', timeout: 10000 })
  await page.waitForSelector(`[data-testid="rows-daybook"] [data-row-id="${rc.id}"]`, { state: 'attached', timeout: 10000 })
  await both('08-daybook')

  // Day end.
  await h.goto('counter-billing')
  await page.keyboard.press('F10')
  await page.waitForSelector('[data-testid="counter-day-end"]', { timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="counter-day-end-modes"]')?.textContent?.includes('1,000.00'), null, { timeout: 5000 })
  await both('09-counter-day-end')
  await page.keyboard.press('Escape')

  // Hold a bill (F3) and recall it (F4); the options drawer.
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'input-counter-search', null, { timeout: 3000 })
  await scan('8901000000011')
  await waitPriced(1)
  await page.keyboard.press('F3')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="counter-line"]').length === 0, null, { timeout: 3000 })
  assertEq((await h.invoke('counter:held')).length, 1, 'one bill on hold')
  await page.keyboard.press('F4')
  await page.waitForSelector('[data-testid="rows-counter-held"] tr.dt-row', { timeout: 5000 })
  await both('09b-counter-held')
  await page.locator('[data-testid="rows-counter-held"] tr.dt-row').first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="counter-line"]').length === 1, null, { timeout: 3000 })
  assertEq((await h.invoke('counter:held')).length, 0, 'the recalled bill left the hold list')
  await page.keyboard.press('F12')
  await page.waitForSelector('[data-testid="input-counter-template"]', { timeout: 5000 })
  await both('09c-counter-options')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await search.focus()
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="counter-line"]').length === 0, null, { timeout: 3000 })

  // Masters › Party rates and the party's ledger form (price level + party rates).
  const umbrella = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Umbrella Retail')
  await h.invoke('pricing:savePartyRate', { data: { ledgerId: umbrella.id, stockItemId: mouse.id, ratePaise: 76000, discountBp: 0 } })
  await h.goto('masters')
  await h.clickText('Party rates')
  await page.waitForSelector('[data-testid="rows-masters-party-rates"] tr.dt-row', { timeout: 10000 })
  await both('09d-masters-party-rates')
  await h.invoke('pricing:deletePartyRate', { id: (await h.invoke('pricing:partyRates', { ledgerId: umbrella.id }))[0].id })

  // ---------- the invoice grid's price hint ----------
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  const party = page.locator('[data-testid="picker-party"]')
  await party.click()
  await party.fill('Umbrella Retail')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await party.press('Enter')
  const itemPicker = page.locator('[data-testid="picker-item"]').first()
  await itemPicker.click()
  await itemPicker.fill('Notebook Pack')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await itemPicker.press('Enter')
  const qty = page.locator('[data-testid="input-line-qty"]').first()
  await qty.fill('3')
  await page.waitForFunction(() => document.querySelector('[data-testid="line-price-hint"]')?.textContent === 'Scheme: Notebooks 2+ 10%', null, { timeout: 5000 })
  assertEq(await page.inputValue('[data-testid="input-line-rate"]'), '450.00', 'the invoice backs the taxable rate out of the inclusive level')
  await page.click('[data-testid="line-price-hint"]')
  await page.waitForSelector('[data-testid="line-price-explanation"]', { timeout: 3000 })
  await both('10-invoice-price-hint')
  await page.keyboard.press('Escape')
  // A typed rate is kept and marked manual.
  const rate = page.locator('[data-testid="input-line-rate"]').first()
  await rate.fill('400')
  await qty.fill('4')
  await page.waitForTimeout(300)
  assertEq(await page.inputValue('[data-testid="input-line-rate"]'), '400.00', 'a hand-typed rate is never overridden')
  assertEq(await page.textContent('[data-testid="line-price-hint"]'), 'Manual', 'the line is marked manual')

  // Leave the unsaved invoice through the in-app discard prompt (no window-close dialog).
  await page.click('button:has-text("Cancel")')
  await page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 3000 })
  await h.click('confirm-ok')

  // ---------- latency budget: scans on a fresh bill, each measured ----------
  await h.goto('counter-billing')
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'input-counter-search', null, { timeout: 5000 })
  const LATENCY_ATTEMPTS = 5
  const samples = []
  for (let attempt = 0; attempt < LATENCY_ATTEMPTS && samples.length < 3; attempt++) {
    await search.focus()
    await scan(attempt % 2 === 0 ? '8901000000011' : '8901000000028')
    await waitPriced(1)
    const ms = flowLatencies.pop()
    if (ms != null) samples.push(ms)
    else console.log(`[29] attempt ${attempt + 1}: no latency sample`)
    await search.focus()
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="counter-line"]').length === 0, null, { timeout: 3000 })
  }
  console.log(`[29] scan latencies (ms): flow ${flowLatencies.map((x) => x ?? 'none').join(', ')}; budget ${samples.join(', ')}`)
  assert(samples.length > 0, `a scan latency was measured (no sample in ${LATENCY_ATTEMPTS} attempts)`)
  const worst = Math.max(...samples)
  assert(worst < 100, `each scan shows its priced line in under 100 ms (worst ${worst} ms)`)
})
