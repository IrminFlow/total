// Scenario 18 — print templates (WP 1.10c): open Settings → Invoice templates, move a column and
// hide another in the Classic template, watch the live preview follow, save, print the test page
// and a real demo invoice, and assert both PDFs land on disk. Then make Modern the sales default
// and check the next invoice PDF uses it. Screenshots of the designer in both themes.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'

/** Header texts of the preview iframe's line-item table. */
const previewHeaders = (h) =>
  h.page.evaluate(() => {
    const doc = document.querySelector('[data-testid="settings-tpl-preview"] iframe')?.contentDocument
    return [...(doc?.querySelectorAll('table.items thead th') ?? [])].map((th) => th.textContent)
  })

const assertPdf = (path, label) => {
  assert(typeof path === 'string' && fs.existsSync(path), `${label}: PDF exists (${path})`)
  const head = fs.readFileSync(path).subarray(0, 5).toString('latin1')
  assertEq(head, '%PDF-', `${label}: file is a PDF`)
  assert(fs.statSync(path).size > 5000, `${label}: PDF is not empty`)
}

await scenario('18-print-templates', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs()
  // Record what the app asks the OS to open (test page / invoice PDFs) instead of opening it.
  await h.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openPath = async (p) => {
      globalThis.__opened.push(p)
      return ''
    }
  })
  const opened = () => h.app.evaluate(() => globalThis.__opened)

  await h.goto('settings')
  await h.click('tab-settings-invoice')
  await h.page.waitForSelector('[data-testid="rows-settings-tpl-list"] [data-row-id="modern"]', { timeout: 15000 })
  await h.page.waitForFunction(
    () => (document.querySelector('[data-testid="settings-tpl-preview"] iframe')?.getAttribute('srcdoc') ?? '').includes('TAX INVOICE'),
    null,
    { timeout: 15000 }
  )
  await h.page.waitForTimeout(400) // iframe load + measure
  assertEq(JSON.stringify(await previewHeaders(h)), JSON.stringify(['#', 'Description', 'HSN', 'Qty', 'Rate', 'GST', 'Amount']), 'Classic preview starts with the legacy columns')
  await h.shot('01-designer-light')

  // Columns: Rate above Qty, hide HSN.
  await h.click('tab-settings-tpl-columns')
  await h.click('btn-settings-tpl-col-up-rate')
  await h.click('input-settings-tpl-col-hsn')
  await h.page.waitForFunction(
    () => {
      const doc = document.querySelector('[data-testid="settings-tpl-preview"] iframe')?.contentDocument
      const hs = [...(doc?.querySelectorAll('table.items thead th') ?? [])].map((th) => th.textContent)
      return hs.join('|') === '#|Description|Rate|Qty|GST|Amount'
    },
    null,
    { timeout: 10000 }
  )
  await h.shot('02-columns-edited')
  await h.click('btn-settings-tpl-save')
  await h.page.waitForFunction(() => !document.querySelector('[data-testid="settings-tpl-editing"]')?.textContent?.includes('unsaved'), null, { timeout: 10000 })
  const classic = await h.invoke('template:get', { id: 'classic' })
  const order = classic.columns.filter((c) => c.visible).map((c) => c.key)
  assertEq(order.join(','), 'sl,item,rate,qty,gstRate,taxable', 'saved Classic column order')
  // The old config channel sees the HSN column off.
  assertEq((await h.invoke('config:invoice:get')).showHsn, false, 'config:invoice:get maps onto Classic')

  // Print test page → a PDF of the sample.
  await h.click('btn-settings-tpl-test-page')
  await h.page.waitForFunction(() => document.body.innerText.includes('Test page saved'), null, { timeout: 30000 })
  const testPdf = (await opened()).find((p) => p.includes('print-test-classic'))
  assertPdf(testPdf, 'test page')

  // A real demo invoice prints with the saved Classic template.
  const invoices = await h.invoke('edoc:list', { from: '2000-01-01', to: '2099-12-31' })
  const sale = invoices.find((r) => r.docType === 'INV')
  assert(sale, 'demo company has a sales invoice')
  const { html } = await h.invoke('template:previewHtml', { template: classic, voucherId: sale.voucherId })
  assert(!html.includes('>HSN<'), 'real invoice HTML drops the hidden HSN column')
  const { path: invPdf } = await h.invoke('invoice:pdf', { voucherId: sale.voucherId })
  assertPdf(invPdf, 'invoice')

  // Modern as the sales default → the next invoice PDF renders Modern.
  await h.page.click('[data-testid="rows-settings-tpl-list"] [data-row-id="modern"]')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="settings-tpl-editing"]')?.textContent?.includes('Modern'), null, { timeout: 10000 })
  await h.click('btn-settings-tpl-default-sales')
  await h.page.waitForFunction(
    () => document.querySelector('[data-testid="btn-settings-tpl-default-sales"]')?.getAttribute('aria-pressed') === 'true',
    null,
    { timeout: 10000 }
  )
  assertEq((await h.invoke('template:list')).defaults.sales, 'modern', 'sales default is Modern')
  const { path: modernPdf } = await h.invoke('invoice:pdf', { voucherId: sale.voucherId })
  assertPdf(modernPdf, 'invoice with Modern')

  // Dark theme: the chrome changes, the paper stays white.
  await h.click('btn-theme')
  await h.page.waitForTimeout(400)
  const paperBg = await h.page.evaluate(() => {
    const inner = document.querySelector('[data-testid="print-paper"] > div')
    return inner ? getComputedStyle(inner).backgroundColor : null
  })
  assertEq(paperBg, 'rgb(255, 255, 255)', 'preview paper is white in dark theme')
  await h.shot('03-designer-dark')
  await h.click('btn-theme')
})
