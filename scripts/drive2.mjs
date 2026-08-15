// Pass 2: purchase voucher, receipt voucher, then report checks.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = '/Users/irmin/total-t'
const SHOTS = '/private/tmp/claude-501/-Users-irmin-total-t/0434fe82-7dc5-4778-8cdc-ba2b98437f00/scratchpad/shots'
fs.mkdirSync(SHOTS, { recursive: true })

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
  await sleep(400)
}
const focusPlaceholder = async (ph, idx = 0) => {
  const ok = await page.evaluate(({ ph, idx }) => {
    const inputs = [...document.querySelectorAll('input')].filter((i) => i.placeholder === ph)
    if (!inputs[idx]) return 'NOT_FOUND'
    inputs[idx].focus()
    return 'OK'
  }, { ph, idx })
  console.log('focus', ph, idx, ok)
}

try {
  await clickText('Demo Traders')
  await sleep(1200)

  // ---- Purchase: 5 laptops @ 40,000 from Bulk Suppliers ----
  await clickText('Voucher entry')
  await sleep(500)
  await clickText('Purchase')
  await sleep(400)
  await focusPlaceholder('Party ledger')
  await page.keyboard.type('Bulk Suppliers', { delay: 12 })
  await sleep(450)
  await page.keyboard.press('Enter') // create option
  await sleep(600)
  await clickText('Create ledger')
  await sleep(700)
  await focusPlaceholder('e.g. Purchases')
  await page.keyboard.type('Purchases', { delay: 12 })
  await sleep(450)
  await page.keyboard.press('Enter')
  await sleep(600)
  const modalOpen = await page.evaluate(() => document.body.innerText.includes('New ledger'))
  if (modalOpen) {
    await clickText('Create ledger')
    await sleep(700)
  }
  await focusPlaceholder('Stock item')
  await page.keyboard.type('Laptop', { delay: 15 })
  await sleep(500)
  await page.keyboard.press('Enter') // pick existing Laptop 14"
  await sleep(400)
  await focusPlaceholder('0')
  await page.keyboard.type('5', { delay: 10 })
  await focusPlaceholder('0.00')
  await page.keyboard.type('40000', { delay: 10 })
  await page.keyboard.press('Tab')
  await sleep(400)
  await shot('20-purchase')
  await page.keyboard.press('Meta+Enter')
  await sleep(1000)
  await shot('21-purchase-saved')

  // ---- Receipt: Cash 50,000 from Umbrella Retail ----
  await clickText('Receipt')
  await sleep(500)
  await focusPlaceholder('Ledger', 0)
  await page.keyboard.type('Cash', { delay: 15 })
  await sleep(450)
  await page.keyboard.press('Enter')
  await sleep(300)
  await focusPlaceholder('0.00', 0)
  await page.keyboard.type('50000', { delay: 10 })
  await focusPlaceholder('Ledger', 1)
  await page.keyboard.type('Umbrella', { delay: 15 })
  await sleep(450)
  await page.keyboard.press('Enter')
  await sleep(300)
  await focusPlaceholder('0.00', 1)
  await page.keyboard.type('50000', { delay: 10 })
  await page.keyboard.press('Tab')
  await sleep(300)
  await shot('22-receipt')
  await page.keyboard.press('Meta+Enter')
  await sleep(1000)

  // ---- Reports ----
  await clickText('Day book')
  await sleep(800)
  await shot('23-daybook')
  await clickText('Trial balance')
  await sleep(800)
  await shot('24-trial-balance')
  await clickText('Profit & Loss')
  await sleep(800)
  await shot('25-pnl')
  await clickText('Stock summary')
  await sleep(800)
  await shot('26-stock')
  await clickText('GSTR-3B')
  await sleep(900)
  await shot('27-gstr3b')
  await clickText('Gateway')
  await sleep(900)
  await shot('28-gateway')
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
  await shot('99-error2')
} finally {
  await app.close()
}
