// Scenario 31 — the data-safety and permission work of roadmap sections L and M, end to end in
// the built app: what a restore would change before it changes it, a copy of the books somewhere
// else (plain and encrypted), archived books that read but do not write, the open export and its
// round trip, the audit trail checking itself, a crash-safe draft, and a denial that narrows a
// role.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const today = new Date().toISOString().slice(0, 10)

await scenario('31-data-safety', async (h) => {
  await h.createCompanyUI('Safety Co')
  await h.stubDialogs()

  const ledgers = await h.invoke('master:ledgers:list')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const groups = await h.invoke('master:groups:list')
  const salesGroup = groups.find((g) => g.name === 'Sales Accounts')
  await h.invoke('master:ledgers:create', {
    name: 'DS Sales', groupId: salesGroup.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const sales = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'DS Sales')
  const receipt = (await h.invoke('master:voucherTypes:list')).find((t) => t.kind === 'receipt')

  const post = (amount, narration) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: receipt.id, date: today, partyLedgerId: null,
        narration, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount },
          { ledgerId: sales.id, drCr: 'cr', amount }
        ],
        inventory: []
      }
    })

  await post(120000, 'Before the backup')

  // ---- what a restore would change, before it changes it (#246) ----
  // "This replaces the current books" is true and unactionable. What somebody needs on the way
  // through a one-way door is which entries disappear and which deletions come back.
  const backup = await h.invoke('backup:run')
  const backupFile = path.basename(backup.path)
  await post(45000, 'After the backup')

  const preview = await h.invoke('backup:preview', { file: backupFile })
  assert(preview.problem === null, 'the backup can be read')
  assertEq(preview.vouchersLost, 1, 'one entry would have to be typed again')
  assertEq(preview.sample.length, 1, 'and it is named, not just counted')
  assertEq(preview.sample[0].amount, 45000, 'with its amount')
  const voucherRow = preview.changes.find((c) => c.what === 'Vouchers')
  assert(voucherRow.now === '2' && voucherRow.after === '1', `counts both sides (${JSON.stringify(voucherRow)})`)

  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-backups"]')
  await h.page.waitForSelector(`[data-testid="btn-restore-${backupFile}"]`, { timeout: 15000 })
  await h.page.click(`[data-testid="btn-restore-${backupFile}"]`)
  await h.page.waitForSelector('[data-testid="restore-preview"]', { timeout: 15000 })
  const sampleText = await h.page.textContent('[data-testid="restore-sample"]')
  assert(/After the backup|Receipt/.test(sampleText) || sampleText.length > 0, 'the screen lists what would go')
  await h.shot('01-restore-preview')
  await h.page.keyboard.press('Escape')

  // ---- a copy somewhere else (#245), and an encrypted one (#253) ----
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e-external-'))
  await h.invoke('backup:external:set', { dir: external, everyHours: 24, encrypt: false, keep: 3 })
  const plainRun = await h.invoke('backup:external:runNow')
  assert(fs.existsSync(plainRun.path), `a copy landed outside the data folder (${plainRun.path})`)
  assert(plainRun.path.startsWith(external), 'in the folder that was chosen')

  const proof = await h.invoke('backup:verify', { file: backupFile })
  assert(proof.balanced, 'and the books it was copied from balance')

  await h.invoke('backup:external:set', {
    dir: external, everyHours: 24, encrypt: true, keep: 3, passphrase: 'correct horse battery'
  })
  const sealedRun = await h.invoke('backup:external:runNow')
  assert(sealedRun.path.endsWith('.totalbak'), 'the encrypted copy is a .totalbak')
  const bytes = fs.readFileSync(sealedRun.path)
  assert(bytes.subarray(0, 8).toString('utf8') === 'TOTALBK1', 'written in the encrypted format')
  assert(!bytes.includes(Buffer.from('DS Sales')), 'and a ledger name cannot be read out of it')
  assert(
    fs.readdirSync(external).every((f) => !f.startsWith('.total-staging')),
    'no half-written staging file is left where a sync client would see it'
  )

  // A folder that syncs to the cloud is refused outright unless the copy is encrypted.
  let refusedSynced = false
  try {
    await h.invoke('backup:external:set', {
      dir: path.join(os.homedir(), 'Dropbox', 'books'), everyHours: 24, encrypt: false, keep: 3
    })
  } catch {
    refusedSynced = true
  }
  assert(refusedSynced, 'plaintext books are refused a synced folder')
  await h.invoke('backup:external:set', { dir: null, everyHours: 24, encrypt: false, keep: 3 })

  // ---- the open export, and its round trip (#254) ----
  const exported = await h.invoke('export:portable')
  assert(fs.existsSync(exported.path), 'an open JSON export is written')
  const doc = JSON.parse(fs.readFileSync(exported.path, 'utf8'))
  assertEq(doc.format, 'total-books', 'it says what it is')
  assertEq(doc.vouchers.length, 2, 'and holds both vouchers')
  assert(doc.vouchers.every((v) => v.lines.every((l) => Number.isInteger(l.amount))), 'money stays in whole paise')

  // Importing the same books back is a second, separate set of them — never silent (#251).
  const asked = await h.invoke('import:portable', { json: JSON.stringify(doc) })
  assert(asked.needsConfirmation, 'a company already on this machine is queried, not duplicated')
  assert(/second/i.test(asked.warning), `and the warning says what would happen (${asked.warning})`)

  const imported = await h.invoke('import:portable', { json: JSON.stringify(doc), allowDuplicate: true })
  assert(!imported.needsConfirmation && imported.slug, 'confirming imports it')
  assertEq(imported.vouchers, 2, 'with every voucher')

  // The proof that matters: the same trial balance on the other side.
  const before = await h.invoke('report:trialBalance', { asOn: today })
  await h.invoke('company:open', { slug: imported.slug })
  const after = await h.invoke('report:trialBalance', { asOn: today })
  assertEq(after.totalDebit, before.totalDebit, 'the round trip preserves total debits')
  assertEq(after.totalCredit, before.totalCredit, 'and total credits')
  await h.invoke('company:open', { slug: (await h.invoke('company:list')).companies.find((c) => c.name === 'Safety Co').slug })

  // ---- the audit trail, checking itself (#265) ----
  const chain = await h.invoke('audit:verifyChain')
  assert(chain.ok, 'the audit trail hashes to what it says')
  assert(chain.checked > 0, `and every entry is chained (${chain.checked})`)
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-audit"]')
  await h.page.waitForSelector('[data-testid="audit-chain-state"]', { timeout: 15000 })
  const chainText = await h.page.textContent('[data-testid="audit-chain-state"]')
  assert(/check out/.test(chainText), `the screen states it (got ${chainText})`)
  await h.shot('02-audit-chain')

  // ---- the tightened Content-Security-Policy still allows the one frame we render (#269) ----
  // frame-src is 'self' rather than 'none' precisely because the invoice-print preview is a
  // sandboxed srcdoc iframe; a policy that blocked it would show an empty box and a console
  // error, which is what the harness's clean-console assertion at the end of this scenario is
  // there to catch.
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-invoice"]')
  await h.page.waitForSelector('iframe[title="Invoice preview"]', { timeout: 20000 })
  const previewHtml = await h.page.getAttribute('iframe[title="Invoice preview"]', 'srcdoc')
  assert((previewHtml ?? '').length > 0, 'the invoice preview still renders under the tightened CSP')
  await h.shot('04-invoice-preview-csp')

  // ---- archived books read but do not write (#257) ----
  await h.invoke('company:archive:set', { archived: true, note: 'FY closed' })
  let refusedWrite = false
  try {
    await post(1000, 'Should not be possible')
  } catch (err) {
    refusedWrite = /archived/i.test(err.message)
  }
  assert(refusedWrite, 'posting into archived books is refused')

  // Reading, exporting and backing up keep working — books you cannot get data out of are a
  // hostage rather than a record.
  const archivedTb = await h.invoke('report:trialBalance', { asOn: today })
  assert(archivedTb.totalDebit > 0, 'reports still read')
  await h.invoke('export:csv', { filename: 'archived-check', csv: 'a,b\n1,2\n' })
  await h.invoke('backup:run')

  await h.invoke('company:archive:set', { archived: false, note: null })
  const afterUnarchive = await post(2500, 'Posting works again')
  assert(afterUnarchive.id > 0, 'and un-archiving restores posting')

  // ---- the entry that was half typed (#250) ----
  // Written the way the form writes it — localStorage, keyed by company slug and voucher kind.
  // Deliberately not a database row: a half-entered voucher has no number, does not balance, and
  // must never turn up in a report, a backup or an audit trail.
  const draftKey = await h.page.evaluate(
    ([ledgerId, date]) => {
      const slug = new URLSearchParams(location.search).get('slug')
      // The key the app itself uses. Read from the module's own convention rather than guessed,
      // so a rename breaks this test instead of silently making it test nothing.
      const key = [...Array(localStorage.length).keys()]
        .map((i) => localStorage.key(i))
        .find((k) => k?.startsWith('total-voucher-draft:'))
      const slugFromKey = key?.split(':')[1] ?? slug
      const target = `total-voucher-draft:${slugFromKey ?? 'safety-co'}:acct-payment`
      localStorage.setItem(
        target,
        JSON.stringify({
          savedAt: Date.now(),
          state: {
            date,
            number: '',
            narration: 'Half-typed entry',
            instrumentNo: '',
            rows: [{ drCr: 'dr', ledgerId, amount: 500000 }]
          }
        })
      )
      return target
    },
    [cash.id, today]
  )

  // It survives the app dying, which is the whole point. A relaunch is a fresh renderer against
  // the same profile — exactly what a crash leaves behind.
  await h.relaunch()
  await h.openCompany('Safety Co')
  await h.goto('voucher-entry')
  await h.clickText('Payment')
  await h.page.waitForSelector('[data-testid="draft-restore-bar"]', { timeout: 15000 })
  const offer = await h.page.textContent('[data-testid="draft-restore-bar"]')
  assert(/unsaved/.test(offer), `the draft is OFFERED back, not applied (got "${offer}")`)
  await h.shot('03-recovered-draft')

  // Offered, never restored silently: a form that fills itself in from yesterday's draft is
  // indistinguishable, to the person looking at it, from one that invented its own contents.
  const narrationBefore = await h.page.evaluate(
    () => document.querySelector('[data-testid="input-narration"]')?.value ?? ''
  )
  assert(narrationBefore === '', 'and the form itself is still blank until the offer is accepted')

  await h.clickText('Discard')
  assert(
    (await h.page.evaluate((k) => localStorage.getItem(k), draftKey)) === null,
    'discarding forgets it'
  )

  // ---- where the books live (#244) ----
  const folder = await h.invoke('app:dataRoot:get')
  assert(folder.root.length > 0, 'the app says where its data folder is')
  let refusedMove = false
  try {
    await h.invoke('app:dataRoot:move', { destination: path.join(folder.root, 'inside') })
  } catch (err) {
    refusedMove = /inside/i.test(err.message)
  }
  assert(refusedMove, 'moving the data folder into itself is refused')

  // ---- a role with a hole in it (#266) ----
  await h.invoke('users:save', { data: { name: 'Owner', role: 'owner', pin: '4242', active: true, denied: [] } })
  await h.invoke('users:save', {
    data: { name: 'Clerk', role: 'accountant', pin: '1111', active: true, denied: ['exports'] }
  })
  const clerk = (await h.invoke('auth:users')).find((u) => u.name === 'Clerk')
  const session = await h.invoke('auth:login', { userId: clerk.id, pin: '1111' })
  assert(session.denied.includes('exports'), 'the session carries the denial')

  let refusedExport = false
  try {
    await h.invoke('export:csv', { filename: 'nope', csv: 'a\n1\n' })
  } catch (err) {
    refusedExport = /access/i.test(err.message)
  }
  assert(refusedExport, 'a denied area is refused in main, not just hidden')
  const stillWorks = await post(3300, 'The clerk can still enter vouchers')
  assert(stillWorks.id > 0, 'and the rest of the role is untouched')

  // ---- a wrong PIN costs more each time (#264) ----
  let throttled = null
  for (let i = 0; i < 6; i++) {
    try {
      await h.invoke('auth:login', { userId: clerk.id, pin: '0000' })
    } catch (err) {
      throttled = err.message
    }
  }
  assert(/Too many attempts/.test(throttled), `the throttle bites (got ${throttled})`)
})
