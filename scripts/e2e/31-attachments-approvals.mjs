// Scenario 31 — the bill, the owner's say-so, and the ways a business arrives.
//
// Covers roadmap O #289/#291/#296 and V #386/#387/#388/#389/#391 end to end: attachments,
// the approval threshold, the two-person rule on a supplier's bank details, the shared-account
// exception, auditor mode, the spreadsheet diff, and guided opening balances.
//
// Asserted as properties rather than pixels: the trial balance does NOT move while an entry is
// held, it DOES move the moment it is approved, the attached file really exists inside the
// company folder, and a bill whose file has been deleted behind the app's back is reported
// rather than quietly dropped.
import fs from 'node:fs'
import path from 'node:path'
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

/** A two-line receipt for `paise`, posted through the same IPC the screen uses. */
async function postReceipt(h, paise) {
  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  // Named, not "the first one that isn't Cash": the trial balance totals net per ledger, so
  // crediting a ledger that happens to carry a debit balance would move the totals by nothing at
  // all and the assertions below would be measuring the wrong thing.
  const other = ledgers.find((l) => l.name === 'Owner Capital')
  const types = await h.invoke('master:voucherTypes:list')
  const receipt = types.find((t) => t.kind === 'receipt')
  return h.invoke('voucher:save', {
    data: {
      voucherTypeId: receipt.id,
      date: '2026-08-01',
      partyLedgerId: null,
      narration: 'e2e',
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: paise },
        { ledgerId: other.id, drCr: 'cr', amount: paise }
      ],
      inventory: []
    }
  })
}

const asOn = '2027-03-31'
const debitTotal = async (h) => (await h.invoke('report:trialBalance', { asOn })).totalDebit

