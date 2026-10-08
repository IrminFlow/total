// Scenario 38 — bulk edit and attachments (WP 6.4), through the UI:
//   Day book: tick three vouchers → Bulk edit… → narration "add at the end" → server preview (3
//   will change) → Apply → the narrations changed (audited) → Bulk edits → Undo → back as they
//   were → open a sales invoice → Files → Add files… (native picker stubbed with a real PDF) →
//   the file is listed with its hash → back up → remove the attachment (store file gone) →
//   restore that backup (listed in Settings › Backups) → the invoice's attachment list has it again, same
//   SHA-256, the stored bytes intact, and it opens (shell.openPath stubbed).
// With WP64_SHOTS set, screens are captured in both themes there.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

await scenario('38-bulk-attachments', async (h) => {
  await h.createCompanyUI('Bulk Files Co')
  const page = h.page
  const shotsDir = process.env.WP64_SHOTS
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

  // ---------- setup over IPC: three receipts and a sales invoice ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (n) => groups.find((g) => g.name === n).id
  const mk = async (name, group) => (await h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0 })).id
  const income = await mk('Misc Income', 'Indirect Incomes')
  const sales = await mk('Sales', 'Sales Accounts')
  const buyer = await mk('Kiran Stores', 'Sundry Debtors')
  const cash = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash').id
  const types = await h.invoke('master:voucherTypes:list')
  const typeOf = (k) => types.find((t) => t.kind === k).id
  const today = new Date().toISOString().slice(0, 10)
  const header = {
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
  }
  const receipts = []
  for (const [i, amount] of [11100, 22200, 33300].entries()) {
    const v = await h.invoke('voucher:save', {
      data: {
        ...header, voucherTypeId: typeOf('receipt'), date: today, partyLedgerId: null, narration: `Counter cash ${i + 1}`,
        lines: [
          { ledgerId: cash, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: income, drCr: 'cr', amount, costAllocations: [] }
        ]
      }
    })
    receipts.push(v.id)
  }
  const invoice = await h.invoke('voucher:save', {
    data: {
      ...header, voucherTypeId: typeOf('sales'), date: today, partyLedgerId: buyer, narration: 'Invoice with bill copy',
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount: 118000, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 118000, costAllocations: [] }
      ]
    }
  })
  const narrations = async () => Promise.all(receipts.map(async (id) => (await h.invoke('voucher:get', { id })).narration))

  // ---------- Day book: select three → bulk change narration ----------
  await h.goto('daybook')
  await page.waitForSelector(`[data-testid="daybook-select-${receipts[2]}"]`)
  for (const id of receipts) await h.click(`daybook-select-${id}`)
  assertEq((await page.textContent('[data-testid="daybook-bulk-count"]'))?.trim(), '3 vouchers selected', 'selection bar counts the three')
  await both('01-daybook-selected')
  await h.click('daybook-bulk-edit')
  await page.waitForSelector('[data-testid="bulk-modal"]')
  await h.fill('bulk-narration-text', '(checked)')
  await h.click('bulk-preview-run')
  await page.waitForSelector('[data-testid="rows-bulk-preview"] tr[data-status="applied"]')
  assertEq(await page.locator('[data-testid="rows-bulk-preview"] tr[data-status="applied"]').count(), 3, 'preview: three will change')
  assertEq(JSON.stringify(await narrations()), JSON.stringify(['Counter cash 1', 'Counter cash 2', 'Counter cash 3']), 'the preview changed nothing')
  await both('02-bulk-preview')
  await h.click('bulk-apply')
  await page.waitForSelector('[data-testid="bulk-modal"]', { state: 'detached' })
  assertEq(JSON.stringify(await narrations()), JSON.stringify(['Counter cash 1 (checked)', 'Counter cash 2 (checked)', 'Counter cash 3 (checked)']), 'applied')
  const audit = await h.invoke('audit:list', { entity: 'bulk_batch' })
  assert(audit.rows.length === 1, 'the batch is in the audit trail')

  // ---------- undo ----------
  await h.click('daybook-bulk-history')
  const [batch] = await h.invoke('bulk:list', { target: 'voucher' })
  await page.waitForSelector(`[data-testid="bulk-undo-${batch.id}"]`)
  await both('03-bulk-history')
  await h.click(`bulk-undo-${batch.id}`)
  await page.waitForSelector('[data-testid="bulk-undo-result"]')
  assertEq(JSON.stringify(await narrations()), JSON.stringify(['Counter cash 1', 'Counter cash 2', 'Counter cash 3']), 'undo restored them')
  assertEq((await h.invoke('bulk:list', { target: 'voucher' }))[0].status, 'undone', 'batch marked undone')
  await h.click('bulk-history-done')
  await page.waitForSelector('[data-testid="bulk-history"]', { state: 'detached' })

  // ---------- attach a PDF to the invoice (native picker stubbed) ----------
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e-pdf-'))
  const pdfPath = path.join(srcDir, 'bill-42.pdf')
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
  fs.writeFileSync(pdfPath, pdfBytes)
  const sha = createHash('sha256').update(pdfBytes).digest('hex')
  await h.stubDialogs({ openPaths: [pdfPath] })
  await page.click(`[data-testid="rows-daybook"] tr[data-row-id="${invoice.id}"] td:nth-child(3)`)
  await h.waitScreen('voucher-entry')
  await h.click('btn-attachments')
  await h.click('btn-attachment-add')
  await page.waitForSelector(`[data-testid="rows-attachments"] tr[data-sha="${sha}"]`)
  assert((await page.textContent('[data-testid="rows-attachments"]')).includes('bill-42.pdf'), 'listed by name')
  await both('04-voucher-attachments')
  await h.click('btn-attachments-done')
  const [att] = await h.invoke('attachments:list', { entity: 'voucher', entityId: invoice.id })
  assertEq(att.sha256, sha, 'stored hash')
  const slug = (await h.invoke('company:current')).slug
  const stored = path.join(h.dataDir, 'companies', slug, 'attachments', sha.slice(0, 2), sha)
  assert(fs.existsSync(stored), 'stored in the company folder, content-addressed')

  // ---------- back up, remove, restore ----------
  const backup = await h.invoke('backup:run')
  const file = path.basename(backup.path)
  await h.invoke('attachments:remove', { id: att.id })
  assert(!fs.existsSync(stored), 'removing the last reference removes the stored file')
  assertEq((await h.invoke('attachments:list', { entity: 'voucher', entityId: invoice.id })).length, 0, 'gone before the restore')

  // Settings › Backups lists it (and the attachment policy); the restore itself goes over IPC as in
  // scenario 09 (the Restore… action is owner-only and this company has no users).
  await h.goto('settings')
  await page.waitForSelector('[data-testid="settings-attachments"]')
  assert((await page.textContent('[data-testid="rows-settings-backups"]')).includes(file), 'the backup is listed')
  await both('05-settings-backups-attachments')
  const restored = await h.invoke('backup:restore', { file })
  assertEq(restored.attachments.restored, 1, 'the restore put the file back into the store')

  const after = await h.invoke('attachments:list', { entity: 'voucher', entityId: invoice.id })
  assertEq(after.length, 1, 'the attachment is back after the restore')
  assertEq(after[0].sha256, sha, 'same hash')
  assertEq(createHash('sha256').update(fs.readFileSync(stored)).digest('hex'), sha, 'stored bytes intact')

  // ---------- the attachment list after the restore (Day book row action) ----------
  await h.goto('gateway')
  await h.goto('daybook')
  await page.click(`[data-testid="rows-daybook"] tr[data-row-id="${invoice.id}"] [data-testid="btn-daybook-files"]`)
  await page.waitForSelector(`[data-testid="rows-attachments"] tr[data-sha="${sha}"]`)
  await both('06-attachments-after-restore')
  await page.click(`[data-testid="rows-attachments"] tr[data-sha="${sha}"] [data-testid="btn-attachment-open"]`)
  await page.waitForTimeout(300)
  assert(!(await page.textContent('body')).includes("Couldn't open"), 'opens (hash-checked copy handed to the viewer)')
  await h.click('btn-attachments-done')

  // ---------- extra screens for the review: ledger notes tab, credit control tasks ----------
  if (shotsDir) {
    await h.invoke('partyNotes:add', { ledgerId: buyer, kind: 'task', text: 'Collect the cheque for the March bills', dueDate: today })
    await h.invoke('partyNotes:add', { ledgerId: buyer, kind: 'note', text: 'Prefers statements by email' })
    await h.goto('gateway')
    await page.waitForSelector('[data-testid="dash-tasks-due"]')
    await both('07-dashboard-tasks-due')
    // The chip drills to Credit control, whose party tasks list the same open task.
    await h.click('dash-tasks-due')
    await h.waitScreen('receivables')
    await page.waitForSelector('[data-testid="rows-cc-tasks"] tr.dt-row')
    await page.evaluate(() => document.getElementById('party-tasks')?.scrollIntoView())
    await both('07b-credit-control-party-tasks')
    await h.goto('masters')
    await page.locator('[data-testid="rows-masters-ledgers"] tr', { hasText: 'Kiran Stores' }).getByTestId('btn-masters-edit-ledger').click()
    await h.click('tab-ledger-form-notes')
    await page.waitForSelector('[data-testid="rows-ledger-notes"] tr.dt-row')
    await both('08-ledger-notes')
    await page.keyboard.press('Escape')
    await h.click(`masters-ledgers-select-${buyer}`)
    await h.click(`masters-ledgers-select-${income}`)
    await h.click('masters-ledgers-bulk-edit')
    await page.selectOption('[data-testid="bulk-field"]', 'creditDays')
    await h.fill('bulk-credit-days', '30')
    await h.click('bulk-preview-run')
    await page.waitForSelector('[data-testid="rows-bulk-preview"] tr.dt-row')
    await both('09-masters-bulk-preview')
    await page.keyboard.press('Escape')
  }
})
