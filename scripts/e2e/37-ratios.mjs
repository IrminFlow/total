// Scenario 37 — ratios and comparative statements (WP 6.2). On the demo company: the Ratios
// screen, then the P&L and balance sheet with the comparative columns on. Screenshots of every
// view in both themes (also copied to /tmp/wp61 when that folder exists). (The report builder and
// scheduled packs this scenario also covered were removed.)
import { scenario } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SHOTS = '/tmp/wp61'

await scenario('37-ratios', async (h) => {
  await h.stubDialogs()
  await h.createDemoCompany()
  const shot = async (name) => {
    const file = await h.shot(name)
    if (fs.existsSync(SHOTS)) fs.copyFileSync(file, path.join(SHOTS, `${name}.png`))
  }
  const bothThemes = async (name) => {
    await shot(`${name}-light`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(250)
    await shot(`${name}-dark`)
    await h.click('btn-theme')
    await h.page.waitForTimeout(150)
  }

  // ---------------- ratios + comparative statements
  await h.goto('ratios', 30000)
  await h.page.waitForSelector('[data-testid="rows-ratios"] tr[data-ratio="currentRatio"]', { timeout: 30000 })
  await bothThemes('02-ratios')
  await h.goto('profit-loss', 30000)
  await h.click('btn-profit-loss-options')
  await h.click('input-statement-comparative')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="comparative-pnl"]', { timeout: 30000 })
  await h.waitIdle(30000)
  await bothThemes('03-pnl-comparative')
  await h.goto('balance-sheet', 30000)
  await h.click('btn-balance-sheet-options')
  await h.click('input-statement-comparative')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="comparative-bs"]', { timeout: 30000 })
  await h.waitIdle(30000)
  await bothThemes('04-bs-comparative')
})
