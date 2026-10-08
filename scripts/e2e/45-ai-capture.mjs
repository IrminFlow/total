// Scenario 45 — document capture (WP 5.4), offline: TOTAL_AI_MOCK=1 plays the model
// (src/main/ai/capture/mock.ts) on the Demo Traders sample company.
//   1. A PDF bill with a text layer dropped in <company>/capture-inbox/ is queued (moved to
//      processed/), nothing is sent until the cost estimate is confirmed; it is then read once
//      (masked text) and becomes a PURCHASE DRAFT: Bharat Steel Suppliers by GSTIN, Office Chair /
//      Steel Filing Cabinet by name + HSN, GST from the item masters (₹34,240.00). Review → save:
//      the voucher carries the PDF as its attachment.
//   2. A photo of the same bill dropped on the Capture screen is REFUSED as a duplicate, with a
//      link to the saved voucher.
//   3. Banking → statement → Categorise unmatched: the party named in a narration becomes a
//      receipt settling the oldest bill, the residual line goes to the (mock) assistant with its
//      candidates; Accept all → drafts; saving the receipt draft reconciles its statement line.
// Every view is shot in both themes; set WP54_SHOTS=/tmp/wp54 to copy the screenshots there.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

process.env.TOTAL_AI_MOCK = '1'
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

