// Scenario 32 — receivables (WP 4.2), driven through the UI on the demo company:
//   an overdue invoice (IPC setup: a customer at 18% p.a., 30 credit days, 5 grace days; a sales
//   invoice 100 days old) → Outstandings: Remind logs the letter for its bucket and opens the
//   email draft (mailto: captured in main) → a follow-up with a promised date on the bill →
//   Credit control › Interest: the preview's days / interest / GST, Post party → a balanced debit
//   note with the GST split, nothing left to charge → SOA: statement preview, Save PDF (a real PDF
//   in exports/statements) → Credit control: Hold with a reason → a new sales invoice to the party
//   is blocked (nothing saved) until an owner override with a reason (audited) → Gateway chip.
// With WP42_SHOTS set, screens are captured in both themes there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('32-receivables', async (h) => {
  await h.createDemoCompany()
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true })
  await h.relaunch()
  assertEq(await h.openCompany('Demo Traders'), 'gateway', 'demo company reopens')
  const page = h.page
  await h.stubDialogs()
  // The email hand-off: capture mailto: links instead of opening the mail app.
  await h.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => {
      globalThis.__opened.push(url)
    }
  })
  const opened = () => h.app.evaluate(() => globalThis.__opened)

  const shotsDir = process.env.WP42_SHOTS
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
  const both = async (name) => {
    await h.shot(name)
    if (!shotsDir) return
    for (const want of ['light', 'dark']) {
      if ((await theme()) !== want) await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(shotsDir, `${name}-${want}.png`) })
    }
    if ((await theme()) !== 'light') await page.evaluate(() => document.querySelector('[data-testid="btn-theme"]')?.click())
  }
  const printShot = async (name, html) => {
    if (!shotsDir) return
    await page.evaluate((srcdoc) => {
      const f = document.createElement('iframe')
      f.id = 'e2e-print-preview'
      f.srcdoc = srcdoc
      f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;background:#fff;border:0'
      document.body.appendChild(f)
    }, html)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
    await page.evaluate(() => document.getElementById('e2e-print-preview')?.remove())
  }
  const bodyHas = (text, timeout = 8000) =>
    page.waitForFunction((t) => document.body.textContent?.includes(t), text, { timeout })

  // ---------- setup: a late payer with one invoice 100 days old ----------
  const today = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const party = await h.invoke('master:ledgers:create', {
    name: 'E2E Late Payer', groupId: gid('Sundry Debtors'), openingBalance: 0, gstin: null, stateCode: null, address: '7 Mill Road',
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 30, exportType: null,
    email: 'accounts@latepayer.example', interestRateBp: 1800, interestGraceDays: 5
  })
  const service = await h.invoke('master:ledgers:create', {
    name: 'E2E Service Income', groupId: gid('Sales Accounts'), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: 18, hsn: '998314', tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const taxLedger = async (t) =>
    ledgers.find((l) => l.taxType === t && /output/i.test(l.name)) ??
    ledgers.find((l) => l.taxType === t) ??
    (await h.invoke('master:ledgers:create', { name: t.toUpperCase(), groupId: gid('Duties & Taxes'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: t, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }))
  const cgst = await taxLedger('cgst')
  const sgst = await taxLedger('sgst')
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (kind) => types.find((t) => t.kind === kind)
  const billDate = addDays(today, -100)
  const inv = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: typeOf('sales').id, date: billDate, partyLedgerId: party.id, number: 'E2E-INV-1', narration: 'Consulting',
      lines: [
        { ledgerId: party.id, drCr: 'dr', amount: 11_800_00 },
        { ledgerId: service.id, drCr: 'cr', amount: 10_000_00 },
        { ledgerId: cgst.id, drCr: 'cr', amount: 900_00 },
        { ledgerId: sgst.id, drCr: 'cr', amount: 900_00 }
      ],
      inventory: [], billRefs: []
    }
  })
  const FAR = '2099-12-31'
  const count = async (kind) => (await h.invoke('voucher:list', { from: '2000-01-01', to: FAR, voucherTypeId: typeOf(kind).id })).length

  // ---------- 1. Outstandings → Remind ----------
  await h.goto('outstandings', 20000)
  const row = `[data-testid="rows-outstandings"] tr.dt-row[data-row-id="${party.id}"]`
  await page.waitForSelector(row, { timeout: 15000 })
  await page.click(`${row} [data-testid="btn-outstandings-remind"]`)
  await bodyHas('reminder logged')
  const log = await h.invoke('receivables:reminderLog', { from: '2000-01-01', to: FAR })
  assertEq(log.length, 1, 'one reminder logged')
  assertEq(log[0].bucket, 'final', '70 days overdue gets the final letter')
  assertEq(log[0].channel, 'email', 'logged as email')
  assert(fs.existsSync(log[0].documentPath) && fs.readFileSync(log[0].documentPath).subarray(0, 4).toString() === '%PDF', 'the letter is a real PDF')
  const mails = await opened()
  assert(mails.some((u) => u.startsWith('mailto:accounts@latepayer.example?subject=Final%20notice')), `the email draft opens to the party: ${mails.join(' ')}`)
  // Twice within the cadence window asks first; cancel leaves the log alone.
  await page.click(`${row} [data-testid="btn-outstandings-remind"]`)
  await page.waitForSelector('[data-testid="confirm-cancel"]', { timeout: 5000 })
  await h.click('confirm-cancel')
  assertEq((await h.invoke('receivables:reminderLog', { from: '2000-01-01', to: FAR })).length, 1, 'no second reminder within 7 days')

  // ---------- 2. a follow-up with a promised date ----------
  // A blank cell of the row expands its bills (the name opens the ledger, buttons act).
  const box = await page.$eval(row, (tr) => {
    const td = [...tr.querySelectorAll('td')].find((c) => !c.querySelector('button, a, [role="button"]') && c.offsetWidth > 40)
    const r = (td ?? tr).getBoundingClientRect()
    return { x: r.left + r.width - 8, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
  const bills = `[data-testid="outstandings-bills-${party.id}"]`
  await page.waitForSelector(bills, { timeout: 10000 })
  await page.click(`${bills} [data-testid="btn-followup-add"]`)
  await page.fill('[data-testid="input-followup-note"]', 'Spoke to accounts — cheque on Friday')
  const promised = today
  const [py, pm, pd] = promised.split('-')
  await page.fill('[data-testid="input-followup-promised"]', `${pd}/${pm}/${py}`)
  await page.press('[data-testid="input-followup-promised"]', 'Tab')
  await h.click('btn-followup-save')
  await page.waitForFunction((sel) => document.querySelector(sel)?.querySelector('[data-testid="bill-followup"]')?.textContent?.includes('Promised'), bills, { timeout: 8000 })
  const fu = await h.invoke('receivables:followups', { ledgerId: party.id })
  assertEq(fu.length, 1, 'follow-up saved')
  assertEq(fu[0].promisedDate, promised, 'promised date saved')
  assertEq(fu[0].billVoucherId, inv.id, 'on the invoice')
  await both('01-outstandings-followup')

  // ---------- 3. Interest: preview and post ----------
  await h.goto('receivables', 20000)
  await h.click('tab-receivables-interest')
  const irow = `[data-testid="rows-interest-preview"] tr.dt-row[data-row-id="${party.id}"]`
  await page.waitForSelector(irow, { timeout: 15000 })
  const preview = (await h.invoke('receivables:interestPreview', { asOn: today })).filter((r) => r.ledgerId === party.id)
  assertEq(preview.length, 1, 'one bill accrues interest')
  assertEq(preview[0].days, 65, '100 days − 30 credit − 5 grace')
  assertEq(preview[0].interestPaise, Math.round((11_800_00 * 0.18 * 65) / 365), 'simple interest at 18% for 65 days')
  assert(preview[0].gst.length === 1 && preview[0].gst[0].rate === 18, 'GST at the supply’s 18%')
  await both('02-interest-preview')
  const dnBefore = await count('debit_note')
  await page.click(`${irow} [data-testid="btn-interest-post"]`)
  await page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 5000 })
  await h.click('confirm-ok')
  await bodyHas('posted')
  assertEq(await count('debit_note'), dnBefore + 1, 'a debit note is posted')
  const charges = await h.invoke('receivables:interestCharges', { ledgerId: party.id })
  assertEq(charges.length, 1, 'the bill-period is recorded')
  const dn = await h.invoke('voucher:get', { id: charges[0].debitNoteVoucherId })
  const side = (s) => dn.lines.filter((l) => l.drCr === s).reduce((a, l) => a + l.amount, 0)
  assertEq(side('dr'), side('cr'), 'the debit note balances')
  const taxOf = new Map((await h.invoke('master:ledgers:list')).map((l) => [l.id, l.taxType]))
  const taxCr = dn.lines.filter((l) => taxOf.get(l.ledgerId) === 'cgst' || taxOf.get(l.ledgerId) === 'sgst').reduce((a, l) => a + l.amount, 0)
  assertEq(taxCr, charges[0].gstPaise, 'CGST + SGST on the note')
  assertEq(side('dr'), charges[0].interestPaise + charges[0].gstPaise, 'Dr party = interest + GST')
  assertEq((await h.invoke('receivables:interestPreview', { asOn: today })).filter((r) => r.ledgerId === party.id).length, 0, 'nothing left to charge today')
  await page.waitForFunction((sel) => !document.querySelector(sel), irow, { timeout: 8000 })
  await both('03-interest-posted')

  // ---------- 4. Statement of account ----------
  await h.goto('outstandings', 20000)
  await page.waitForSelector(row, { timeout: 15000 })
  await page.click(`${row} [data-testid="btn-outstandings-soa"]`)
  await page.waitForSelector('[data-testid="statement-modal"] [data-testid="print-paper"]', { timeout: 15000 })
  await both('04-statement-preview')
  await h.click('btn-statement-pdf')
  await bodyHas('Statement saved')
  const slug = (await h.invoke('company:current')).slug
  const dir = path.join(h.dataDir, 'companies', slug, 'exports', 'statements')
  const pdfs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')) : []
  assert(pdfs.some((f) => f.includes('E2E-Late-Payer')), `statement PDF written (${dir}: ${pdfs.join(', ')})`)
  assertEq(fs.readFileSync(path.join(dir, pdfs.find((f) => f.includes('E2E-Late-Payer')))).subarray(0, 4).toString(), '%PDF', 'a real PDF')
  const stmt = await h.invoke('receivables:statement', { ledgerId: party.id, from: addDays(today, -200), to: today })
  const ls = await h.invoke('report:ledger', { ledgerId: party.id, from: addDays(today, -200), to: today })
  assertEq(stmt.data.closing, ls.closing, 'statement closing = ledger statement closing')
  assertEq(stmt.data.rows.length, 2, 'invoice and interest note on the statement')
  await printShot('05-statement-print', stmt.html)
  await page.keyboard.press('Escape')

  // ---------- 5. Credit hold blocks a new invoice ----------
  await h.goto('receivables', 20000)
  await h.click('tab-receivables-control')
  const crow = `[data-testid="rows-credit-control"] tr.dt-row[data-row-id="${party.id}"]`
  await page.waitForSelector(crow, { timeout: 15000 })
  await page.click(`${crow} [data-testid="btn-credit-hold"]`)
  await page.fill('[data-testid="prompt-input"]', '90+ days overdue, interest unpaid')
  await h.click('prompt-ok')
  await page.waitForSelector(`${crow} [data-testid="badge-credit-hold"]`, { timeout: 8000 })
  await both('06-credit-control')

  const pick = async (testId, text) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(text)
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
    await input.press('Enter')
  }
  await h.goto('voucher-entry')
  await h.click('tab-voucher-entry-sales')
  await page.waitForSelector('[data-testid="rows-invoice-lines"]', { timeout: 10000 })
  await pick('picker-party', 'E2E Late Payer')
  await page.waitForSelector('[data-testid="invoice-credit-hold"]', { timeout: 8000 })
  const salesAcc = ledgers.find((l) => groups.find((g) => g.id === l.groupId)?.name === 'Sales Accounts')
  const acct = page.locator('input[placeholder="e.g. Sales"]')
  await acct.click()
  await acct.fill(salesAcc.name)
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 })
  await acct.press('Enter')
  const item = (await h.invoke('master:stockItems:list'))[0]
  await pick('picker-item', item.name)
  const qty = page.locator('[data-testid="input-line-qty"]').first()
  await qty.fill('1')
  await qty.press('Tab')
  const rate = page.locator('[data-testid="input-line-rate"]').first()
  await rate.fill('500')
  await rate.press('Tab')
  await both('07-invoice-credit-hold')
  const salesBefore = await count('sales')
  await h.click('btn-save-voucher')
  await bodyHas('is on credit hold')
  await page.waitForTimeout(500)
  assertEq(await count('sales'), salesBefore, 'the invoice is blocked')
  // The server refuses it too (the banner is not the only gate).
  const direct = await page.evaluate(([p, t, s]) => window.total.invoke('voucher:save', {
    data: { voucherTypeId: t, date: new Date().toISOString().slice(0, 10), partyLedgerId: p, lines: [{ ledgerId: p, drCr: 'dr', amount: 100 }, { ledgerId: s, drCr: 'cr', amount: 100 }], inventory: [], billRefs: [] }
  }), [party.id, typeOf('sales').id, service.id])
  assert(!direct.ok && direct.error.startsWith('Credit hold:'), `saveVoucher refuses: ${direct.error}`)
  // Owner override (the demo company has no users: the user is the owner).
  await h.click('btn-credit-override')
  await page.fill('[data-testid="prompt-input"]', 'Owner approved: advance received')
  await h.click('prompt-ok')
  await bodyHas('Owner override')
  await h.click('btn-save-voucher')
  await page.waitForFunction(
    async ([id, want]) => {
      const r = await window.total.invoke('voucher:list', { from: '2000-01-01', to: '2099-12-31', voucherTypeId: id })
      return r.ok && r.data.length === want
    },
    [typeOf('sales').id, salesBefore + 1],
    { timeout: 10000, polling: 200 }
  )
  const audit = await h.invoke('audit:list', { entity: 'credit_override', page: 0 })
  assertEq(audit.rows.length, 1, 'the override is in the audit trail')
  assert(JSON.stringify(audit.rows[0]).includes('advance received'), 'with its reason')

  // ---------- 6. reminders / collections / settings / gateway ----------
  await h.goto('receivables', 20000)
  await h.click('tab-receivables-reminders')
  await page.waitForSelector('[data-testid="rows-reminder-log"] tr.dt-row', { timeout: 10000 })
  await both('08-reminders')
  await h.click('tab-receivables-collections')
  await page.waitForSelector('[data-testid="rows-collections"] tr.dt-row', { timeout: 15000 })
  await both('09-collections')
  await h.goto('settings')
  await h.click('tab-settings-receivables')
  await page.waitForSelector('[data-testid="settings-receivables"]', { timeout: 10000 })
  await both('10-settings-receivables')
  await h.goto('gateway', 20000)
  await page.waitForSelector('[data-testid="chip-promised-week"]', { timeout: 15000 })
  await both('11-gateway-promised')

  h.assertNoConsoleErrors()
  h.assertNoKeyWarnings()
})
