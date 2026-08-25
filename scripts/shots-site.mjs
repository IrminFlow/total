// Site proof screenshots: launches the BUILT app (out/) against a fresh scratch data dir,
// drives the real sample-business flow (createDemo + open, chained by the renderer
// itself — see CompanySelect.tsx), and captures Gateway / GSTR-1 / dark-theme voucher shots
// straight into site/public/. Modeled on scripts/smoke-ci.mjs (launch pattern) and
// the scripts/lib/harness.mjs conventions (clickText DOM-click pattern). Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...desktopEnv } = process.env

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-shots-site-'))
const outDir = path.join(process.cwd(), 'site', 'public')
fs.mkdirSync(outDir, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function launchApp() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [process.cwd()],
    timeout: 60000,
    env: { ...desktopEnv, TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30000 })
  await page.setViewportSize({ width: 1440, height: 900 })
  return { app, page }
}

const clickText = async (page, text) => {
  const r = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')]
    const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
    if (!el) return 'NOT_FOUND'
    el.click()
    return 'OK'
  }, text)
  return r
}

// Case-insensitive: CSS text-transform:uppercase on tile labels makes innerText render
// "CASH IN HAND" even though the JSX literal is "Cash in hand".
const waitForText = async (page, text, timeout = 20000) => {
  await page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    text,
    { timeout }
  )
}

// Bounded poll (max iterations, never unbounded) that logs a snippet of the page each round —
// used only around the one step (demo creation) known to take a variable amount of time, so a
// stall is diagnosable instead of a silent 30s timeout.
const waitForTextWithLog = async (page, text, { intervalMs = 3000, maxIterations = 15, label = text } = {}) => {
  for (let i = 0; i < maxIterations; i++) {
    const found = await page.evaluate((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), text)
    if (found) return
    const snippet = await page.evaluate(() => document.body.innerText.slice(0, 300))
    console.log(`waiting for "${label}" [${i + 1}/${maxIterations}]: ${JSON.stringify(snippet)}`)
    await wait(intervalMs)
  }
  throw new Error(`timed out waiting for text "${label}" after ${(maxIterations * intervalMs) / 1000}s`)
}

const results = {}

let app
let page
try {
  ;({ app, page } = await launchApp())

  // --- Get to the Gateway with demo data. The sample-business action chains
  // company:createDemo -> company:open -> setCompany itself (CompanySelect.tsx), so a single
  // click drives create+open, integrity/locked handling included.
  await page.waitForSelector('[data-testid="btn-company-demo"]', { state: 'visible', timeout: 15000 })
  await page.click('[data-testid="btn-company-demo"]')
  await waitForTextWithLog(page, 'Cash in hand', { intervalMs: 3000, maxIterations: 15, label: 'Cash in hand (Gateway loaded)' })
  await wait(800)

  // --- Shot 1: gateway-light.jpg
  try {
    await page.screenshot({ path: path.join(outDir, 'gateway-light.jpg'), type: 'jpeg', quality: 88 })
    results['gateway-light.jpg'] = 'ok'
  } catch (err) {
    results['gateway-light.jpg'] = `FAILED: ${err instanceof Error ? err.message : String(err)}`
  }

  // --- Shot 2: gstr1-light.jpg
  try {
    const navClicked = await clickText(page, 'GSTR-1')
    if (navClicked !== 'OK') throw new Error('sidebar "GSTR-1" not found')
    await wait(1500)
    await page.screenshot({ path: path.join(outDir, 'gstr1-light.jpg'), type: 'jpeg', quality: 88 })
    results['gstr1-light.jpg'] = 'ok'
  } catch (err) {
    results['gstr1-light.jpg'] = `FAILED: ${err instanceof Error ? err.message : String(err)}`
  }

  // --- Shot 3: voucher-dark.jpg
  try {
    const themeClicked = await clickText(page, 'Dark')
    if (themeClicked !== 'OK') throw new Error('theme toggle "Dark" not found')
    await wait(400)

    const navClicked = await clickText(page, 'Voucher entry')
    if (navClicked !== 'OK') throw new Error('sidebar "Voucher entry" not found')
    await wait(600)
    await page.keyboard.press('F8')
    await wait(500)

    // Open the party ledger picker (type a couple of characters to trigger suggestions).
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')]
      inputs.find((i) => i.placeholder === 'Party ledger')?.focus()
    })
    await page.keyboard.type('Umb', { delay: 20 })
    await wait(500)

    await page.screenshot({ path: path.join(outDir, 'voucher-dark.jpg'), type: 'jpeg', quality: 88 })
    results['voucher-dark.jpg'] = 'ok'
  } catch (err) {
    results['voucher-dark.jpg'] = `FAILED: ${err instanceof Error ? err.message : String(err)}`
  }
} catch (err) {
  console.error('shots-site: fatal error before shots could run:', err instanceof Error ? err.stack || err.message : String(err))
  results['__fatal__'] = 'FAILED'
  try {
    await page?.screenshot({ path: '/tmp/shots-site-debug.png' })
    console.error('debug screenshot: /tmp/shots-site-debug.png')
  } catch {
    // ignore
  }
} finally {
  try {
    await app?.close()
  } catch {
    // ignore
  }
}

console.log(JSON.stringify(results, null, 2))

const anyFailed = Object.values(results).some((v) => v !== 'ok')
process.exit(anyFailed ? 1 : 0)
