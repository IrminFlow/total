// Scenario 65 — WP 7.2 security. Wizard → a simple business with a receipt and a backup →
// Settings → Lock and safety: lock with a passphrase (the lost-passphrase warning and the
// "I understand" tick first), save the recovery copy → restart the app → the picker asks for the
// passphrase (a wrong one is refused in plain words) → the right one opens the same books → the
// backup restore check shows on the screen and on Home → People & roles switches (stored on the
// user) → ⌘L locks, the PIN brings the user back, a refused call while locked → auto-lock setting.
import fs from 'fs'
import path from 'path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })
const PASS = 'mango season 2026'

async function wizard(h, name) {
  await attached(h, '[data-testid="setup-wizard"]')
  await h.fill('setup-name', name)
  await h.click('setup-next')
  await h.click('setup-type-retail')
  await h.click('setup-next')
  await h.click('setup-gst-no')
  await h.click('setup-next')
  await h.click('setup-stock-no')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  if (await h.page.$('[data-testid="tour-skip"]')) await h.click('tour-skip')
}

async function postReceipt(h, amount) {
  const ledgers = await h.invoke('master:ledgers:list')
  const groups = await h.invoke('master:groups:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  let other = ledgers.find((l) => l.name === 'Counter Takings')
  if (!other) {
    other = await h.invoke('master:ledgers:create', {
      name: 'Counter Takings', groupId: groups.find((g) => g.name === 'Sales Accounts').id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
  const types = await h.invoke('master:voucherTypes:list')
  const fy = (await h.invoke('company:current')).info.booksFrom
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: types.find((t) => t.kind === 'receipt').id, date: `${fy}-04-10`, partyLedgerId: null, narration: null, reference: null, instrumentNo: null,
      instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: cash.id, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: other.id, drCr: 'cr', amount, costAllocations: [] }],
      inventory: [], billRefs: [], tds: null
    }
  })
}

const tb = async (h) => {
  const fy = (await h.invoke('company:current')).info.booksFrom
  const t = await h.invoke('report:trialBalance', { asOn: `${fy + 1}-03-31` })
  return `${t.totalDebit}/${t.totalCredit}/${t.rows.length}`
}

async function openSecurity(h) {
  await h.click('simple-nav-settings')
  await attached(h, '[data-testid="simple-entry-security"]')
  await h.click('simple-entry-security')
  await attached(h, '[data-testid="simple-security"]')
}

await scenario('65-security', async (h) => {
  const page = h.page
  await h.stubDialogs()
  await h.waitScreen('company-select')
  await wizard(h, 'Safe Traders')
  await postReceipt(h, 250_000)
  await h.invoke('backup:run')
  const before = await tb(h)
  const slug = (await h.invoke('company:current')).slug

  // ---------- lock with a passphrase ----------
  await openSecurity(h)
  assert((await page.textContent('[data-testid="security-warning"]')).includes('nobody'), 'the lost-passphrase warning shows')
  await h.shot('01-lock-off')
  await h.fill('input-new-passphrase', PASS)
  await h.fill('input-confirm-passphrase', PASS)
  assert(await page.isDisabled('[data-testid="btn-security-lock-on"]'), 'locking waits for "I understand"')
  await h.click('check-passphrase-understood')
  await h.click('btn-security-lock-on')
  await attached(h, '[data-testid="security-locked-text"]', 120000)
  await attached(h, '[data-testid="security-recovery"]')
  await h.shot('02-locked-recovery')
  await h.click('btn-security-recovery')
  await page.waitForSelector('[data-testid="security-recovery"]', { state: 'detached', timeout: 60000 })
  const dir = path.join(h.dataDir, 'companies', slug)
  assert(fs.readdirSync(path.join(dir, 'exports')).some((f) => f.endsWith('.totalbak')), 'the recovery copy is saved')
  assert(fs.readFileSync(path.join(dir, 'company.db')).subarray(0, 15).toString('latin1') !== 'SQLite format 3', 'the books file is encrypted')
  assert(fs.existsSync(path.join(dir, 'company.key.json')), 'the wrapped key sits beside the books')
  assert(!fs.readFileSync(path.join(dir, 'company.key.json'), 'utf8').includes(PASS), 'the passphrase is not stored')

  // ---------- restart: the picker asks for the passphrase ----------
  await h.relaunch()
  await h.waitScreen('company-select')
  await h.clickText('Safe Traders')
  await attached(h, '[data-testid="passphrase-prompt"]')
  await h.fill('input-passphrase', 'not the passphrase')
  await h.click('btn-passphrase-open')
  await page.waitForFunction(() => document.body.textContent.includes('That passphrase is not right'), null, { timeout: 60000 })
  await h.shot('03-wrong-passphrase')
  await h.fill('input-passphrase', PASS)
  await h.click('btn-passphrase-open')
  await attached(h, '[data-testid="simple-home"]', 60000)
  assertEq(await tb(h), before, 'the books are intact after the restart')
  assertEq((await h.invoke('company:current')).encrypted, true, 'the business is open encrypted')

  // ---------- the restore check of a backup ----------
  await openSecurity(h)
  await h.click('btn-backup-check')
  await page.waitForSelector('[data-testid="security-backup-status"][data-ok="true"]', { state: 'attached', timeout: 60000 })
  await h.shot('04-backup-checked')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home-backup-check"]')
  assert((await page.textContent('[data-testid="simple-home-backup-check"]')).includes('checked OK'), 'Home says the last backup checked OK')

  // ---------- People & roles: plain switches stored on the user ----------
  const owner = await h.invoke('users:save', { data: { name: 'Meera', role: 'owner', pin: '1234', active: true } })
  const acct = await h.invoke('users:save', { data: { name: 'Ravi', role: 'accountant', pin: '2468', active: true } })
  await h.click('simple-nav-settings')
  await attached(h, '[data-testid="simple-entry-people-roles"]')
  await h.click('simple-entry-people-roles')
  await attached(h, `[data-testid="roles-user-${acct.id}"]`)
  assert((await page.textContent(`[data-testid="roles-user-${owner.id}"]`)).includes('Can do everything'), 'the owner has no switches')
  await h.click(`roles-${acct.id}-canSeeProfit`)
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="roles-${id}-canSeeProfit"]`)?.checked, acct.id, { timeout: 10000 })
  const users = await h.invoke('users:list')
  assertEq(JSON.stringify(users.find((u) => u.id === acct.id).capabilities), '{"canSeeProfit":false}', 'the flag is stored on the user')
  await h.shot('05-people-roles')

  // ---------- ⌘L locks; main refuses while locked; the PIN brings the user back ----------
  await page.keyboard.press('Meta+l')
  await attached(h, '[data-screen="lock"][data-lock="simple"]')
  const refused = await page.evaluate(() => window.total.invoke('report:trialBalance', { asOn: '2027-03-31' }))
  assertEq(refused.code, 'session_locked', 'main refuses a call while the screen is locked')
  await h.shot('06-lock-screen')
  await h.click(`lock-user-${owner.id}`)
  await h.fill('input-pin', '1234')
  await h.click('btn-unlock')
  await attached(h, '[data-testid="simple-home"]')

  // ---------- auto-lock after idle minutes (owner) ----------
  await openSecurity(h)
  await page.selectOption('[data-testid="select-autolock"]', '5')
  await page.waitForFunction(() => document.querySelector('[data-testid="select-autolock"]')?.value === '5', null, { timeout: 10000 })
  assertEq((await h.invoke('security:get')).autoLockMinutes, 5, 'auto-lock saved')
  await h.shot('07-auto-lock')
})
