// Scenario 16 — licensing: a lapsed licence must never lock anyone out of their own accounts.
//
// The assertion that matters is the asymmetry. Posting a voucher stops; opening the books,
// reading every report, exporting and backing up all keep working. That promise is the reason
// the fail-soft design exists, so it is tested rather than trusted.
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

// A real key pair for this run. The public half goes into the app's environment before launch,
// which is how a production build embeds it.
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.TOTAL_LICENSE_PUBKEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

const issue = (over = {}) => {
  const payload = {
    v: 1,
    name: 'Sharma Traders',
    plan: 'annual',
    issued: '2020-01-01',
    expires: '2099-01-01',
    companies: 1,
    ...over
  }
  const signed = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(null, Buffer.from(signed), createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }))).toString('base64url')
  return `${signed}.${signature}`
}

await scenario('16-license', async (h) => {
  await h.createDemoCompany()

  // ---- a fresh install is in trial, and everything works ----
  const trial = await h.invoke('license:get')
  assertEq(trial.kind, 'trial', 'a fresh install starts in trial')
  assertEq(trial.readOnly, false, 'the trial is fully functional')

  const typeId = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'receipt').id
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const other = ledgers.find((l) => l.name !== 'Cash')
  const voucher = {
    date: '2026-08-01',
    voucherTypeId: typeId,
    lines: [
      { ledgerId: cash.id, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: other.id, drCr: 'cr', amount: 100000, costAllocations: [] }
    ]
  }
  const posted = await h.invoke('voucher:save', { data: voucher })
  assert(posted.id > 0, 'a voucher posts during the trial')

  // ---- a valid key licenses it ----
  const licensed = await h.invoke('license:apply', { token: issue() })
  assertEq(licensed.kind, 'licensed', 'a signed key licenses the app')
  assert(licensed.message.includes('Sharma Traders'), 'the holder is named')

  // ---- an expired key goes read-only ----
  const expired = await h.invoke('license:apply', { token: issue({ expires: '2020-01-02' }) })
  assertEq(expired.kind, 'license-expired', 'an expired key is recognised')
  assertEq(expired.readOnly, true, 'an expired licence is read-only')
  assert(/still here/.test(expired.message), 'the message says the books are still there')

  // Writes stop.
  let refused = null
  try {
    await h.invoke('voucher:save', { data: voucher })
  } catch (err) {
    refused = String(err)
  }
  assert(refused !== null && /licence has lapsed/i.test(refused), `posting is refused (${refused})`)

  // Everything that gets data OUT keeps working. This is the whole promise.
  const tb = await h.invoke('report:trialBalance', { asOn: '2027-03-31' })
  assertEq(tb.totalDebit, tb.totalCredit, 'reports still compute')

  const day = await h.invoke('report:dayBook', { from: '2026-04-01', to: '2027-03-31' })
  assert(day.rows.length > 0, 'the day book still reads')

  const backup = await h.invoke('backup:run')
  assert(backup != null, 'backups still run')

  const backups = await h.invoke('backup:list')
  assert(backups.length > 0, 'backups are still listed')

  // And the UI says so rather than showing a bare error.
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-license"]')
  await h.page.waitForSelector('[data-testid="license-status"]', { timeout: 10000 })
  const shown = await h.page.textContent('[data-testid="license-status"]')
  assert(/still here/.test(shown), `the licence screen leads with what still works (${shown.slice(0, 70)})`)
  await h.shot('01-lapsed')

  // ---- and a fresh valid key restores writing ----
  await h.invoke('license:apply', { token: issue() })
  const again = await h.invoke('voucher:save', { data: { ...voucher, date: '2026-08-02' } })
  assert(again.id > 0, 'posting resumes once a valid licence is applied')
})
