// Scenario 14 — books search: ⌘K palette search by amount (Indian-grouped, amt: token → chip)
// and open the voucher; ⌘⇧F results screen search by GSTIN and open the ledger statement;
// "See all" from the palette into a paged kind tab; recent searches / recently opened records
// on an empty palette. Screenshots of palette + results in both themes.
import { scenario, assert } from '../lib/harness.mjs'

/** Paise → Indian-grouped whole rupees ("1,40,506") — test-side formatting only. */
function indian(paise) {
  const whole = String(Math.floor(paise / 100))
  if (whole.length <= 3) return whole
  return whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
}

/** Theme for screenshots. Applied straight to [data-theme] (what the tokens key off) because the
 *  header toggle sits behind the palette overlay; scenario 12 covers the toggle itself. */
async function setTheme(h, theme) {
  await h.page.evaluate((t) => {
    document.documentElement.dataset.theme = t
  }, theme)
  await h.page.waitForTimeout(400) // let colour transitions settle before a screenshot
}

await scenario('14-search', async (h) => {
  await h.createDemoCompany()
  await setTheme(h, 'light')

  // Pick a real demo sales voucher with a whole-rupee total so the amount is typeable.
  const sales = await h.invoke('search:query', { q: 'type:sales', limitPerKind: 50 })
  const target = sales.vouchers.rows.find((r) => r.amount % 100 === 0) ?? sales.vouchers.rows[0]
  assert(target, 'demo company has sales vouchers')
  const amountText = indian(target.amount)

  // ---- palette: search by amount, chip shows, open the voucher ----
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-palette"]', `amt:${amountText}`)
  await h.page.waitForSelector('[data-testid="palette-chips"] [data-chip="amount"]', { timeout: 10000 })
  const chip = await h.page.textContent('[data-testid="palette-chips"] [data-chip="amount"]')
  assert(chip.includes(`₹${amountText}`), `amount chip reads "Amount ₹${amountText}" (got ${chip})`)
  await h.page.waitForSelector(`[data-testid="palette-hit-voucher-${target.id}"]`, { timeout: 10000 })
  const ledgerHits = await h.page.$$('[data-testid^="palette-hit-ledger-"]')
  assert(ledgerHits.length === 0, 'an amount filter returns vouchers only')
  await h.shot('01-palette-amount-light')
  await setTheme(h, 'dark')
  await h.shot('02-palette-amount-dark')
  await h.page.click(`[data-testid="palette-hit-voucher-${target.id}"]`)
  await h.waitScreen('voucher-entry', 20000)
  await h.shot('03-voucher-opened')

  // ---- ⌘⇧F results screen: search by GSTIN, open the ledger ----
  await h.page.keyboard.press('Control+Shift+F')
  await h.waitScreen('search', 15000)
  await h.page.fill('[data-testid="input-search"]', 'gstin:29AABCF9012G1ZQ')
  await h.page.waitForSelector('[data-testid="rows-search-ledgers"] tr', { timeout: 10000 })
  const ledgerRow = await h.page.textContent('[data-testid="rows-search-ledgers"]')
  assert(ledgerRow.includes('Krishna Enterprises'), 'GSTIN search finds Krishna Enterprises')
  await h.page.waitForSelector('[data-testid="search-chips"] [data-chip="gstin"]', { timeout: 10000 })
  await h.waitIdle()
  await h.shot('04-results-gstin-dark')
  await setTheme(h, 'light')
  await h.shot('05-results-gstin-light')
  // Keyboard: ↓ from the query box hands focus to the rows; ↵ opens the active (first) row.
  await h.page.focus('[data-testid="input-search"]')
  await h.page.keyboard.press('ArrowDown')
  await h.page.keyboard.press('Enter')
  await h.waitScreen('ledger-statement', 20000)
  await h.shot('06-ledger-statement')

  // ---- palette "See all" → paged voucher tab ----
  const fy = await h.page.evaluate(() => {
    const d = new Date()
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  })
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-palette"]', `fy:${fy}`)
  await h.page.waitForSelector('[data-testid="palette-see-all-voucher"]', { timeout: 10000 })
  await h.shot('07-palette-see-all-light')
  await h.page.click('[data-testid="palette-see-all-voucher"]')
  await h.waitScreen('search', 15000)
  await h.page.waitForSelector('[data-testid="rows-search-vouchers"] tr', { timeout: 10000 })
  const tab = await h.page.getAttribute('[data-testid="tab-search-voucher"]', 'aria-current')
  assert(tab === 'page', 'See all lands on the Vouchers tab')
  const shown = (await h.page.$$('[data-testid="rows-search-vouchers"] tr')).length
  assert(shown > 20, `the kind tab shows more than the palette's 20 (${shown})`)
  await h.shot('08-results-vouchers-light')
  await setTheme(h, 'dark')
  await h.shot('09-results-vouchers-dark')

  // ---- empty palette: recents ----
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="palette-recent-query"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="palette-recent-ledger"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="palette-recent-voucher"]', { timeout: 10000 })
  const recentText = await h.page.textContent('[data-testid="palette-section-recent-r"]')
  assert(recentText.includes('Krishna Enterprises'), 'recently opened ledger is listed')
  await h.shot('10-palette-recents-dark')
  await setTheme(h, 'light')
  await h.shot('11-palette-recents-light')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="input-palette"]', { state: 'detached', timeout: 10000 })
})
