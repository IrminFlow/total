// Scenario 10 — roles + lock: bootstrap the first owner (auto-signed-in), add accountant and
// viewer users, lock from the Shell, fail a wrong PIN, unlock with the right one, and prove
// the role gate: viewer can't post vouchers or list users; owner can.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

/** invoke() that must FAIL — returns the error message. */
async function invokeExpectingError(h, channel, payload) {
  try {
    await h.invoke(channel, payload)
  } catch (err) {
    return String(err instanceof Error ? err.message : err)
  }
  throw new Error(`${channel} unexpectedly succeeded`)
}

await scenario('10-roles-lock', async (h) => {
  await h.createCompanyUI('Roles Co')

  // Bootstrap: the very first user is created with no session (zero-users gate) and comes
  // back auto-signed-in as themselves.
  const owner = await h.invoke('users:save', { data: { name: 'Priya Owner', role: 'owner', pin: '1234', active: true } })
  assert(typeof owner.id === 'number', 'bootstrap owner created')
  const current = await h.invoke('auth:current')
  assertEq(current?.role, 'owner', 'bootstrap owner is auto-signed-in')

  await h.invoke('users:save', { data: { name: 'Arun Accountant', role: 'accountant', pin: '2222', active: true } })
  await h.invoke('users:save', { data: { name: 'Vidya Viewer', role: 'viewer', pin: '3333', active: true } })
  assertEq((await h.invoke('users:list')).length, 3, 'three users on the company')

  // The users were created over IPC, so the RENDERER session doesn't know about them yet —
  // relaunch: a company with users now demands sign-in at open.
  await h.relaunch()
  assertEq(await h.openCompany('Roles Co'), 'lock', 'reopening a user-protected company demands sign-in')
  await h.shot('01-locked')

  // Wrong PIN: an error shows and we stay locked.
  await h.clickText('Priya Owner')
  await h.fill('input-pin', '9999')
  await h.click('btn-unlock')
  await h.page.waitForFunction(() => /wrong pin/i.test(document.body.innerText), null, { timeout: 10000 })
  assert(await h.page.$('[data-screen="lock"]'), 'still locked after a wrong PIN')
  await h.shot('02-wrong-pin')

  // Right PIN unlocks to the Gateway.
  await h.fill('input-pin', '1234')
  await h.click('btn-unlock')
  await h.waitScreen('gateway')
  await h.shot('03-unlocked')

  // Shell's lock button (visible now that the renderer has a session) locks straight back.
  await h.click('btn-lock')
  await h.page.waitForSelector('[data-screen="lock"]', { state: 'attached', timeout: 10000 })
  await h.shot('04-relocked')
  await h.clickText('Priya Owner')
  await h.fill('input-pin', '1234')
  await h.click('btn-unlock')
  await h.waitScreen('gateway')

  // Role gate, driven over IPC (same surface the UI uses). Viewer: no posting, no user admin.
  await h.invoke('auth:logout')
  const lockedErr = await invokeExpectingError(h, 'voucher:list', { from: '2026-01-01', to: '2026-12-31' })
  assert(/locked|sign in/i.test(lockedErr), `no-session call is refused as locked (got: ${lockedErr})`)

  const users = await h.invoke('auth:users')
  const viewer = users.find((u) => u.name === 'Vidya Viewer')
  await h.invoke('auth:login', { userId: viewer.id, pin: '3333' })

  const ledgers = await h.invoke('master:ledgers:list') // viewer-readable
  const cash = ledgers.find((l) => l.name === 'Cash')
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  const denied = await invokeExpectingError(h, 'voucher:save', {
    data: {
      voucherTypeId: receipt.id, date: '2026-08-01', partyLedgerId: null,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 1000 },
        { ledgerId: cash.id, drCr: 'cr', amount: 1000 }
      ],
      inventory: []
    }
  })
  assert(/permission/i.test(denied), `viewer cannot post vouchers (got: ${denied})`)
  const deniedUsers = await invokeExpectingError(h, 'users:list')
  assert(/permission/i.test(deniedUsers), `viewer cannot administer users (got: ${deniedUsers})`)

  // Owner can.
  await h.invoke('auth:logout')
  const ownerRow = users.find((u) => u.name === 'Priya Owner')
  await h.invoke('auth:login', { userId: ownerRow.id, pin: '1234' })
  assertEq((await h.invoke('users:list')).length, 3, 'owner lists users again')
})