await scenario('31-attachments-approvals', async (h) => {
  await h.createCompanyUI('Approvals Co')

  // A party to credit, so the receipt has two real ledgers.
  const groups = await h.invoke('master:groups:list')
  const capital = groups.find((g) => g.name === 'Capital Account')
  await h.invoke('master:ledgers:create', { name: 'Owner Capital', groupId: capital.id })

  // ---- attachments: the answer to "where is the physical bill" ----
  const receipt = await postReceipt(h, 100000)
  const billPath = path.join(h.dataDir, 'bill-42.pdf')
  fs.writeFileSync(billPath, '%PDF-1.4 pretend scan of a bill\n')
  await h.stubDialogs({ openPaths: [billPath] })

  const attached = await h.invoke('voucher:attachments:add', {
    voucherId: receipt.id,
    fileName: 'bill-42.pdf',
    // Inline bytes: the same driver-friendly path tally:import's xmlText uses, so no native
    // dialog has to be involved to prove the copy happens.
    bytesBase64: fs.readFileSync(billPath).toString('base64')
  })
  assertEq(attached.fileName, 'bill-42.pdf', 'the bill is attached under its own name')
  assertEq(attached.missing, false, 'the copy is on disk')

  // COPIED, not referenced: the file lives inside the company folder, so a copy of the folder
  // carries it. This is the decision the feature turns on.
  const stored = path.join(h.dataDir, 'companies', 'approvals-co', 'attachments', attached.storedName)
  assert(fs.existsSync(stored), `the bill was copied into the company folder (${stored})`)

  // Attaching the identical scan again is recognised, not duplicated.
  await h.invoke('voucher:attachments:add', {
    voucherId: receipt.id,
    fileName: 'bill-42.pdf',
    bytesBase64: fs.readFileSync(billPath).toString('base64')
  })
  assertEq((await h.invoke('voucher:attachments:list', { id: receipt.id })).length, 1, 'the same scan is not filed twice')

  // A file removed behind the app's back is REPORTED, not hidden — the app losing evidence has
  // to be visible.
  fs.rmSync(stored)
  const afterDelete = await h.invoke('voucher:attachments:list', { id: receipt.id })
  assertEq(afterDelete[0].missing, true, 'a deleted file is reported as missing')

  // Oversized and dangerous files are refused with a reason, before anything is copied.
  const tooBig = await invokeExpectingError(h, 'voucher:attachments:add', {
    voucherId: receipt.id,
    fileName: 'huge.jpg',
    bytesBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64')
  })
  assert(/MB/.test(tooBig), `an oversized scan is refused with the size stated (${tooBig.slice(0, 80)})`)
  const wrongType = await invokeExpectingError(h, 'voucher:attachments:add', {
    voucherId: receipt.id,
    fileName: 'payload.command',
    bytesBase64: Buffer.from('x').toString('base64')
  })
  assert(/not one of them/.test(wrongType), `a runnable file is refused (${wrongType.slice(0, 80)})`)

  // ---- a spreadsheet of masters, with the diff before the button ----
  // The count that decides whether somebody presses Import is "unchanged": re-importing a
  // corrected file is the normal way this gets used, and "480 unchanged, 3 changed" reads very
  // differently from "483 will be updated".
  const csvPath = path.join(h.dataDir, 'ledgers.csv')
  fs.writeFileSync(csvPath, 'Name,Group,Opening Balance\nSpreadsheet Traders,Sundry Debtors,"1,000.00 Dr"\n')
  await h.stubDialogs({ openPaths: [csvPath] })
  await h.goto('import-tally')
  await h.click('tab-import-csv')
  await h.click('btn-csv-pick')
  await h.page.waitForSelector('[data-testid="csv-preview"]', { timeout: 15000 })
  assertEq(await h.page.textContent('[data-testid="csv-will-create"]'), '1', 'the diff says one ledger is new')
  await h.click('btn-csv-apply')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="csv-preview"]'), null, { timeout: 15000 })

  // The same file again: nothing new, nothing changed.
  await h.click('btn-csv-pick')
  await h.page.waitForSelector('[data-testid="csv-preview"]', { timeout: 15000 })
  assertEq(await h.page.textContent('[data-testid="csv-will-create"]'), '0', 'the second pass creates nothing')
  assertEq(await h.page.textContent('[data-testid="csv-unchanged"]'), '1', 'the second pass reports the row as unchanged')
  await h.shot('00-csv-diff')

  // ---- opening balances for a business with no file to import ----
  // Six plain questions instead of "opening balances, debit positive". The screen must create
  // the ledgers under the right groups and put each amount on the right side.
  await h.goto('import-tally')
  await h.click('tab-import-opening')
  await h.page.waitForSelector('[data-testid="opening-balances"]', { timeout: 15000 })
  await h.click('btn-opening-add-cash')
  await h.page.fill('[data-testid="input-opening-name-cash-0"]', 'HDFC Current A/c')
  await h.page.fill('[data-testid="input-opening-amount-cash-0"]', '1,00,000.00')
  await h.click('btn-opening-add-capital')
  await h.page.fill('[data-testid="input-opening-name-capital-0"]', 'Proprietor Capital')
  await h.page.fill('[data-testid="input-opening-amount-capital-0"]', '1,00,000.00')
  await h.page.waitForFunction(
    () => /balances/i.test(document.querySelector('[data-testid="opening-advice"]')?.textContent ?? ''),
    null,
    { timeout: 10000 }
  )
  await h.shot('00-opening-balances')
  await h.click('btn-opening-save')
  await h.page.waitForFunction(
    () => !document.querySelector('[data-testid="input-opening-name-cash-0"]'),
    null,
    { timeout: 15000 }
  )
  const afterOpenings = await h.invoke('master:ledgers:list')
  const bank = afterOpenings.find((l) => l.name === 'HDFC Current A/c')
  const proprietor = afterOpenings.find((l) => l.name === 'Proprietor Capital')
  assertEq(bank.openingBalance, 10000000, 'what the business owns lands on the debit side')
  assertEq(proprietor.openingBalance, -10000000, 'what the owner put in lands on the credit side')

  // ---- approvals: an entry that is a decision, not a keystroke ----
  const owner = await h.invoke('users:save', { data: { name: 'Priya Owner', role: 'owner', pin: '1234', active: true } })
  await h.invoke('users:save', { data: { name: 'Arun Accountant', role: 'accountant', pin: '2222', active: true } })

  // ₹50,000. Set through the screen, because the threshold is a thing an owner types.
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-approvals"]')
  await h.page.waitForSelector('[data-testid="input-approval-threshold"]', { timeout: 15000 })
  await h.page.fill('[data-testid="input-approval-threshold"]', '50,000.00')
  await h.click('btn-approval-threshold-save')
  await h.page.waitForFunction(
    () => /Above/.test(document.querySelector('[data-testid="approval-threshold-state"]')?.textContent ?? ''),
    null,
    { timeout: 10000 }
  )
  await h.shot('01-threshold-set')

  const before = await debitTotal(h)

  // The accountant enters something large.
  const users = await h.invoke('auth:users')
  await h.invoke('auth:logout')
  await h.invoke('auth:login', { userId: users.find((u) => u.name === 'Arun Accountant').id, pin: '2222' })
  const big = await postReceipt(h, 6000000) // ₹60,000
  assertEq(big.approvalState, 'pending', 'an entry above the threshold waits')

  // It is NOT in the books…
  assertEq(await debitTotal(h), before, 'a held entry does not move the trial balance')
  // …but it is not lost either: it is right there in the day book.
  const dayBook = await h.invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
  assert(dayBook.some((v) => v.id === big.id), 'the held entry is still visible to whoever typed it')

  // The accountant cannot approve it themselves.
  const selfApprove = await invokeExpectingError(h, 'approvals:decide', { voucherId: big.id, approve: true })
  assert(/permission|owner/i.test(selfApprove), `an accountant cannot approve their own entry (${selfApprove})`)

  // The owner can, through the screen.
  await h.invoke('auth:logout')
  await h.invoke('auth:login', { userId: owner.id, pin: '1234' })
  // Away and back, so the screen remounts and re-asks: the queue was last read before this
  // voucher existed, and the app only refreshes a screen's queries when it becomes visible.
  await h.goto('daybook')
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-approvals"]')
  await h.page.waitForSelector(`[data-testid="btn-approve-${big.id}"]`, { timeout: 15000 })
  await h.shot('02-waiting-for-the-owner')
  await h.click(`btn-approve-${big.id}`)
  // Wait on the fact, not on the DOM: the row leaving the screen and the voucher entering the
  // books are two different events, and asserting the balance while the first is still in flight
  // is how this scenario would flake.
  await h.page.waitForFunction(
    async (id) => {
      const r = await window.total.invoke('approvals:list')
      return r.ok && !r.data.pending.some((p) => p.voucherId === id)
    },
    big.id,
    { timeout: 15000 }
  )

  // Approved: now, and only now, it counts.
  assertEq(await debitTotal(h), before + 6000000, 'approving puts the entry into the books')
  await h.shot('03-approved')

  // ---- the two-person rule on a supplier's bank details ----
  const creditors = groups.find((g) => g.name === 'Sundry Creditors')
  const supplier = await h.invoke('master:ledgers:create', {
    name: 'Kumar Traders',
    groupId: creditors.id,
    bankAccount: '111122223333',
    bankIfsc: 'HDFC0001234',
    bankHolder: 'Kumar Traders'
  })
  const changed = await h.invoke('master:ledgers:update', {
    id: supplier.id,
    data: { name: 'Kumar Traders', groupId: creditors.id, bankAccount: '999988887777', bankIfsc: 'HDFC0001234', bankHolder: 'Kumar Traders' }
  })
  assert(changed.bankChange, 'changing a supplier account is parked for a second person')
  assertEq(changed.bankAccount, '111122223333', 'the master still shows the old account until someone confirms')

  // The person who asked cannot confirm it.
  const selfConfirm = await invokeExpectingError(h, 'bankChange:decide', { id: changed.bankChange.id, approve: true })
  assert(/other than the person who asked/.test(selfConfirm), `the requester cannot confirm (${selfConfirm})`)

  // And the same account on two parties shows up as an exception.
  await h.invoke('master:ledgers:create', {
    name: 'Unknown Payee',
    groupId: creditors.id,
    bankAccount: '1111 2222 3333',
    bankIfsc: 'HDFC0001234'
  })
  const exceptions = await h.invoke('report:exceptions', { from: '2026-04-01', to: asOn })
  const sharedSection = exceptions.sections.find((s) => s.key === 'sharedBankAccount')
  assertEq(sharedSection.count, 2, 'two parties on one account are reported, however it was typed')

  // ---- auditor mode: a read-only session that expires ----
  const auditor = await h.invoke('auditor:begin', { hours: 1 })
  assertEq(auditor.active, true, 'the auditor session is open')
  const refused = await invokeExpectingError(h, 'voucher:delete', { id: big.id })
  assert(/permission/i.test(refused), `an auditor cannot change anything (${refused})`)
  assert((await h.invoke('report:trialBalance', { asOn })).totalDebit >= 0, 'an auditor can still read the books')
  await h.invoke('auditor:end')

  await h.goto('daybook')
  await h.shot('04-daybook')
})
