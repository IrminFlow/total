// Hermetic IPC smoke test for CI: launches the built app (out/) with a scratch data dir,
// drives a full company -> ledger -> voucher -> report -> delete/restore round trip purely
// through window.total.invoke, and screenshots success/failure. No hardcoded .app path —
// unlike scripts/drive*.mjs, this must run on a freshly `npm run build`-ed checkout.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const dataDir = process.env.TOTAL_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'total-smoke-'))
const outDir = process.env.SMOKE_OUT || path.join(process.cwd(), 'smoke-out')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

async function launchApp() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [process.cwd()],
    timeout: 60000,
    env: { ...process.env, TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30000 })
  return { app, page }
}

let app
let page
let exitCode = 0
try {
  try {
    ;({ app, page } = await launchApp())
  } catch (err) {
    console.log('launch failed, retrying once:', err instanceof Error ? err.message : String(err))
    try {
      await app?.close()
    } catch {
      // ignore
    }
    ;({ app, page } = await launchApp())
  }

  const invoke = async (channel, payload) => {
    const r = await page.evaluate(
      ([c, p]) => window.total.invoke(c, p),
      [channel, payload]
    )
    if (!r.ok) throw new Error(`${channel} failed: ${r.error}`)
    return r.data
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`assertion failed: ${msg}`)
  }

  // Financial year start: Apr-Dec -> current calendar year, Jan-Mar -> previous year.
  const now = new Date()
  const booksFrom = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const today = now.toISOString().slice(0, 10)

  const { slug } = await invoke('company:create', {
    name: 'CI Smoke',
    stateCode: '27',
    gstRegistrationType: 'unregistered',
    gstin: null,
    address: '',
    booksFrom,
    email: null,
    phone: null
  })
  assert(typeof slug === 'string' && slug.length > 0, 'company:create returned a slug')

  const opened = await invoke('company:open', { slug })
  assert(opened.integrity.ok === true, 'company:open integrity.ok === true')
  assert(opened.locked === false, 'company:open locked === false')

  const groups = await invoke('master:groups:list')
  const salesGroup = groups.find((g) => g.name === 'Sales Accounts')
  assert(salesGroup, "found 'Sales Accounts' group")

  await invoke('master:ledgers:create', {
    name: 'CI Sales',
    groupId: salesGroup.id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null
  })

  const ledgers = await invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const ciSales = ledgers.find((l) => l.name === 'CI Sales')
  assert(cash, "found 'Cash' ledger")
  assert(ciSales, "found 'CI Sales' ledger")

  const voucherTypes = await invoke('master:voucherTypes:list')
  const receiptType = voucherTypes.find((vt) => vt.kind === 'receipt')
  assert(receiptType, "found a voucher type with kind 'receipt'")

  const saved = await invoke('voucher:save', {
    data: {
      voucherTypeId: receiptType.id,
      date: today,
      partyLedgerId: null,
      narration: 'CI smoke receipt',
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 50000 },
        { ledgerId: ciSales.id, drCr: 'cr', amount: 50000 }
      ],
      inventory: []
    }
  })
  const voucherId = saved.id
  assert(typeof voucherId === 'number', 'voucher:save returned an id')

  const tb1 = await invoke('report:trialBalance', { asOn: today })
  assert(tb1.totalDebit === 50000, `trialBalance totalDebit === 50000 (got ${tb1.totalDebit})`)
  assert(tb1.totalCredit === 50000, `trialBalance totalCredit === 50000 (got ${tb1.totalCredit})`)

  await invoke('voucher:delete', { id: voucherId })
  const bin = await invoke('voucher:bin')
  assert(bin.length === 1, `voucher:bin length === 1 (got ${bin.length})`)

  await invoke('voucher:restore', { id: voucherId })
  const tb2 = await invoke('report:trialBalance', { asOn: today })
  assert(tb2.totalDebit === 50000, `trialBalance (post-restore) totalDebit === 50000 (got ${tb2.totalDebit})`)
  assert(tb2.totalCredit === 50000, `trialBalance (post-restore) totalCredit === 50000 (got ${tb2.totalCredit})`)

  await page.screenshot({ path: path.join(outDir, 'success.png') })
  console.log(
    JSON.stringify({
      ok: true,
      slug,
      voucherId,
      totalDebit: tb2.totalDebit,
      totalCredit: tb2.totalCredit,
      binLength: bin.length
    })
  )
} catch (err) {
  console.error('SMOKE FAILED:', err instanceof Error ? err.stack || err.message : String(err))
  try {
    if (page) await page.screenshot({ path: path.join(outDir, 'failure.png') })
  } catch (shotErr) {
    console.error('failed to capture failure screenshot:', shotErr)
  }
  exitCode = 1
} finally {
  try {
    await app?.close()
  } catch {
    // ignore
  }
}
process.exit(exitCode)
