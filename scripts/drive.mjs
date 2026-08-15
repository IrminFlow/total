// One-shot driver: launch Total, walk company creation → voucher → reports, screenshot each step.
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

const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') })
  console.log('shot:', name)
}
const clickText = async (text) => {
  const r = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')]
    const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
    if (!el) return 'NOT_FOUND'
    el.click()
    return 'OK'
  }, text)
  console.log('click', JSON.stringify(text), r)
  await new Promise((r) => setTimeout(r, 400))
}

try {
  await shot('01-company-select')

  const hasDemo = await page.evaluate(() => document.body.innerText.includes('Demo Traders'))
  if (!hasDemo) {
    await clickText('Create company')
    await shot('02-create-modal')
    await page.keyboard.type('Demo Traders', { delay: 15 })
    // GSTIN field
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')]
      const g = inputs.find((i) => i.placeholder?.includes('27AAPFU'))
      g?.focus()
    })
    await page.keyboard.type('27AAPFU0939F1ZV', { delay: 10 })
    await shot('03-create-filled')
    await clickText('Create & open')
    await new Promise((r) => setTimeout(r, 1200))
  } else {
    await clickText('Demo Traders')
    await new Promise((r) => setTimeout(r, 1200))
  }
  await shot('04-gateway')

  // Voucher entry: new sales invoice
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button')]
    els.find((e) => e.textContent?.includes('Voucher entry'))?.click()
  })
  await new Promise((r) => setTimeout(r, 600))
  await clickText('Sales')
  await new Promise((r) => setTimeout(r, 400))
  await shot('05-sales-entry')

  // Party
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === 'Party ledger')?.focus()
  })
  await page.keyboard.type('Umbrella Retail', { delay: 15 })
  await new Promise((r) => setTimeout(r, 500))
  await shot('06-party-suggest')
  await page.keyboard.press('Enter') // "Create Umbrella Retail"
  await new Promise((r) => setTimeout(r, 600))
  await shot('07-quick-ledger')
  await clickText('Create ledger')
  await new Promise((r) => setTimeout(r, 700))

  // Sales ledger
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === 'e.g. Sales')?.focus()
  })
  await page.keyboard.type('Sales', { delay: 15 })
  await new Promise((r) => setTimeout(r, 400))
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 600))
  const modalOpen = await page.evaluate(() => document.body.innerText.includes('New ledger'))
  if (modalOpen) {
    await clickText('Create ledger')
    await new Promise((r) => setTimeout(r, 700))
  }

  // Item line
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === 'Stock item')?.focus()
  })
  await page.keyboard.type('Laptop 14"', { delay: 15 })
  await new Promise((r) => setTimeout(r, 400))
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 600))
  await shot('08-quick-item')
  // fill HSN in quick item modal
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    const h = inputs.find((i) => i.placeholder === '8471')
    h?.focus()
  })
  await page.keyboard.type('8471', { delay: 10 })
  await clickText('Create item')
  await new Promise((r) => setTimeout(r, 700))

  // qty + rate
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === '0' && i.inputMode === 'decimal')?.focus()
  })
  await page.keyboard.type('2', { delay: 15 })
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === '0.00')?.focus()
  })
  await page.keyboard.type('45000', { delay: 10 })
  await page.keyboard.press('Tab')
  await new Promise((r) => setTimeout(r, 500))
  await shot('09-invoice-computed')

  // save
  await page.keyboard.press('Meta+Enter')
  await new Promise((r) => setTimeout(r, 1000))
  await shot('10-after-save')

  // Day book
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button')]
    els.find((e) => e.textContent?.trim() === 'Day book')?.click()
  })
  await new Promise((r) => setTimeout(r, 800))
  await shot('11-daybook')

  // Balance sheet
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button')]
    els.find((e) => e.textContent?.trim() === 'Balance sheet')?.click()
  })
  await new Promise((r) => setTimeout(r, 800))
  await shot('12-balance-sheet')

  // GSTR-1
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button')]
    els.find((e) => e.textContent?.trim() === 'GSTR-1')?.click()
  })
  await new Promise((r) => setTimeout(r, 900))
  await shot('13-gstr1')

  console.log('BODY-TAIL:', (await page.evaluate(() => document.body.innerText)).slice(0, 400))
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
  await shot('99-error')
} finally {
  await app.close()
}
