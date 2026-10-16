// Hermetic IPC smoke test for CI: launches the built app (out/) with a scratch data dir,
// drives a full company -> ledger -> voucher -> report -> delete/restore round trip purely
// through window.total.invoke, and screenshots success/failure. No hardcoded .app path —
// like the scripts/e2e/ scenarios, this must run on a freshly `npm run build`-ed checkout.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
// WP 7.3: the same launch target (TOTAL_APP_EXECUTABLE = a packaged build) and env
// (ELECTRON_RUN_AS_NODE dropped, update check off) as the e2e harness.
import { launchEnv, launchTarget } from './lib/harness.mjs'

const dataDir = process.env.TOTAL_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'total-smoke-'))
const outDir = process.env.SMOKE_OUT || path.join(process.cwd(), 'smoke-out')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

async function launchApp() {
  const { executablePath, args, packaged } = launchTarget(process.cwd())
  console.log(`[smoke] launching ${packaged ? 'packaged' : 'unpackaged'} app: ${executablePath}`)
  const app = await electron.launch({
    executablePath,
    args,
    timeout: 60000,
    // TOTAL_INSECURE_TEST_SECRETS: test cipher for the secret store — keeps the run off the real
    // keychain (unpackaged builds only; a packaged Windows build uses DPAPI, no prompt).
    env: launchEnv({ TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: '1', TOTAL_INSECURE_TEST_SECRETS: '1' })
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
  // The app's today is the LOCAL date (todayISO); toISOString() is UTC — a day behind 00:00–05:30 IST
  // (on 1 April that put the voucher before the books begin).
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

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

  // ---- WP 7.3: what differs by platform, checked on every OS the smoke runs on ----
  // No native window may open mid-run (Explorer / Finder reveals, a PDF viewer).
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = () => {}
    shell.openPath = async () => ''
  })

  // Backup → change → restore: the restore swaps the live file (on Windows a rename over an open
  // file EPERMs unless every handle is closed first — db/backup.ts), then the books are as backed up.
  const backup = await invoke('backup:run')
  assert(fs.existsSync(backup.path), `backup file exists on disk (${backup.path})`)
  const backupFile = path.basename(backup.path)
  const listed = await invoke('backup:list')
  assert(listed.some((b) => b.file === backupFile), 'backup:list shows the new backup')
  await invoke('voucher:save', {
    data: {
      voucherTypeId: receiptType.id, date: today, partyLedgerId: null, narration: 'after the backup', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: cash.id, drCr: 'dr', amount: 10000 }, { ledgerId: ciSales.id, drCr: 'cr', amount: 10000 }],
      inventory: []
    }
  })
  const tbChanged = await invoke('report:trialBalance', { asOn: today })
  assert(tbChanged.totalDebit === 60000, `trialBalance after the second receipt === 60000 (got ${tbChanged.totalDebit})`)
  await invoke('backup:restore', { file: backupFile })
  const tbRestored = await invoke('report:trialBalance', { asOn: today })
  assert(tbRestored.totalDebit === 50000, `trialBalance after the restore === 50000 (got ${tbRestored.totalDebit})`)

  // Encrypted backup (.totalbak) is written under the company's exports folder.
  const enc = await invoke('backup:exportEncrypted', { passphrase: 'smoke-passphrase-1' })
  assert(fs.existsSync(enc.path) && fs.statSync(enc.path).size > 0, `encrypted backup exists (${enc.path})`)

  // WP 7.2 review: the passphrase lock works in THIS build (on Windows CI also the packaged
  // Total.exe) — the native SQLite3 Multiple Ciphers module encrypts, reopens with the passphrase
  // only, and decrypts again, the books unchanged; a locked backup passes the restore check.
  const PASS = 'smoke lock passphrase'
  const header = (f) => fs.readFileSync(f).subarray(0, 15).toString('latin1')
  const dbPath = path.join(dataDir, 'companies', slug, 'company.db')
  const on = await invoke('security:passphrase:on', { passphrase: PASS, confirm: PASS })
  assert(on.encrypted === true && on.backupsFailed.length === 0, `the lock goes on (${JSON.stringify(on.backupsFailed)})`)
  assert(header(dbPath) !== 'SQLite format 3', 'the books file is encrypted')
  await invoke('company:close')
  const refusedOpen = await page.evaluate((s) => window.total.invoke('company:open', { slug: s }), slug)
  assert(!refusedOpen.ok && refusedOpen.code === 'passphrase_required', `a locked business asks for its passphrase (${refusedOpen.code})`)
  await invoke('company:open', { slug, passphrase: PASS })
  const tbLocked = await invoke('report:trialBalance', { asOn: today })
  assert(tbLocked.totalDebit === 50000, `the locked books are the same (got ${tbLocked.totalDebit})`)
  const lockedBackup = await invoke('backup:run')
  assert(lockedBackup.check?.ok === true && lockedBackup.check.encrypted === true, `a locked backup passes the restore check (${JSON.stringify(lockedBackup.check?.error ?? null)})`)
  const offResult = await invoke('security:passphrase:off', { passphrase: PASS })
  assert(offResult.encrypted === false && header(dbPath) === 'SQLite format 3', 'the lock comes off (plaintext again)')

  // Main-process facts: the PDF and check worker threads load (from app.asar in a packaged build), the
  // Devanagari print font is found (extraResources), and on Windows the secret store has DPAPI.
  const probe = await app.evaluate(async ({ app: a, safeStorage }, backupPath) => {
    // Node 22's process.getBuiltinModule (the evaluated function has no `require` of its own).
    const req = process.getBuiltinModule ?? process.mainModule?.require
    if (!req) return { error: 'no require in the main process' }
    const nodeFs = req('fs')
    const nodePath = req('path')
    const { Worker } = req('worker_threads')
    const workerFile = nodePath.join(a.getAppPath(), 'out', 'main', 'pdfWorker.js')
    const fontDir = a.isPackaged ? nodePath.join(process.resourcesPath, 'fonts') : nodePath.join(a.getAppPath(), 'resources', 'fonts')
    const worker = await new Promise((resolve) => {
      try {
        const w = new Worker(workerFile)
        const t = setTimeout(() => { void w.terminate(); resolve('timeout') }, 15000)
        w.once('error', (e) => { clearTimeout(t); resolve(`error: ${e.message}`) })
        w.on('message', (m) => { clearTimeout(t); void w.terminate(); resolve(m && m.ok ? 'ok' : `failed: ${JSON.stringify(m)}`) })
        w.postMessage({ id: 1, bytes: new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF')) })
      } catch (e) {
        resolve(`throw: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    // The check worker (out/main/checkWorker.js, its own esbuild bundle) loads from the same place,
    // requires the SQLite driver there, and answers both kinds of job: a quick_check of the backup
    // and the whole restore check of it (migrations, audit chain, balance) in a scratch folder.
    const checkJob = (job) => new Promise((resolve) => {
      try {
        const w = new Worker(nodePath.join(a.getAppPath(), 'out', 'main', 'checkWorker.js'))
        const t = setTimeout(() => { void w.terminate(); resolve({ ok: false, error: 'timeout' }) }, 60000)
        w.once('error', (e) => { clearTimeout(t); resolve({ ok: false, error: `error: ${e.message}` }) })
        w.on('message', (m) => { clearTimeout(t); void w.terminate(); resolve(m) })
        w.postMessage({ id: 1, ...job })
      } catch (e) {
        resolve({ ok: false, error: `throw: ${e instanceof Error ? e.message : String(e)}` })
      }
    })
    const pragma = await checkJob({ kind: 'pragma', path: backupPath, pragma: 'quick_check', keyHex: null })
    const scratchRoot = nodeFs.mkdtempSync(nodePath.join(req('os').tmpdir(), 'total-smoke-verify-'))
    const verify = await checkJob({ kind: 'verify', path: backupPath, keyHex: null, asOn: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })(), nowIso: new Date().toISOString(), scratchRoot })
    const scratchLeft = nodeFs.readdirSync(scratchRoot).length
    nodeFs.rmSync(scratchRoot, { recursive: true, force: true })
    return {
      platform: process.platform,
      packaged: a.isPackaged,
      worker,
      checkWorker: pragma.ok && pragma.result === 'ok' ? 'ok' : `failed: ${JSON.stringify(pragma)}`,
      verifyWorker: verify.ok && verify.result && verify.result.ok ? 'ok' : `failed: ${JSON.stringify(verify)}`,
      scratchLeft,
      devanagariFont: nodeFs.existsSync(nodePath.join(fontDir, 'NotoSansDevanagari-400.woff2')),
      secureStorage: safeStorage.isEncryptionAvailable()
    }
  }, backup.path)
  console.log('[smoke] main-process probe:', JSON.stringify(probe))
  assert(!probe.error, `main-process probe ran (${probe.error})`)
  assert(probe.worker === 'ok', `the PDF worker thread loads and answers (${probe.worker})`)
  assert(probe.checkWorker === 'ok', `the check worker thread loads the SQLite driver and answers a quick_check (${probe.checkWorker})`)
  assert(probe.verifyWorker === 'ok', `the check worker runs the restore check of a backup (${probe.verifyWorker})`)
  assert(probe.scratchLeft === 0, `the worker's restore check leaves its scratch folder empty (${probe.scratchLeft})`)
  assert(probe.devanagariFont === true, 'the Devanagari print font is bundled where printFonts.ts looks')
  if (probe.platform === 'win32') assert(probe.secureStorage === true, 'safeStorage (DPAPI) is available on Windows')

  await page.screenshot({ path: path.join(outDir, 'success.png') })
  console.log(
    JSON.stringify({
      ok: true,
      slug,
      voucherId,
      totalDebit: tb2.totalDebit,
      totalCredit: tb2.totalCredit,
      binLength: bin.length,
      restoredDebit: tbRestored.totalDebit,
      probe
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
