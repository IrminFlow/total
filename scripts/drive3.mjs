// Pass 3: visual re-check of table rows + remaining screens + GSTR-1 export file.
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
  await clickText('Demo Traders')
  await sleep(1200)
  await clickText('Day book')
  await sleep(800)
  await shot('30-daybook-fixed')
  await clickText('Stock summary')
  await sleep(800)
  await shot('31-stock')
  await clickText('GSTR-3B')
  await sleep(900)
  await shot('32-gstr3b')
  await clickText('Gateway')
  await sleep(900)
  await shot('33-gateway')
  // Export GSTR-1 via IPC directly (same handler the button uses, without opening Finder repeatedly is fine — it reveals once)
  const res = await page.evaluate(async () => {
    return await window.total.invoke('gst:exportGstr1', { from: '2026-08-01', to: '2026-08-31', period: '082026' })
  })
  console.log('EXPORT:', JSON.stringify(res))
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
  await shot('99-error3')
} finally {
  await app.close()
}
