// Scenario 08 — year-end close: preview shows the P&L transfer, posting the close keeps the
// TB tied and the year-end screen renders afterwards.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('08-year-end', async (h) => {
  // yearend:close refuses a FY that hasn't ended, so the books must START in the PREVIOUS
  // FY — the create modal defaults to the current one, so create over IPC with booksFrom
  // set back a year, then open through the picker.
  const now = new Date()
  const currentFyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const fyStartYear = currentFyStart - 1
  await h.invoke('company:create', {
    name: 'YearEnd Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered',
    address: '', booksFrom: fyStartYear, email: null, phone: null, pan: null, tan: null
  })
  await h.relaunch()
  const where = await h.openCompany('YearEnd Co')
  if (where !== 'gateway') throw new Error(`expected gateway, got ${where}`)

  // One sale so the FY has a profit to transfer.
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const groups = await h.invoke('master:groups:list')
  const salesGroup = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'YE Sales', groupId: salesGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const yeSales = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'YE Sales')
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')

  const inFy = `${fyStartYear}-06-15`
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: inFy, partyLedgerId: null,
      narration: 'FY sale', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 777700 },
        { ledgerId: yeSales.id, drCr: 'cr', amount: 777700 }
      ],
      inventory: []
    }
  })

  const preview = await h.invoke('yearend:preview', { fyStartYear })
  assert(preview && typeof preview === 'object', 'yearend:preview answers')
  const previewText = JSON.stringify(preview)
  assert(previewText.includes('7777') || previewText.includes('777700'), 'preview reflects the FY profit')

  await h.goto('year-end')
  await h.shot('01-year-end-preview')

  // Close through the wizard (the year-end screen opens on the last completed FY).
  const page = h.page
  await page.getByRole('button', { name: 'Next: review journal' }).click()
  await page.getByRole('button', { name: 'Next: confirm' }).click()
  await h.fill('input-year-end-confirm', 'CLOSE')
  await h.click('btn-year-end-post')
  await page.waitForSelector('[data-testid="btn-year-end-open-entry"]', { timeout: 20000 })
  const fyFrom = `${fyStartYear}-04-01`
  assertEq((await h.invoke('company:lock:get')).date, `${fyStartYear + 1}-03-31`, 'the close locks the books up to its own date')
  assert((await h.invoke('yearend:preview', { fyStartYear })).alreadyClosed, 'the year is closed')

  // Books still tie across the FY boundary.
  const fyEnd = `${fyStartYear + 1}-03-31`
  const tb = await h.invoke('report:trialBalance', { asOn: fyEnd })
  assertEq(tb.totalDebit, tb.totalCredit, 'TB ties after year-end close')

  await h.shot('02-year-end-after-close')

  // The closing entry is read-only; its banner's Move to Bin reopens the year. The bin refuses an
  // entry inside the lock, so the button moves the close's own lock back to the day before the FY.
  await h.click('btn-year-end-open-entry')
  await h.waitScreen('voucher-entry')
  await page.waitForSelector('[data-testid="year-end-close-banner"]')
  assert(await page.locator('[data-testid="voucher-entry-mode"]').evaluate((el) => !!el.closest('fieldset')?.disabled), 'the closing entry stays read-only')
  await h.click('btn-year-end-close-bin')
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  assert((await dialog.textContent()).includes('lock moves back'), 'the confirm says the lock moves')
  await dialog.getByRole('button', { name: 'Move to Bin' }).click()
  await page.waitForSelector('[data-testid="year-end-close-banner"]', { state: 'detached', timeout: 15000 })
  const lockAfter = (await h.invoke('company:lock:get')).date
  const dayBefore = new Date(Date.UTC(fyStartYear, 3, 0)).toISOString().slice(0, 10)
  assertEq(lockAfter, dayBefore, `lock moved back to the day before ${fyFrom}`)
  assert(!(await h.invoke('yearend:preview', { fyStartYear })).alreadyClosed, 'binning the closing entry reopens the year')
  const tbAfter = await h.invoke('report:trialBalance', { asOn: fyEnd })
  assertEq(tbAfter.totalDebit, tbAfter.totalCredit, 'TB ties after the year reopens')
  await h.goto('gateway')
  await h.goto('year-end')
  await h.shot('03-year-end-reopened')
})
