// Scenario 72 — banking depth, the parts e2e 05 / 31 / 57 don't reach (WP 4.1). Demo Traders,
// accountant mode, a fresh "Statement Bank" and "PDC Bank" ledger:
//   1. statement formats through Banking → Import's file picker (native dialog stubbed): the
//      MT940 (.sta), Excel (.xlsx) and CAMT.053 (.xml) fixtures of src/shared/bankFormats/fixtures
//      are copied to temp files and imported one by one — each preview shows the format, the
//      account and exactly the lines bankFormats.test.ts expects (dates, deposits, withdrawals;
//      CAMT's pending entry is skipped with a warning); "Import N lines" stores them;
//   2. re-importing each file previews every line as "Already imported", the import button says
//      "Nothing new to import", and the bank keeps three imports and nine lines (dedupe by the
//      per-account identity: date, signed amount, narration, same-day ordinal);
//   3. post-dated cheques: two post-dated receipts from a customer against her two open bills
//      are out of the books (trial balance and Outstandings on their dates unchanged) and listed
//      Pending in Banking → Post-dated;
//   4. "Mature now" on the first brings it into the books ON ITS DATE (trial balance on that date
//      moves, today's does not) and settles its bill in Outstandings;
//   5. the second is matured, then "Bounced…" → Record bounce: a reversal payment is posted on the
//      return date, the register shows it Bounced, and its bill is open again in Outstandings
//      (a bounce reverses bill allocations) while the customer's balance is back to that bill.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq, relativeDate, fixedToday } from '../lib/harness.mjs'

const FIXTURES = path.resolve('src/shared/bankFormats/fixtures')

