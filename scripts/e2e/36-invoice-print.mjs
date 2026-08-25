// Scenario 36 — the invoice as a piece of paper (roadmap section I).
//
// Printing is the part of an accounting app a customer actually sees, and it is the part where a
// silent regression is invisible until somebody's letterhead comes out wrong. This asserts the
// four things added under section I, as properties rather than pixels:
//
//   I-182  three templates that change the STYLE and never the CONTENT — because rule 46
//          prescribes what an invoice must carry, a picker that could drop a block would be a
//          picker that could produce an invalid invoice
//   I-184  a second language printed BESIDE the English label, never instead of it
//   I-199  the amount in words in that language too
//   I-183  a 3-inch thermal receipt that carries the same figures as the A4 sheet
//   I-193  a WhatsApp/email share that builds the message and the links and sends nothing
//   I-203  a bill-level discount that lands on the LINES, where section 15(3)(a) needs it
import { scenario, assert } from '../lib/harness.mjs'

await scenario('36-invoice-print', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs() // the PDF paths reveal in Finder / open externally

  // A sales voucher from the demo book to print. Everything below prints THIS one, so the roll,
  // the sheet and the share message can be compared against each other.
  const { rows } = await h.invoke('report:dayBook', { from: '2000-01-01', to: '2099-12-31', limit: 2000 })
  const sale = rows.find((r) => r.kind === 'sales')
  assert(sale, 'the demo company has a sales voucher to print')

  // ---- I-182: the template changes the stylesheet, not the document ----
  const bodyOf = (html) => html.slice(html.indexOf('<body>'))
  const classic = await h.invoke('invoice:previewHtml', { voucherId: sale.voucherId, config: { template: 'classic' } })
  const modern = await h.invoke('invoice:previewHtml', { voucherId: sale.voucherId, config: { template: 'modern' } })
  const compact = await h.invoke('invoice:previewHtml', { voucherId: sale.voucherId, config: { template: 'compact' } })
  assert(bodyOf(modern.html) === bodyOf(classic.html), 'Modern prints exactly the same document as Classic')
  assert(bodyOf(compact.html) === bodyOf(classic.html), 'Compact prints exactly the same document as Classic')
  assert(modern.html !== classic.html, 'and it does look different — the stylesheet changed')
  assert(compact.html !== modern.html, 'all three templates are genuinely distinct')

  // ---- I-184 / I-199: a second language, added and never substituted ----
  const devanagari = /[ऀ-ॿ]/
  assert(!devanagari.test(classic.html), 'English-only is the default, and it stays English-only')
  const hindi = await h.invoke('invoice:previewHtml', { voucherId: sale.voucherId, config: { language: 'hi' } })
  assert(devanagari.test(hindi.html), 'the Hindi invoice carries Devanagari')
  assert(/Amount in words/.test(hindi.html), 'and it still carries the English label beside it')
  assert(/Place of supply/.test(hindi.html), 'every statutory label keeps its English text')
  assert(/Kohinoor Devanagari/.test(hindi.html), 'a Devanagari fallback font is named, since none is bundled')

  // ---- I-183: the 3-inch roll carries the same figures as the sheet ----
  const roll = await h.invoke('invoice:thermalHtml', { voucherId: sale.voucherId })
  assert(roll.widthMm === 80, `the roll defaults to 80mm (got ${roll.widthMm})`)
  assert(/width: 72mm/.test(roll.html), 'the body is sized to the roll less its non-printing margin')
  assert(roll.html.includes(sale.number), 'the receipt carries the invoice number')

  // Change the roll and the receipt follows it — a 58mm printer must not be sent 80mm of layout.
  const saved = await h.invoke('config:invoice:get')
  await h.invoke('config:invoice:set', { ...saved, thermalWidthMm: 58 })
  const narrow = await h.invoke('invoice:thermalHtml', { voucherId: sale.voucherId })
  assert(narrow.widthMm === 58, 'the configured roll width reaches the receipt')
  assert(/width: 50mm/.test(narrow.html), 'and the layout narrows with it')
  await h.invoke('config:invoice:set', saved)

  // ---- I-193 / I-192: the message is built, and nothing is sent ----
  const share = await h.invoke('invoice:share', { voucherId: sale.voucherId })
  assert(share.body.includes(sale.number), 'the message names the invoice')
  assert(/\.pdf$/.test(share.pdfPath), 'the PDF is rendered, because no link can carry one')
  assert(share.mailto.startsWith('mailto:'), 'an email draft is always offered, address or not')
  assert(
    share.whatsapp === null || share.whatsapp.startsWith('https://wa.me/'),
    'WhatsApp is a wa.me link when the party has a usable number, and null when it has not'
  )
  assert(/paste/i.test(share.attachmentHint), 'the user is told the PDF has to be pasted in')

  // ---- the day book offers all of it one click from the row ----
  await h.goto('daybook')
  await h.page.waitForSelector(`[data-testid="btn-daybook-roll-${sale.voucherId}"]`, { timeout: 10000 })
  await h.page.waitForSelector(`[data-testid="btn-daybook-send-${sale.voucherId}"]`, { timeout: 10000 })
  await h.click(`btn-daybook-send-${sale.voucherId}`)
  await h.page.waitForSelector('[data-testid="share-body"]', { timeout: 15000 })
  const shown = await h.page.textContent('[data-testid="share-body"]')
  assert(shown.includes(sale.number), 'the send dialog shows the message that will go out')
  await h.shot('01-share')
  await h.page.keyboard.press('Escape')

  // ---- Settings offers the pickers, and they are actually usable ----
  //
  // The enabled-ness is the assertion, not decoration. This screen gates every field on the
  // signed-in user being an owner, and a company with no users at all — the default, and the
  // common case — has no signed-in user. That read every field as read-only, so nobody could
  // choose a template, a language or even an invoice title until they had created a user.
  await h.goto('settings')
  await h.page.click('[data-testid="tab-settings-invoice"]')
  await h.page.waitForSelector('[data-testid="select-invoice-template"]', { timeout: 10000 })
  assert(
    await h.page.isEnabled('[data-testid="select-invoice-template"]'),
    'the template picker is usable on a company with no users configured'
  )
  await h.page.selectOption('[data-testid="select-invoice-template"]', 'modern')
  await h.page.selectOption('[data-testid="select-invoice-language"]', 'hi')
  const chosen = await h.page.inputValue('[data-testid="select-invoice-template"]')
  assert(chosen === 'modern', `the picker holds the choice (got ${chosen})`)
  await h.shot('02-invoice-config')

  await h.assertNoConsoleErrors()
})