await scenario('45-ai-capture', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs()
  const extraShots = process.env.WP54_SHOTS
  const shot = async (name) => {
    await h.page.mouse.move(0, 0)
    await h.page.waitForTimeout(250)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.page.evaluate(() => document.querySelector('[data-testid="btn-theme"]').click())
    await h.page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await h.page.waitForTimeout(300)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }
  /** Ctrl+Enter in the editor; answers the editor's own "Save anyway?" prompts (a bill dated in
   *  an earlier year meets that year's numbering). */
  const saveInEditor = async () => {
    await h.page.click('[data-testid="ai-draft-summary"]')
    await h.page.keyboard.press('Control+Enter')
    for (let i = 0; i < 3; i++) {
      const left = await h.page
        .waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry' || document.querySelector('[data-testid="confirm-ok"]'), null, { timeout: 15000 })
        .then(() => h.page.$('[data-testid="confirm-ok"]'))
      if (!left) return
      await left.click()
    }
    await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  }
  const rows = (area) => h.page.$$(`[data-testid="rows-${area}"] tr.dt-row`)
  const statusOf = (id) => h.page.$eval(`[data-testid="rows-capture-queue"] tr[data-row-id="${id}"]`, (el) => el.getAttribute('data-status'))
  const today = await h.page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const { slug } = await h.invoke('company:current')

  // ---------- AI on (mock provider) ----------
  await h.invoke('ai:notice:accept')
  await h.invoke('ai:settings:set', { enabled: true })
  assertEq((await h.invoke('ai:settings:get')).ready, true, 'assistant ready on the mock provider')

  // ---------- 1. the inbox folder → queued → estimate → purchase draft ----------
  const inbox = await h.invoke('capture:revealInbox') // creates + watches <company>/capture-inbox
  assert(inbox.endsWith(path.join(slug, 'capture-inbox')), `inbox is the company's capture-inbox: ${inbox}`)
  const pdfPath = path.join(inbox, 'bharat-steel-bill.pdf')
  fs.copyFileSync(path.join(fixtures, 'bharat-steel-bill.pdf'), pdfPath)
  const past = new Date(Date.now() - 5000)
  fs.utimesSync(pdfPath, past, past)
  await h.goto('capture')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-capture-queue"] tr.dt-row').length === 1, null, { timeout: 20000 })
  assert(fs.readdirSync(path.join(inbox, 'processed')).some((f) => f.endsWith('-bharat-steel-bill.pdf')), 'the dropped file moved to processed/')
  const [pdfItem] = (await h.invoke('capture:list')).items
  assertEq(pdfItem.status, 'queued', 'queued, not sent')
  assertEq(pdfItem.textLayer, true, 'the PDF has a text layer')
  assertEq((await h.invoke('ai:outbound')).length, 0, 'nothing has left the machine yet')
  await bothThemes('01-capture-queued')

  await h.click('btn-capture-process')
  await h.page.waitForSelector('[data-testid="capture-estimate"]', { timeout: 10000 })
  assert((await h.page.$eval('[data-testid="capture-estimate"]', (el) => el.textContent)).includes('1 file, 1 page'), 'the estimate counts files and pages')
  await bothThemes('02-capture-estimate')
  await h.click('btn-capture-confirm')
  await h.page.waitForFunction((id) => document.querySelector(`[data-testid="rows-capture-queue"] tr[data-row-id="${id}"]`)?.getAttribute('data-status') === 'drafted', pdfItem.id, { timeout: 30000 })
  const drafted = await h.invoke('capture:get', { id: pdfItem.id })
  assertEq(drafted.invoiceNo, 'BSS/2025-26/0142', 'invoice number read')
  assertEq(drafted.total, 3_424_000, 'total read')
  const out = await h.invoke('ai:outbound')
  assertEq(out.length, 1, 'one provider call for the bill')
  assertEq(out[0].masked, true, 'the text layer was sent masked')
  assertEq(out[0].toolResultsSent.join(), 'capture:bill:text', 'sent as text')
  const draft = await h.invoke('ai:draft:get', { id: drafted.draftId })
  assertEq(draft.payload.form, 'invoice', 'a purchase invoice draft')
  assertEq(draft.payload.total, 3_424_000, 'GST from the item masters: ₹34,240.00')
  assertEq(draft.source, 'capture', 'source capture')
  await bothThemes('03-capture-drafted')

  await h.click('btn-capture-open-draft')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="invoice"]', { timeout: 10000 })
  const body = await h.page.evaluate(() => document.querySelector('[data-testid="voucher-entry-mode"]').textContent)
  for (const figure of ['29,500.00', '34,240.00']) assert(body.includes(figure), `the invoice editor shows ${figure}`)
  const banner = await h.page.$eval('[data-testid="ai-draft-banner"]', (el) => el.textContent)
  assert(banner.includes('captured file bharat-steel-bill.pdf'), `banner says where the draft came from: ${banner}`)
  await bothThemes('04-capture-review')
  await saveInEditor()
  const saved = await h.invoke('capture:get', { id: pdfItem.id })
  assertEq(saved.status, 'saved', 'the queue item is saved')
  const att = await h.invoke('attachments:list', { entity: 'voucher', entityId: saved.voucherId })
  assertEq(att.map((a) => a.fileName).join(), 'bharat-steel-bill.pdf', 'the bill is the voucher attachment')

  // ---------- 2. a photo of the same bill, dropped on the screen → refused ----------
  await h.goto('capture')
  const png = fs.readFileSync(path.join(fixtures, 'bharat-steel-bill-photo.png')).toString('base64')
  await h.page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'bharat-steel-bill-photo.png', { type: 'image/png' }))
    document.querySelector('[data-testid="capture-dropzone"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, png)
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-capture-queue"] tr.dt-row').length === 2, null, { timeout: 15000 })
  const photo = (await h.invoke('capture:list')).items.find((i) => i.fileName === 'bharat-steel-bill-photo.png')
  await h.click('btn-capture-process')
  await h.page.waitForSelector('[data-testid="capture-estimate"]', { timeout: 10000 })
  assert((await h.page.$eval('[data-testid="capture-estimate"]', (el) => el.textContent)).includes('cannot be masked'), 'photos are flagged as unmaskable before sending')
  await h.click('btn-capture-confirm')
  await h.page.waitForFunction((id) => document.querySelector(`[data-testid="rows-capture-queue"] tr[data-row-id="${id}"]`)?.getAttribute('data-status') === 'duplicate', photo.id, { timeout: 30000 })
  assertEq(await statusOf(photo.id), 'duplicate', 'the photo is refused')
  const dup = await h.invoke('capture:get', { id: photo.id })
  assertEq(dup.duplicateVoucherId, saved.voucherId, 'linked to the saved voucher')
  assertEq(dup.draftId, null, 'no draft for a duplicate')
  await bothThemes('05-capture-duplicate')

  // ---------- 3. bank statement → categorise unmatched → drafts → save reconciles ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  await h.invoke('master:ledgers:create', {
    name: 'Electricity Charges', groupId: gid('Indirect Expenses'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const hdfc = (await h.invoke('bank:ledgers')).find((b) => b.name === 'HDFC Bank')
  const d = `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`
  await h.invoke('bankImport:commit', {
    bankLedgerId: hdfc.id,
    source: {
      fileName: 'hdfc-statement.csv',
      text: ['Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance', `${d},NEFT-UMBRELLA RETAIL-UTR99887766,N1,,"1,234.56",`, `${d},ACH/MSEDCL ELECTRICITY BILL/0063311,A1,"1,617.43",,`].join('\n')
    },
    saveProfile: true
  })
  await h.goto('banking')
  await h.click('tab-banking-import')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-statement"] tr.dt-row').length === 2, null, { timeout: 15000 })
  await h.click('btn-banking-categorise')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-categorise-table"] tr.dt-row').length === 2, null, { timeout: 15000 })
  const sources = await h.page.$$eval('[data-testid="rows-categorise-table"] [data-testid="cell-categorise-source"]', (els) => els.map((e) => e.getAttribute('data-source')).sort())
  // Umbrella Retail is placed by rules (its name in the narration, or the demo's own receipt history);
  // the electricity line has no history and goes to the (mock) assistant with its candidates.
  assert(sources.includes('ai') && (sources.includes('party') || sources.includes('history')), `rules first, the assistant for the residual: ${sources.join()}`)
  await bothThemes('06-categorise-review')
  await h.click('btn-categorise-accept-all')
  await h.page.waitForSelector('[data-testid="categorise-result"]', { timeout: 15000 })
  const drafts = (await h.invoke('ai:drafts', { status: 'open' })).filter((x) => x.payload.bankLine)
  assertEq(drafts.length, 2, 'two drafts linked to their statement lines')
  const receipt = drafts.find((x) => x.payload.voucherKind === 'receipt')
  assert(receipt, 'a receipt draft')
  const umbrella = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Umbrella Retail')
  assertEq(receipt.payload.partyLedgerId, umbrella.id, 'the receipt is from Umbrella Retail')
  await bothThemes('07-categorise-drafts')
  // Open the receipt's draft from the result list (summaries name the party).
  const buttons = await h.page.$$('[data-testid="btn-categorise-open-draft"]')
  const texts = await h.page.$$eval('[data-testid="categorise-result"] > div', (els) => els.map((e) => e.textContent ?? ''))
  const at = texts.findIndex((t) => t.includes('Umbrella Retail'))
  assert(at >= 0, `the receipt is listed: ${texts.join(' | ')}`)
  await buttons[at].click()
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="ai-draft-banner"][data-form="accounting"]', { timeout: 10000 })
  await saveInEditor()
  const consumed = await h.invoke('ai:draft:get', { id: receipt.id })
  assertEq(consumed.status, 'consumed', 'the receipt draft was saved')
  const ws = await h.invoke('bankImport:workspace', { bankLedgerId: hdfc.id, includeDone: true })
  const line = ws.lines.find((l) => l.id === receipt.payload.bankLine.statementLineId)
  assertEq(line.status, 'matched', 'saving the draft reconciled the statement line')
  assertEq(line.matched[0].voucherId, consumed.voucherId, 'matched to the saved receipt')
  await h.goto('banking')
  await h.click('tab-banking-import')
  await h.page.waitForFunction(() => document.querySelectorAll('[data-testid="rows-banking-statement"] tr.dt-row').length === 1, null, { timeout: 15000 })
  await bothThemes('08-statement-after-save')
  h.assertNoConsoleErrors()
})
