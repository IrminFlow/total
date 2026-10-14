// WP 10.8 — the "no ledger knowledge" journey's steps, driven through the simple screens only
// (what the screen offers; the IPC is used only to READ figures back). Shared by e2e 60 (one
// persona, every figure asserted) and the beginner-study driver (every preset × persona, outcomes
// recorded rather than asserted). Not a scenario: the runner only picks `NN-*.mjs`.
//
// A persona: { name, company, type, gst: 'regular'|'composition'|'no'|'not-sure', gstin?, stock,
//   continuing, language: 'en'|'hi'|'hinglish', openings?, sale, purchase, ... } — see e2e 60.
import { PICKER_OPTION, isoLocal } from '../../lib/harness.mjs'

export const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i,
  /वाउचर/, /लेजर|लेज़र/, /जर्नल/, /कॉन्ट्रा/, /नैरेशन/, /संड्री/, /ग्रुप/, /गोडाउन|गोदाम/, /एजिंग/, /आईटीसी/, /बीओएम/
]
export const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)

/** The harness's one local-date helper (WP 7.4), kept under the journey's name for the study driver. */
export const localIso = isoLocal
/** dd/mm/yy as the HDFC-style statement writes it. */
const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`

export function journey(h) {
  const { page } = h
  const attached = (sel, timeout = 15000) => page.waitForSelector(sel, { state: 'attached', timeout })
  const gone = (sel, timeout = 10000) => page.waitForSelector(sel, { state: 'detached', timeout })
  const text = async (testId) => ((await page.textContent(`[data-testid="${testId}"]`)) ?? '').replace(/\s+/g, ' ').trim()
  const paise = async (testId) => Number(await page.getAttribute(`[data-testid="${testId}"]`, 'data-paise'))
  const has = async (testId) => (await page.$(`[data-testid="${testId}"]`)) != null
  const mainText = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '')
  const waitText = (testId, part, timeout = 15000) =>
    page.waitForFunction(([id, p]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').includes(p), [testId, part], { timeout })
  const fill = async (testId, value) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(String(value))
    await input.blur()
  }
  /** A picker: type, then click the matching option (never the Create row). */
  const pick = async (testId, value) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(value)
    const opt = page.locator(PICKER_OPTION, { hasText: value }).first()
    await opt.waitFor({ timeout: 8000 })
    await opt.click()
  }
  /** Sidebar section → one of its entries. */
  const open = async (section, entry) => {
    await h.click(`simple-nav-${section}`)
    await attached(`[data-testid="simple-entry-${entry}"]`)
    await h.click(`simple-entry-${entry}`)
  }
  const noBanned = async (where) => {
    const found = bannedWordsIn(await mainText())
    if (found.length) throw new Error(`accounting words on ${where}: ${found.join(', ')}`)
  }
  /** A preview line once it has settled: not empty, not "Checking…", unchanged for 600 ms. */
  const settled = async (testId, timeout = 20000) => {
    const end = Date.now() + timeout
    let last = null
    let since = Date.now()
    while (Date.now() < end) {
      const now = await text(testId).catch(() => '')
      if (now !== last) {
        last = now
        since = Date.now()
      } else if (now && !now.endsWith('…') && Date.now() - since >= 600) return now
      await page.waitForTimeout(100)
    }
    throw new Error(`${testId} did not settle (last: ${JSON.stringify(last)})`)
  }
  /** Back to Home from wherever the last step left the screen (a save card, a list). */
  const home = async () => {
    await h.click('simple-nav-home')
    if (await page.$('[data-testid="confirm-ok"]')) await h.click('confirm-ok')
    await attached('[data-testid="simple-home"]')
    await h.waitIdle()
  }
  /** The screen says there is no bank account yet and offers one: add it, as a beginner would. */
  const addBankIfAsked = async (testId, name = 'My bank') => {
    if (!(await has(testId))) return false
    await h.click(testId)
    await attached('[data-testid="dialog-new-account"]')
    await h.fill('input-account-name', name)
    await h.click('btn-account-create')
    await gone('[data-testid="dialog-new-account"]')
    return true
  }
  /** A picker's "Create …" row (↓ past the matches, Enter) → the plain dialog → Create. */
  const createFromPicker = async (testId, value) => {
    const input = page.locator(`[data-testid="${testId}"]`).first()
    await input.click()
    await input.fill(value)
    await page.waitForTimeout(300)
    await input.press('ArrowDown')
    await page.waitForTimeout(100)
    await input.press('Enter')
    await attached('[data-testid="dialog-new-account"]')
    await h.click('btn-account-create')
    if (await page.waitForSelector('[data-testid="account-did-you-mean"]', { timeout: 1500 }).then(() => true, () => false)) await h.click('btn-dup-create')
    await gone('[data-testid="dialog-new-account"]')
  }
  const saveCard = async () => {
    await attached('[data-testid="save-card"]')
    await page.waitForFunction(() => (document.querySelector('[data-testid="save-card-text"]')?.textContent ?? '').length > 0, null, { timeout: 15000 })
    return text('save-card-text')
  }

  return {
    attached, gone, text, paise, has, mainText, waitText, fill, pick, open, noBanned, saveCard, settled, home, addBankIfAsked, createFromPicker,

    /** First run: the wizard, every question as the screen asks it. */
    async setup(p) {
      await h.waitScreen('company-select')
      await attached('[data-testid="setup-wizard"]')
      if (p.language && p.language !== 'en') {
        const before = await text('setup-step-label')
        await h.click(`setup-language-${p.language}`)
        await page.waitForFunction((b) => document.querySelector('[data-testid="setup-step-label"]')?.textContent !== b, before)
      }
      await h.fill('setup-name', p.company)
      if (p.state) await page.selectOption('[data-testid="setup-state"]', p.state)
      await h.click('setup-next')
      await h.click(`setup-type-${p.type}`)
      await h.click('setup-next')
      await h.click(`setup-gst-${p.gst}`)
      if (p.gst === 'regular' || p.gst === 'composition') await h.fill('setup-gstin', p.gstin)
      if (p.gst === 'regular') await h.click(`setup-filing-${p.filing ?? 'monthly'}`)
      await h.click('setup-next')
      await h.click(p.stock ? 'setup-stock-yes' : 'setup-stock-no')
      await h.click('setup-next')
      await h.click(p.start === 'today' ? 'setup-start-today' : 'setup-start-fy')
      await h.click(p.continuing ? 'setup-fresh-continuing' : 'setup-fresh-new')
      await h.click('setup-next')
      if (await has('setup-tally-no')) await h.click('setup-tally-no')
      await h.click('setup-finish')
      await h.waitScreen('gateway', 30000)
      await attached('[data-testid="simple-home"]', 20000)
      await h.stubDialogs()
      // The first-run tour: the persona reads it and goes "Next" to the end (or Esc).
      if (await page.$('[data-testid="tour"]')) {
        for (let i = 0; i < 12 && (await page.$('[data-testid="tour"]')); i++) {
          if (await has('tour-next')) await h.click('tour-next')
          else if (await has('tour-done')) await h.click('tour-done')
          else await page.keyboard.press('Escape')
          await page.waitForTimeout(150)
        }
      }
      await h.waitIdle()
      return h.invoke('company:current')
    },

    /** Home's "what you had on day one" card → the five steps → confirm. */
    async openings(o) {
      await attached('[data-testid="simple-home-openings-start"]')
      await h.click('simple-home-openings-start')
      await attached('[data-testid="openings"][data-step="money"]')
      if (o.cash != null) await fill('openings-cash', o.cash)
      for (const [i, b] of (o.banks ?? []).entries()) {
        await h.click('openings-add-bank')
        await h.fill(`openings-bank-${i}-name`, b.name)
        await fill(`openings-bank-${i}-amount`, b.amount)
      }
      await h.click('openings-next')
      for (const [side, rows] of [['customer', o.customers ?? []], ['supplier', o.suppliers ?? []]]) {
        await attached(`[data-testid="openings"][data-step="${side}s"]`)
        for (const [i, r] of rows.entries()) {
          await h.click(`openings-add-${side}`)
          await h.fill(`openings-${side}-${i}-name`, r.name)
          for (const [k, b] of r.bills.entries()) {
            if (k > 0) await h.click(`openings-${side}-${i}-add-bill`)
            if (b.ref) await h.fill(`openings-${side}-${i}-bill-${k}-ref`, b.ref)
            await fill(`openings-${side}-${i}-bill-${k}-amount`, b.amount)
          }
        }
        await h.click('openings-next')
      }
      if (await page.$('[data-testid="openings"][data-step="stock"]')) {
        for (const [i, it] of (o.items ?? []).entries()) {
          await h.click('openings-add-item')
          await h.fill(`openings-item-${i}-name`, it.name)
          if (it.unit) await page.selectOption(`[data-testid="openings-item-${i}-unit"]`, { label: it.unit })
          await fill(`openings-item-${i}-qty`, it.qty)
          await fill(`openings-item-${i}-rate`, it.rate)
          if (it.gstRate != null && (await has(`openings-item-${i}-gst`))) await page.selectOption(`[data-testid="openings-item-${i}-gst"]`, String(it.gstRate))
        }
        await h.click('openings-next')
      }
      await attached('[data-testid="openings"][data-step="confirm"]')
      await attached('[data-testid="openings-difference-sentence"]', 20000)
      const sentence = await text('openings-difference-sentence')
      await h.click('openings-confirm')
      await attached('[data-testid="openings-done"]', 20000)
      await h.click('openings-done-home')
      await attached('[data-testid="simple-home"]')
      await h.waitIdle()
      return { sentence }
    },

    /** Home "+ Sale" → Make a bill (products or an amount) → save card. */
    async sale(s) {
      await home()
      await h.click('simple-task-sale')
      await h.waitScreen('simple-sell')
      if (await has('btn-sell-add-sales-account')) await h.click('btn-sell-add-sales-account')
      if (s.customer) await pick('picker-sell-customer', s.customer)
      if (s.items) {
        for (const [i, it] of s.items.entries()) {
          if (i > 0) await h.click('btn-sell-add-line')
          await pick(`picker-sell-item-${i}`, it.name)
          await fill(`input-sell-qty-${i}`, it.qty)
          if (it.rate != null) await fill(`input-sell-rate-${i}`, it.rate)
          if (it.gstRate != null && (await has(`sell-line-${i}-gst-${it.gstRate}`))) await h.click(`sell-line-${i}-gst-${it.gstRate}`)
        }
      } else {
        if (await has('btn-sell-toggle-mode')) await h.click('btn-sell-toggle-mode')
        await fill('input-sell-amount', s.amount)
        if (s.note) await fill('input-sell-note', s.note)
        if (s.gstRate != null && (await has(`sell-gst-rate-${s.gstRate}`))) await h.click(`sell-gst-rate-${s.gstRate}`)
      }
      await h.click(`sell-paid-${s.paid}`)
      await addBankIfAsked('btn-sell-add-bank', s.bankName)
      const preview = await settled('sell-preview')
      const total = await paise('sell-total')
      const tax = (await has('sell-tax')) ? await paise('sell-tax') : 0
      await h.click('btn-sell-save')
      return { preview, total, tax, card: await saveCard() }
    },

    /** Home "+ Purchase" → Record a purchase → save card. */
    async purchase(b) {
      await home()
      await h.click('simple-task-purchase')
      await h.waitScreen('simple-buy')
      if (b.expense) await h.click('buy-mode-expense')
      if (!b.expense && (await has('btn-buy-add-purchase-account'))) await h.click('btn-buy-add-purchase-account')
      if (b.supplier) await pick('picker-buy-supplier', b.supplier)
      if (b.billNo) await fill('input-buy-bill-no', b.billNo)
      if (b.gstOnBill != null && (await has(`buy-gst-${b.gstOnBill ? 'yes' : 'no'}`))) await h.click(`buy-gst-${b.gstOnBill ? 'yes' : 'no'}`)
      if (b.items) {
        for (const [i, it] of b.items.entries()) {
          if (i > 0) await h.click('btn-buy-add-line')
          await pick(`picker-buy-item-${i}`, it.name)
          await fill(`input-buy-qty-${i}`, it.qty)
          await fill(`input-buy-rate-${i}`, it.rate)
        }
      } else {
        if (b.category) {
          await h.click('picker-buy-category')
          await h.click(`category-${b.category}`)
        }
        await fill('input-buy-amount', b.amount)
      }
      if (b.part != null) {
        await h.click('buy-paid-part')
        await fill('input-buy-part-amount', b.part)
        await h.click(`buy-part-how-${b.how ?? 'cash'}`)
      } else await h.click(`buy-paid-${b.paid ?? 'credit'}`)
      await addBankIfAsked('btn-buy-add-bank', b.bankName)
      if (!b.supplier) {
        // Save first, as a beginner would; the screen asks for the supplier under its question.
        await h.click('btn-buy-save')
        await attached('[data-testid="field-error-party"]')
        await createFromPicker('picker-buy-supplier', b.newSupplier ?? 'Local shop')
      }
      const preview = await settled('buy-preview')
      const total = await paise('buy-total')
      const tax = (await has('buy-tax')) ? await paise('buy-tax') : 0
      await h.click('btn-buy-save')
      return { preview, total, tax, card: await saveCard() }
    },

    /** Money → Money in from a customer (the bills ticked oldest first). */
    async moneyIn(m) {
      await open('money', 'money-in')
      await h.waitScreen('simple-money-in')
      await pick('picker-money-customer', m.customer)
      await attached('[data-testid="money-bill-list"]').catch(() => {})
      await fill('input-money-amount', m.amount)
      await h.click(`money-how-${m.how}`)
      await addBankIfAsked('btn-money-add-bank', m.bankName)
      const preview = await settled('money-preview')
      await h.click('btn-money-save')
      return { preview, card: await saveCard() }
    },

    /** Home "+ Money out" → an expense by category, from cash. */
    async moneyOut(m) {
      await home()
      await h.click('simple-task-money-out')
      await h.waitScreen('simple-money-out')
      await h.click('money-out-who-expense')
      await h.click('picker-money-expense')
      await h.click(`category-${m.category}`)
      await fill('input-money-amount', m.amount)
      if (m.note) await fill('input-money-note', m.note)
      if (await has('money-gst-bill-no')) await h.click(m.gstBill ? 'money-gst-bill-yes' : 'money-gst-bill-no')
      if (m.how && (await has(`money-how-${m.how}`))) await h.click(`money-how-${m.how}`)
      await addBankIfAsked('btn-money-add-bank', m.bankName)
      const preview = await settled('money-preview')
      await h.click('btn-money-save')
      return { preview, card: await saveCard() }
    },

    /** Money → Bank: add the bank, drop a statement (HDFC layout), accept what is suggested. */
    async bank(k, csvHead) {
      await open('money', 'bank')
      await h.waitScreen('simple-bank')
      if (await page.$('[data-testid="bank-no-bank"]')) {
        await h.click('btn-bank-add-bank')
        await attached('[data-testid="dialog-new-account"]')
        await h.fill('input-account-name', k.bankName)
        await h.click('btn-account-create')
      }
      await attached('[data-testid="bank-statement"]')
      const rows = k.lines.map((r) => `${dmy(r.date)},${r.text},${r.ref ?? ''},${dmy(r.date)},${r.out ?? ''},${r.in ?? ''},`)
      const csv = [...csvHead, ...rows, ',,,,,,'].join('\n')
      await page.setInputFiles('[data-testid="input-bank-file"]', { name: k.file ?? 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
      await attached(`[data-testid="bank-preview-found"][data-count="${k.lines.length}"]`)
      await h.click('btn-bank-add-lines')
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="bank-line"]').length === n, k.lines.length, { timeout: 15000 })
      for (const [i, r] of k.lines.entries()) {
        const card = page.locator('[data-testid="bank-line"]', { hasText: r.match ?? r.text }).first()
        if (r.answer === 'expense') {
          await card.locator('[data-testid="bank-choice-expense"]').click()
          await card.locator('[data-testid^="picker-bank-category-"]').first().click()
          await card.locator(`[data-testid="category-${r.category}"]`).click()
        } else if (r.answer === 'income') {
          await card.locator('[data-testid="bank-choice-income"]').click()
          await card.locator('[data-testid^="picker-bank-category-"]').first().click()
          await card.locator(`[data-testid="category-${r.category}"]`).click()
        } else if (r.answer === 'charges') await card.locator('[data-testid="bank-choice-charges"]').click()
        void i
      }
      const suggested = await page.$$eval('[data-testid="bank-line"]', (els) => els.map((e) => e.getAttribute('data-choice')))
      await h.click('btn-bank-accept-all')
      await attached('[data-testid="bank-sentence"][data-tone="agree"]', 20000)
      return { suggested, sentence: await text('bank-sentence') }
    },

    /** Sell → Sales list → the bill → Return items: `qty` of the first line, credit kept. */
    async returnSale(r) {
      await open('sell', 'sales-list')
      await h.waitScreen('simple-sales')
      const row = page.locator('[data-testid="rows-simple-sales"] tr', { hasText: r.customer }).first()
      await row.waitFor({ timeout: 15000 })
      await row.click()
      await attached('[data-testid="simple-sale"][data-bill]')
      await h.click('btn-bill-return')
      await h.waitScreen('simple-return-sale')
      await attached('[data-testid="return-bill"]')
      await fill('input-return-qty-0', r.qty)
      const settle = `return-settle-${r.settle ?? 'credit'}`
      if (await has(settle)) await h.click(settle)
      const preview = await settled('return-preview')
      const total = await paise('return-total')
      await h.click('btn-return-save')
      return { preview, total, card: await saveCard() }
    },

    /** Stock → Count your stock: one product's counted quantity. */
    async stockCount(c) {
      await open('stock', 'stock-count')
      await h.waitScreen('simple-stock-count')
      const item = (await h.invoke('master:stockItems:list')).find((i) => i.name === c.item)
      await attached(`[data-testid="input-count-${item.id}"]`)
      await fill(`input-count-${item.id}`, c.counted)
      const diff = await text(`count-diff-${item.id}`)
      await h.click('btn-count-save')
      return { diff, card: await saveCard(), itemId: item.id }
    },

    /** Taxes → GST summary: the three figures. */
    async gstAnswer() {
      await open('taxes', 'gst-summary')
      await attached('[data-testid="taxes-figures"]')
      await h.waitIdle()
      await page.waitForTimeout(300)
      return {
        collected: await paise('tile-gst-collected'),
        purchases: await paise('tile-gst-purchases'),
        toPay: await paise('tile-gst-to-pay'),
        period: await page.inputValue('[data-testid="taxes-period"]'),
        running: (await has('taxes-running')) ? await text('taxes-running') : null
      }
    },

    /** People → the person → Remind → the message (copied). */
    async reminder(r) {
      await open('people', 'customers-suppliers')
      await h.waitScreen('simple-people')
      const row = page.locator('tr', { hasText: r.customer }).first()
      await row.waitFor({ timeout: 15000 })
      await row.locator('td').first().click()
      await h.waitScreen('simple-person')
      await h.waitIdle()
      if (!(await has('btn-person-remind'))) return { offered: false, page: (await text('simple-person')).slice(0, 300) }
      await h.click('btn-person-remind')
      await attached('[data-testid="person-reminder"]')
      const message = await page.inputValue('[data-testid="reminder-text"]')
      await h.click('btn-reminder-copy')
      await attached('[data-testid="reminder-note"]')
      return { offered: true, message }
    },

    /** The sidebar's "Back up now". */
    async backup() {
      const before = (await h.invoke('backup:list')).length
      await h.click('btn-backup-now')
      await page.waitForFunction(async (n) => (await window.total.invoke('backup:list', undefined)).data?.length > n, before, { timeout: 30000 })
      return { backups: (await h.invoke('backup:list')).length }
    }
  }
}
