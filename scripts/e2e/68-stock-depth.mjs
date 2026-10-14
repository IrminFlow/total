// Scenario 68 — stock depth on the demo company (WP 1.4 editor round trip for the physical stock
// voucher + WP 2.3 stock reports; 19-stock covers transfers, serials and the reorder report):
//   1. A physical stock count typed in its own editor (Voucher entry → Physical Stock): 10 bought
//      at ₹50, counted 7 → the Stock summary shows 7 and ₹350 (the shortfall at average cost).
//   2. Reopened from the Day book, re-counted 9 → the change lands (9, ₹450); opened again and
//      saved UNCHANGED → voucher:get is identical (round trip; only updatedAt may move).
//   3. Valuation method: an item bought 10 @ ₹100 then 10 @ ₹160 with 12 sold is ₹1,040 at
//      weighted average (8 × 130); switched to FIFO in Masters (item form) it is ₹1,280 (8 × 160).
//   4. Stock reports → Ageing (working period set to "This month", so as on today): an item with
//      5 in at the FY start, 3 in today and 2 out shows its 6 on hand aged newest-lot-first,
//      bucket by bucket.
//   5. Stock reports → Negative stock (the link to Exceptions): an item sold before it was bought
//      is listed with its closing quantity; buying it back clears it.
//   6. Barcode labels → Print writes a real PDF into the company's exports folder.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq, PICKER_OPTION, localToday, fyStartOf, fyStartYearOf } from '../lib/harness.mjs'

/** Every file under `dir` (recursive). */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  )
}