await scenario('72-bank-formats-pdc', async (h) => {
  const page = h.page
  await h.createDemoCompany()

  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const stmtBank = await h.invoke('master:ledgers:create', { name: 'Statement Bank', groupId: gid('Bank Accounts') })
  const pdcBank = await h.invoke('master:ledgers:create', { name: 'PDC Bank', groupId: gid('Bank Accounts') })
  const customer = await h.invoke('master:ledgers:create', { name: 'Mehta Stores', groupId: gid('Sundry Debtors') })
  const sales = await h.invoke('master:ledgers:create', { name: 'Cheque Sales', groupId: gid('Sales Accounts') })

  /** DataTable rows as { colId: text }, by the header's column order (as e2e 66 reads them). */
  const tableRows = (area) =>
    page.evaluate((a) => {
      const body = document.querySelector(`[data-testid="rows-${a}"]`)
      const table = body?.closest('table')
      if (!table) return []
      const headRow = [...table.querySelectorAll('thead tr')].find((tr) => tr.querySelector('th[data-col]'))
      const cols = [...headRow.children].map((th) => th.getAttribute('data-col'))
      return [...body.querySelectorAll(':scope > tr.dt-row')].map((tr) => {
        const out = { _id: tr.getAttribute('data-row-id'), _status: tr.getAttribute('data-status') }
        ;[...tr.children].forEach((td, i) => {
          if (cols[i]) out[cols[i]] = td.textContent.trim()
        })
        return out
      })
    }, area)
  const paise = (text) => {
    const t = (text ?? '').replace(/[^0-9.]/g, '')
    if (!t) return 0
    const [r, p = '0'] = t.split('.')
    return Number(r) * 100 + Number((p + '00').slice(0, 2))
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const display = (iso) => `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`

  // ---------- 1 + 2. MT940 / XLSX / CAMT.053 through the Import tab ----------
  const tmp = fs.mkdtempSync(path.join(h.dataDir, 'stmt-'))
  const cases = [
    {
      file: 'statement.sta', label: 'MT940', warning: null,
      lines: [['2026-08-02', 2500000, 0], ['2026-08-03', 0, 1800000], ['2026-08-05', 0, 745050], ['2026-08-09', 50000, 0]]
    },
    {
      file: 'statement.xlsx', label: null, warning: null,
      lines: [['2026-08-02', 2500000, 0], ['2026-08-03', 0, 1800000], ['2026-08-05', 0, 745050]]
    },
    {
      file: 'camt053.xml', label: 'CAMT', warning: /pending/i,
      lines: [['2026-08-02', 2500000, 0], ['2026-08-05', 0, 745050]]
    }
  ]
  for (const c of cases) {
    c.path = path.join(tmp, c.file)
    fs.copyFileSync(path.join(FIXTURES, c.file), c.path)
  }

  await h.goto('banking')
  await page.selectOption('[data-testid="banking-ledger"]', String(stmtBank.id))
  await h.click('tab-banking-import')
  await page.waitForSelector('[data-testid="rows-banking-statement"]', { state: 'attached', timeout: 10000 })

  const openPreview = async (c) => {
    await h.stubDialogs({ openPaths: [c.path] })
    await h.click('btn-banking-pick-statement')
    await page.waitForSelector('[data-testid="banking-import-preview"]', { timeout: 15000 })
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="rows-banking-import-lines"] > tr.dt-row').length === k, c.lines.length, { timeout: 10000 })
    return page.textContent('[data-testid="banking-import-preview"]')
  }
  const cancelPreview = async () => {
    await page.locator('[data-testid="banking-import-preview"] button', { hasText: /^Cancel$/ }).click()
    await page.waitForSelector('[data-testid="banking-import-preview"]', { state: 'detached', timeout: 10000 })
  }
  const checkLines = async (c, status) => {
    const rows = await tableRows('banking-import-lines')
    assertEq(
      JSON.stringify(rows.map((r) => [r.date, paise(r.deposit), paise(r.withdrawal), r.dup])),
      JSON.stringify(c.lines.map(([d, dep, wd]) => [display(d), dep, wd, status])),
      `${c.file}: preview lines (date, deposit, withdrawal, status)`
    )
  }

  let n = 0
  for (const c of cases) {
    const text = await openPreview(c)
    assert(text.includes(c.file), `${c.file}: the preview names the file`)
    if (c.label) assert(text.includes(c.label), `${c.file}: format badge ${c.label} (got ${text.slice(0, 200)})`)
    if (c.file !== 'statement.xlsx') assert(text.includes('Account 50100012345678'), `${c.file}: account number read from the statement`)
    if (c.warning) assert(c.warning.test(text), `${c.file}: pending entry warning shown`)
    await checkLines(c, 'New')
    const btn = page.locator('[data-testid="btn-banking-commit-import"]')
    assertEq((await btn.textContent()).trim(), `Import ${c.lines.length} lines`, `${c.file}: import button counts the new lines`)
    if (n === 0) await h.shot('01-mt940-preview')
    await btn.click()
    await page.waitForSelector('[data-testid="banking-import-preview"]', { state: 'detached', timeout: 10000 })
    n += c.lines.length
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="rows-banking-statement"] > tr.dt-row').length === k, n, { timeout: 10000 })
  }
  const imports = await h.invoke('bankImport:imports', { bankLedgerId: stmtBank.id })
  assertEq(
    JSON.stringify(imports.map((i) => [i.format, i.lineCount]).sort()),
    JSON.stringify([['camt053', 2], ['mt940', 4], ['xlsx', 3]]),
    'three imports with their line counts'
  )
  await h.shot('02-statement-lines')

  for (const c of cases) {
    const text = await openPreview(c)
    await checkLines(c, 'Already imported')
    assert(/New lines\s*0/.test(text), `${c.file}: re-import has 0 new lines`)
    const btn = page.locator('[data-testid="btn-banking-commit-import"]')
    assertEq((await btn.textContent()).trim(), 'Nothing new to import', `${c.file}: nothing to import again`)
    assert(await btn.isDisabled(), `${c.file}: the import button is disabled`)
    if (c.file === 'statement.sta') await h.shot('03-mt940-reimport')
    await cancelPreview()
  }
  assertEq((await h.invoke('bankImport:imports', { bankLedgerId: stmtBank.id })).length, 3, 're-imports recorded no import')
  const ws = await h.invoke('bankImport:workspace', { bankLedgerId: stmtBank.id })
  assertEq(ws.lines.length, 9, 'the bank still holds nine statement lines')

  // ---------- 3. two post-dated receipts against two open bills ----------
  const types = await h.invoke('master:voucherTypes:list')
  const vt = (kind) => types.find((t) => t.kind === kind && t.isSystem !== false).id
  const bill = (name, amount) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: vt('sales'), date: fixedToday, partyLedgerId: customer.id, reference: name,
        lines: [{ ledgerId: customer.id, drCr: 'dr', amount }, { ledgerId: sales.id, drCr: 'cr', amount }],
        billRefs: [{ kind: 'new', name, amount, dueDate: null }]
      }
    })
  await bill('MS-101', 3000000)
  await bill('MS-102', 1500000)
  const d1 = relativeDate(4)
  const d2 = relativeDate(6)
  const pdcReceipt = (date, name, amount, chq) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: vt('receipt'), date, partyLedgerId: customer.id, instrumentNo: chq, postDated: true,
        lines: [{ ledgerId: pdcBank.id, drCr: 'dr', amount }, { ledgerId: customer.id, drCr: 'cr', amount }],
        billRefs: [{ kind: 'against', name, amount, dueDate: null }]
      }
    })
  const p1 = await pdcReceipt(d1, 'MS-101', 3000000, '700001')
  const p2 = await pdcReceipt(d2, 'MS-102', 1500000, '700002')

  const tbRow = async (asOn, ledgerId) => {
    const r = (await h.invoke('report:trialBalance', { asOn })).rows.find((x) => x.ledgerId === ledgerId)
    return r ? r.debit - r.credit : 0
  }
  const openBills = async (asOn) => {
    const party = (await h.invoke('analysis:outstandings', { side: 'receivable', asOn })).find((p) => p.ledgerId === customer.id)
    return party ? party.bills.filter((b) => b.pending > 0).map((b) => `${b.number}:${b.pending}`).sort().join(',') : ''
  }
  assertEq(await tbRow(d2, customer.id), 4500000, 'post-dated receipts are out of the books: customer owes both bills on their dates')
  assertEq(await tbRow(d2, pdcBank.id), 0, 'post-dated receipts are out of the books: the bank has nothing')
  assertEq(await openBills(d2), 'MS-101:3000000,MS-102:1500000', "both bills open in Outstandings on the cheques' dates")

  await h.click('tab-banking-pdc')
  const pdcRow = (id) => `[data-testid="rows-banking-pdc"] tr[data-row-id="${id}"]`
  await page.waitForSelector(`${pdcRow(p1.id)}[data-status="pending"]`, { timeout: 10000 })
  await page.waitForSelector(`${pdcRow(p2.id)}[data-status="pending"]`, { timeout: 10000 })
  const reg = await tableRows('banking-pdc')
  const r1 = reg.find((r) => r._id === String(p1.id))
  assertEq(r1.direction, 'Received', 'PDC 1 is a received cheque')
  assertEq(r1.party, 'Mehta Stores', 'PDC 1 party')
  assertEq(r1.instrument, '700001', 'PDC 1 cheque number')
  assertEq(paise(r1.amount), 3000000, 'PDC 1 amount')
  assertEq(r1.date, display(d1), 'PDC 1 matures on its date')
  await h.shot('04-pdc-pending')

  // ---------- 4. Mature now → in the books on its own date ----------
  await page.click(`${pdcRow(p1.id)} [data-testid="btn-banking-pdc-mature"]`)
  await h.click('confirm-ok')
  await page.waitForSelector(`${pdcRow(p1.id)}[data-status="matured"]`, { timeout: 10000 })
  const v1 = await h.invoke('voucher:get', { id: p1.id })
  assert(!v1.postDated, 'PDC 1 is no longer post-dated')
  assertEq(v1.date, d1, 'maturing keeps the cheque date')
  assertEq(await tbRow(d1, customer.id), 1500000, 'on its date the matured receipt reduces the customer')
  assertEq(await tbRow(d1, pdcBank.id), 3000000, 'on its date the matured receipt is in the bank')
  assertEq(await tbRow(fixedToday, pdcBank.id), 0, 'today the bank is unchanged (the cheque is dated ahead)')
  assertEq(await tbRow(fixedToday, customer.id), 4500000, 'today the customer still owes both bills')
  assertEq(await openBills(d1), 'MS-102:1500000', 'MS-101 settled in Outstandings on the cheque date')

  // ---------- 5. mature + bounce the second → its bill is open again ----------
  await page.click(`${pdcRow(p2.id)} [data-testid="btn-banking-pdc-mature"]`)
  await h.click('confirm-ok')
  await page.waitForSelector(`${pdcRow(p2.id)}[data-status="matured"]`, { timeout: 10000 })
  assertEq(await openBills(d2), '', 'both bills settled once the second cheque matured')
  assertEq(await tbRow(d2, customer.id), 0, 'customer settled on the second cheque date')
  await page.click(`${pdcRow(p2.id)} [data-testid="btn-banking-pdc-bounce"]`)
  await page.waitForSelector('[data-testid="btn-banking-bounce-save"]', { timeout: 10000 })
  await h.fill('input-banking-bounce-reason', 'Funds insufficient')
  await h.shot('05-bounce-modal')
  await h.click('btn-banking-bounce-save')
  await page.waitForSelector('[data-testid="btn-banking-bounce-save"]', { state: 'detached', timeout: 10000 })
  // Bounced cheques are listed under "Show all matured & bounced".
  await h.click('input-banking-pdc-all')
  await page.waitForSelector(`${pdcRow(p2.id)}[data-status="bounced"]`, { timeout: 10000 })
  const reg2 = await h.invoke('pdc:register', { today: fixedToday })
  const b = reg2.find((r) => r.voucherId === p2.id)
  assertEq(b.bouncedOn, d2, 'bounce recorded on the return date (the modal default: the cheque date)')
  assertEq(b.bounceReason, 'Funds insufficient', 'bounce reason kept')
  const rev = await h.invoke('voucher:get', { id: b.bounceVoucherId })
  assertEq(rev.date, d2, 'the reversal is dated the return date')
  assertEq(
    JSON.stringify(rev.lines.map((l) => [l.ledgerId, l.drCr, l.amount]).sort()),
    JSON.stringify([[customer.id, 'dr', 1500000], [pdcBank.id, 'cr', 1500000]].sort()),
    'the reversal mirrors the receipt'
  )
  assertEq(JSON.stringify(rev.billRefs.map((r) => [r.kind, r.name, r.amount])), JSON.stringify([['new', 'MS-102', 1500000]]), 'the reversal re-opens bill MS-102')
  assertEq(await openBills(d2), 'MS-102:1500000', 'MS-102 is open again in Outstandings')
  assertEq(await tbRow(d2, customer.id), 1500000, 'the customer owes MS-102 again')
  assertEq(await tbRow(d2, pdcBank.id), 3000000, 'the bank keeps only the cleared cheque')
  assertEq(await tbRow(d1, pdcBank.id), 3000000, 'the first cheque is untouched by the bounce')
  assert((await page.textContent(pdcRow(p2.id))).includes('Reversed by'), 'the register links the reversal')
  await h.shot('06-pdc-bounced')
})
