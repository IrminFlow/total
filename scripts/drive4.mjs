// Pass 4: light theme + new screens (registers, outstandings, banking, edocs) + invoice PDF.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = '/Users/irmin/total-t'
const SHOTS = '/private/tmp/claude-501/-Users-irmin-total-t/0434fe82-7dc5-4778-8cdc-ba2b98437f00/scratchpad/shots'

const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], timeout: 30000 })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await new Promise((r) => setTimeout(r, 1500))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') })
  console.log('shot:', name)
}
const clickText = async (text) => {
  const r = await page.evaluate((t) => {
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
    const rows = [...document.querySelectorAll('div.kbar-row, div[class*="cursor-pointer"]')]
    const el =
      buttons.find((e) => e.textContent?.trim() === t) ??
      rows.find((e) => e.textContent?.includes(t)) ??
      buttons.find((e) => e.textContent?.includes(t))
    if (!el) return 'NOT_FOUND'
    el.click()
    return 'OK'
  }, text)
  console.log('click', JSON.stringify(text), r)
  await sleep(500)
}

try {
  await page.evaluate(() => localStorage.setItem('total-theme', 'light'))
  await shot('40-company-select-light')
  await clickText('Demo Traders')
  await sleep(1200)
  await shot('41-gateway-light')
  await clickText('Registers')
  await sleep(700)
  await shot('42-registers')
  await clickText('Outstandings')
  await sleep(700)
  await clickText('Umbrella Retail')
  await sleep(300)
  await shot('43-outstandings')
  await clickText('Reconciliation')
  await sleep(700)
  await shot('44-banking')
  await clickText('e-Invoice & e-Way')
  await sleep(700)
  await shot('45-edocs')
  await clickText('Voucher entry')
  await sleep(600)
  await clickText('Sales')
  await sleep(400)
  await shot('46-voucher-light')
  // dark toggle check
  await clickText('Dark')
  await sleep(400)
  await shot('47-voucher-dark')
  await clickText('Light')
  await sleep(300)
  // invoice PDF for voucher 1 (sales)
  const daybook = await page.evaluate(async () => {
    return await window.total.invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })
  })
  const sales = daybook.data.find((v) => v.kind === 'sales')
  if (sales) {
    const res = await page.evaluate(async (id) => await window.total.invoke('invoice:pdf', { voucherId: id }), sales.id)
    console.log('PDF:', JSON.stringify(res))
  }
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
  await shot('99-error4')
} finally {
  await app.close()
}