const DAY_MS = 86_400_000
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The app's display date (toDisplayDate): 14-Oct-26. */
const displayDate = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`

await scenario('68-stock-depth', async (h) => {
  await h.createDemoCompany()
  const page = h.page
  const today = localToday()
  const fyStart = fyStartOf()
  const fyEnd = `${fyStartYearOf() + 1}-03-31`

  const unit = (await h.invoke('master:units:list')).find((u) => u.decimals === 0)
  assert(unit, 'a whole-number unit')
  const mkItem = (name, extra = {}) =>
    h.invoke('master:stockItems:create', {
      name, groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, ...extra
    })
  const ledgers = await h.invoke('master:ledgers:list')
  const groups = await h.invoke('master:groups:list')
  const inGroup = (name) => ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === name)
  const creditor = inGroup('Sundry Creditors')
  const debtor = inGroup('Sundry Debtors')
  const purchaseAcc = inGroup('Purchase Accounts')
  const salesAcc = inGroup('Sales Accounts')
  assert(creditor && debtor && purchaseAcc && salesAcc, 'demo parties and trading ledgers')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const blank = {
    partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
  }
  const buy = (item, qty, rate, date = today) =>
    h.invoke('voucher:save', {
      data: {
        ...blank, voucherTypeId: typeOf('purchase').id, date, partyLedgerId: creditor.id, narration: `E2E buy ${item.name}`,
        lines: [
          { ledgerId: creditor.id, drCr: 'cr', amount: qty * rate },
          { ledgerId: purchaseAcc.id, drCr: 'dr', amount: qty * rate }
        ],
        inventory: [{ stockItemId: item.id, godownId: null, qtyMilli: qty * 1000, ratePaise: rate, amount: qty * rate, direction: 'in' }]
      }
    })
  const sell = (item, qty, rate, date = today) =>
    h.invoke('voucher:save', {
      data: {
        ...blank, voucherTypeId: typeOf('sales').id, date, partyLedgerId: debtor.id, narration: `E2E sell ${item.name}`,
        lines: [
          { ledgerId: debtor.id, drCr: 'dr', amount: qty * rate },
          { ledgerId: salesAcc.id, drCr: 'cr', amount: qty * rate }
        ],
        inventory: [{ stockItemId: item.id, godownId: null, qtyMilli: qty * 1000, ratePaise: rate, amount: qty * rate, direction: 'out' }]
      }
    })
  /** A DataTable cell's text by its column id (header order = cell order); null = not rendered. */
  const cellText = (area, rowId, colId) =>
    page.evaluate(([a, r, c]) => {
      const tbody = document.querySelector(`[data-testid="rows-${a}"]`)
      const ths = [...(tbody?.closest('table')?.querySelectorAll('thead tr:last-child th') ?? [])]
      const idx = ths.findIndex((th) => th.getAttribute('data-col') === c)
      const tr = tbody?.querySelector(`[data-row-id="${r}"]`)
      return idx >= 0 && tr ? (tr.children[idx]?.textContent ?? '').trim() : null
    }, [area, rowId, colId])
  /** Wait until that cell reads `expected` ('–' exactly, else as a prefix). */
  const waitCell = async (area, rowId, colId, expected, label) => {
    await page
      .waitForFunction(
        ([a, r, c, e]) => {
          const tbody = document.querySelector(`[data-testid="rows-${a}"]`)
          const ths = [...(tbody?.closest('table')?.querySelectorAll('thead tr:last-child th') ?? [])]
          const idx = ths.findIndex((th) => th.getAttribute('data-col') === c)
          const tr = tbody?.querySelector(`[data-row-id="${r}"]`)
          const text = idx >= 0 && tr ? (tr.children[idx]?.textContent ?? '').trim() : null
          return text != null && (e === '–' ? text === e : text.startsWith(e))
        },
        [area, rowId, colId, expected],
        { timeout: 10000 }
      )
      .catch(async () => {
        throw new Error(`${label}: ${area} row ${rowId} column ${colId} — expected "${expected}…", got ${JSON.stringify(await cellText(area, rowId, colId))}`)
      })
  }

  // ---------- 1. physical stock count through its editor ----------
  // Every item up front: screens cache the item list, and an IPC-created master doesn't refresh it.
  const counted = await mkItem('E2E Counted')
  const fifo = await mkItem('E2E Layers')
  const aged = await mkItem('E2E Aged', { barcode: 'AGE-0068' })
  const short = await mkItem('E2E Short')
  await buy(counted, 10, 5000) // 10 @ ₹50 = ₹500
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-physical_stock')
  await page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="physical"]', { timeout: 10000 })
  const itemPicker = page.locator('[data-testid="rows-physical-lines"] [data-testid="picker-item"]').first()
  await itemPicker.click()
  await itemPicker.fill('E2E Counted')
  await page.waitForSelector(PICKER_OPTION, { timeout: 5000 })
  await itemPicker.press('Enter')
  await page.locator('[data-testid="input-counted-qty"]').first().fill('7')
  // Book 10, counted 7 → −3 in the difference column.
  await page.waitForFunction(() => document.querySelector('[data-testid="rows-physical-lines"]')?.textContent?.includes('-3'), null, { timeout: 10000 })
  await page.fill('input[placeholder="Being physical stock verified…"]', 'E2E stock count')
  await h.shot('01-physical-count')
  await h.click('btn-save-physical')
  await page.waitForFunction(() => /Physical stock .+ saved — 1 item counted/.test(document.body.innerText), null, { timeout: 10000 })
  const counts = await h.invoke('voucher:list', { from: today, to: today, voucherTypeId: typeOf('physical_stock').id })
  assertEq(counts.length, 1, 'one physical stock voucher saved')
  const countId = counts[0].id
  const v1 = await h.invoke('voucher:get', { id: countId })
  assertEq(v1.inventory.length, 1, 'the count has one line')
  assertEq(v1.inventory[0].stockItemId, counted.id, 'counted item')
  assertEq(v1.inventory[0].qtyMilli, 7000, 'counted quantity stored as the absolute level')
  assertEq(v1.inventory[0].isAbsolute, true, 'a physical-count line')
  assertEq(v1.lines.length, 0, 'a physical count posts no ledger lines')
  assertEq(v1.narration, 'E2E stock count', 'narration saved')

  await h.goto('stock-summary')
  await waitCell('stock-summary', counted.id, 'closingQty', '7', 'closing quantity = the count')
  await waitCell('stock-summary', counted.id, 'closingValue', '350.00', 'closing value = 7 × ₹50 average cost')
  await h.shot('02-stock-summary-counted')

  // ---------- 2. reopen from the Day book, re-count, then an unchanged round trip ----------
  const openFromDaybook = async (id) => {
    await h.goto('gateway')
    await h.goto('daybook')
    await page.click(`[data-testid="rows-daybook"] [data-row-id="${id}"]`, { timeout: 10000 })
    await h.waitScreen('voucher-entry')
    await page.waitForSelector('[data-testid="voucher-entry-mode"][data-mode="physical"]', { timeout: 10000 })
  }
  await openFromDaybook(countId)
  const countInput = page.locator('[data-testid="input-counted-qty"]').first()
  assertEq(await countInput.inputValue(), '7', 'the reopened count shows 7')
  await countInput.fill('9')
  await h.click('btn-save-physical')
  await h.waitScreen('daybook')
  const v2 = await h.invoke('voucher:get', { id: countId })
  assertEq(v2.number, v1.number, 'the alteration keeps the number')
  assertEq(v2.inventory[0].qtyMilli, 9000, 'the re-count landed')
  assertEq(v2.narration, 'E2E stock count', 'narration kept')
  const s2 = (await h.invoke('stock:summary', { asOn: today })).find((r) => r.stockItemId === counted.id)
  assertEq(s2.closingQtyMilli, 9000, 'stock follows the re-count')
  assertEq(s2.closingValue, 45000, '9 × ₹50 (the 2 found back at average cost)')

  await openFromDaybook(countId)
  assertEq(await page.locator('[data-testid="input-counted-qty"]').first().inputValue(), '9', 'the re-count reopens as 9')
  await h.shot('03-physical-reopened')
  await h.click('btn-save-physical')
  await h.waitScreen('daybook')
  const v3 = await h.invoke('voucher:get', { id: countId })
  // Every stored field must survive; only updatedAt and the line ROW ids move (a save rewrites the
  // lines — lineUid is the line's stable identity and is compared).
  const stable = ({ updatedAt: _u, lines, inventory, ...v }) =>
    JSON.stringify({ ...v, lines: lines.map(({ id: _i, ...l }) => l), inventory: inventory.map(({ id: _i, ...l }) => l) })
  assertEq(stable(v3), stable(v2), 'an unchanged save leaves the stored voucher identical')
  await h.goto('stock-summary')
  await waitCell('stock-summary', counted.id, 'closingQty', '9', 'stock summary after the round trip')
  await waitCell('stock-summary', counted.id, 'closingValue', '450.00', 'value after the round trip')

  // ---------- 3. weighted average → FIFO in the item form ----------
  await buy(fifo, 10, 10000) // 10 @ ₹100
  await buy(fifo, 10, 16000) // 10 @ ₹160
  await sell(fifo, 12, 20000) // 12 out
  // Weighted average: 20 on hand at ₹130 when the 12 go → 8 × 130 = ₹1,040.
  // FIFO: the 12 take all 10 @ 100 + 2 @ 160 → 8 @ 160 = ₹1,280 left.
  await h.goto('gateway')
  await h.goto('stock-summary')
  await waitCell('stock-summary', fifo.id, 'closingQty', '8', 'FIFO item: 8 on hand')
  await waitCell('stock-summary', fifo.id, 'closingValue', '1,040.00', 'weighted average 8 × ₹130')
  await h.goto('masters')
  await h.click('tab-masters-items')
  await page.click(`[data-testid="rows-masters-items"] [data-row-id="${fifo.id}"]`, { clickCount: 2 })
  await page.waitForSelector('[data-testid="input-item-valuation"]', { timeout: 10000 })
  assertEq(await page.inputValue('[data-testid="input-item-valuation"]'), 'weighted_avg', 'items start on weighted average')
  await page.selectOption('[data-testid="input-item-valuation"]', 'fifo')
  await h.shot('04-item-fifo')
  await h.click('btn-item-save')
  await page.waitForSelector('[data-testid="btn-item-save"]', { state: 'detached', timeout: 10000 })
  assertEq((await h.invoke('master:stockItems:list')).find((i) => i.id === fifo.id).valuationMethod, 'fifo', 'saved as FIFO')
  await h.goto('stock-summary')
  await waitCell('stock-summary', fifo.id, 'closingValue', '1,280.00', 'FIFO 8 × ₹160')
  const sFifo = (await h.invoke('stock:summary', { asOn: today })).find((r) => r.stockItemId === fifo.id)
  assertEq(sFifo.closingValue, 128000, 'stock:summary agrees with the screen')
  await h.shot('05-stock-summary-fifo')

  // ---------- 4. stock ageing ----------
  await buy(aged, 5, 1000, fyStart)
  await buy(aged, 3, 1000, today)
  await sell(aged, 2, 1500, today)
  // 6 on hand, newest lot first: 3 from today's lot, 3 from the FY-start lot (one lot when today
  // IS the FY start). The tab ages as on the working period's END, so the period is set to
  // "This month" (ends today) first — as on 31 Mar every lot bought so far reads 90+ days.
  const bucketOf = (date) => {
    const age = Math.max(0, days(date, today))
    return age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3
  }
  const expected = [0, 0, 0, 0]
  expected[bucketOf(today)] += 3
  expected[bucketOf(fyStart)] += 3
  // Stock reports has no sidebar entry — reached from the Stock summary's header.
  await h.goto('stock-summary')
  await h.click('btn-period')
  await page.locator('[role="dialog"]').getByRole('button', { name: 'This month' }).click()
  await h.click('btn-apply-period')
  await h.click('btn-stock-summary-reorder')
  await h.waitScreen('stock-reports')
  await h.click('tab-stock-reports-ageing')
  await page.waitForFunction((d) => document.querySelector('[data-screen="stock-reports"]')?.textContent?.includes(`as on ${d}`), displayDate(today), { timeout: 10000 })
  await page.waitForSelector(`[data-testid="rows-stock-reports-ageing"] [data-row-id="${aged.id}"]`, { timeout: 10000 })
  await waitCell('stock-reports-ageing', aged.id, 'closing', '6', 'ageing closing quantity')
  for (const [i, q] of expected.entries()) {
    await waitCell('stock-reports-ageing', aged.id, `b${i}`, q === 0 ? '–' : `${q} `, `ageing bucket b${i}`)
  }
  await h.shot('06-stock-ageing')

  // ---------- 5. negative stock (Stock reports → Exceptions) ----------
  await sell(short, 3, 1000)
  await h.click('btn-stock-reports-negative')
  await h.waitScreen('exceptions')
  const toggle = '[data-testid="exceptions-toggle-negativeStock"]'
  await page.waitForSelector(toggle, { timeout: 10000 })
  if ((await page.getAttribute(toggle, 'aria-expanded')) !== 'true') await page.click(toggle)
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="rows-exceptions-negativeStock"] tr')].some((tr) => tr.textContent?.includes('E2E Short')),
    null,
    { timeout: 10000 }
  )
  const negText = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="rows-exceptions-negativeStock"] tr')].map((tr) => tr.textContent ?? '').find((t) => t.includes('E2E Short'))
  )
  assert(negText.includes(`Closing quantity -3 ${unit.symbol}`), `negative stock row shows −3 (row: ${negText})`)
  const exc = await h.invoke('report:exceptions', { from: fyStart, to: fyEnd })
  assert(exc.sections.find((s) => s.key === 'negativeStock').rows.some((r) => r.stockItemId === short.id), 'report:exceptions lists the item')
  await h.shot('07-negative-stock')
  // Buy the 3 back: no longer negative.
  await buy(short, 3, 800)
  await h.goto('gateway')
  await h.goto('exceptions')
  await page.waitForSelector(toggle, { timeout: 10000 })
  await page.waitForFunction(() => !document.body.innerText.includes('E2E Short'), null, { timeout: 10000 })
  const exc2 = await h.invoke('report:exceptions', { from: fyStart, to: fyEnd })
  assert(!exc2.sections.find((s) => s.key === 'negativeStock').rows.some((r) => r.stockItemId === short.id), 'cleared once bought back')

  // ---------- 6. barcode labels → PDF ----------
  await h.stubDialogs()
  await h.goto('stock-summary')
  await h.click('btn-stock-summary-labels')
  await h.waitScreen('stock-reports')
  await h.fill(`input-labels-copies-${aged.id}`, '4')
  await page.waitForSelector('[data-testid="labels-preview"] iframe', { timeout: 10000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-testid="labels-preview"] iframe')
    return (f?.getAttribute('srcdoc') ?? f?.contentDocument?.body?.innerHTML ?? '').includes('AGE-0068')
  }, null, { timeout: 10000 })
  await h.click('btn-labels-print')
  await page.waitForFunction(() => /Labels saved — barcode-labels-.+\.pdf/.test(document.body.innerText), null, { timeout: 30000 })
  const pdfs = walk(h.dataDir).filter((f) => /^barcode-labels-.+\.pdf$/.test(path.basename(f)))
  assertEq(pdfs.length, 1, 'one labels PDF written')
  assert(pdfs[0].includes(`${path.sep}exports${path.sep}`), `written into the company's exports folder (${pdfs[0]})`)
  assertEq(path.basename(pdfs[0]), `barcode-labels-${today}.pdf`, 'named after the as-on date (the period end = today)')
  const bytes = fs.readFileSync(pdfs[0])
  assertEq(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the file is a PDF')
  assert(bytes.length > 1000, `the PDF has content (${bytes.length} bytes)`)
  await page.waitForTimeout(300)
  await h.shot('08-labels-printed')
  await h.goto('gateway')
})
