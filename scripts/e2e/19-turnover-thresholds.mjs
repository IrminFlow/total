// Scenario 19 — one declared number drives every GST threshold.
//
// Almost every obligation in GST keys off aggregate annual turnover, and the app knew none of
// them: it accepted a 4-digit HSN from a ₹50-crore business, let anyone pick QRMP, and never
// mentioned that e-invoicing is mandatory above ₹5 crore. This asserts that declaring the band
// in Company details changes what gst:validate says, and that leaving it undeclared says nothing.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('19-turnover-thresholds', async (h) => {
  await h.createDemoCompany()

  const today = new Date()
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const from = `${y}-${m}-01`
  const to = `${y}-${m}-${String(new Date(Date.UTC(y, today.getMonth() + 1, 0)).getUTCDate())}`

  const codesFor = async () => {
    const v = await h.invoke('gst:validate', { from, to })
    return v.issues.map((i) => i.code)
  }

  const setBand = async (band) => {
    await h.page.keyboard.press('Escape')
    await h.page.keyboard.press('g')
    await h.waitScreen('gateway')
    await h.page.keyboard.press('Control+k')
    await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
    await h.page.fill('[data-testid="input-palette"]', 'company details')
    await h.page.keyboard.press('Enter')
    await h.waitScreen('company-info')
    await h.page.selectOption('[data-testid="select-turnover-band"]', band)
    await h.click('btn-company-info-save')
    await h.page.waitForSelector('[data-testid="select-turnover-band"]', { timeout: 10000 })
  }

  // ---- the demo band (₹1.5cr–₹5cr) is under both lines ----
  const small = await codesFor()
  assert(!small.includes('hsn_too_short'), 'a 4-digit HSN is fine under ₹5 crore')
  assert(!small.includes('missing_irn'), 'e-invoicing is optional under ₹5 crore')

  // ---- undeclared says nothing at all, rather than guessing ----
  await setBand('')
  const undeclared = await codesFor()
  assert(!undeclared.includes('hsn_too_short'), 'no HSN-length claim without a declared band')
  assert(!undeclared.includes('missing_irn'), 'no e-invoice claim without a declared band')
  // The rest of the validation is unaffected by the band.
  assert(Array.isArray(undeclared), 'gst:validate still answers')

  // ---- over ₹5 crore, both obligations appear ----
  await setBand('5Cr-plus')
  const big = await codesFor()
  assert(big.includes('hsn_too_short'), 'rule 46 wants 6 HSN digits over ₹5 crore')
  assert(big.includes('missing_irn'), 'e-invoicing is mandatory over ₹5 crore')

  const v = await h.invoke('gst:validate', { from, to })
  for (const code of ['hsn_too_short', 'missing_irn']) {
    const issue = v.issues.find((i) => i.code === code)
    // Warnings, not blocks: neither is fixed by refusing to export a return that is still due.
    assert(issue.severity === 'warning', `${code} warns rather than blocks`)
    assert(issue.voucherIds.length > 0, `${code} names the vouchers to fix`)
  }
  await h.shot('01-over-5cr')

  // ---- the obligations are stated where the band is declared ----
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway')
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-palette"]', 'company details')
  await h.page.keyboard.press('Enter')
  await h.waitScreen('company-info')
  const text = await h.page.textContent('[data-testid="turnover-obligations"]')
  assert(/e-Invoicing is mandatory/.test(text), 'the panel names the e-invoice obligation')
  assert(/6 HSN digits/.test(text), 'the panel names the HSN digit requirement')
  assert(/QRMP is not available/.test(text), 'the panel says QRMP is out of reach')
  await h.shot('02-obligations')
})
