// Scenario 67 — the financial-year boundary (WP 1.3): year opening, year-end close / reopen and
// the period lock, on a company whose books begin in the PREVIOUS FY:
//   1. Setup (IPC): bank + capital openings, rent paid from the bank in the previous FY (two
//      payments) and once on 1 April of the current FY.
//   2. Current FY, before the close: Trial balance → Rent shows only this year's rent, and its
//      statement (TB row click) opens at 0; the bank's statement opens with last year's
//      balance; each statement's closing = its TB figure (UI and IPC); last year's rent sits in
//      the computed "Profit & Loss A/c (opening)" row; TB ties.
//   3. Year-end close through the Year-end screen (review → journal → type CLOSE → post): the
//      closing journal (Dr Retained Earnings, Cr Rent, dated 31 March) is in the books, flagged,
//      the lock moves to 31 March; the P&L opening row is replaced by Retained Earnings; the same
//      statements / TB figures hold; TB ties.
//   4. The closing journal opens read-only (banner); ⌘↵ there is refused with the service's
//      reason, and voucher:save on it answers `year_end_close_immutable`.
//   5. Settings → About → Period lock: shows 31 March; Remove lock clears it; Change… sets it
//      back to 31 March.
//   6. Inside the lock: re-saving last year's rent payment in its editor (period switched to the
//      previous FY) shows "Books are locked up to …" and changes nothing; a new voucher dated in
//      the lock is refused over IPC with `books_locked`.
//   7. Reopen: Remove lock, bin the closing journal → the year reads as open again (preview +
//      Year-end screen, P&L opening row back); restoring it from Settings → Bin closes the year
//      again. TB ties at every step.
// The company gets an owner user (signed in through the lock screen): the Period lock card's
// "Change…" is offered to a signed-in owner.
import { scenario, assert, assertEq, fixedToday, fyStartYearOf } from '../lib/harness.mjs'

/** "4,80,000.00 Dr" → +48000000, "… Cr" → negative, "—" → 0. */
function signedPaise(text) {
  const t = String(text ?? '')
  const num = t.replace(/[^0-9.]/g, '')
  if (!num) return 0
  const [r, p = '0'] = num.split('.')
  const v = Number(r) * 100 + Number((p + '00').slice(0, 2))
  return /Cr/.test(t) ? -v : v
}

/** Raw invoke — the whole { ok, data | error, code } answer (the harness throws on !ok). */
const rawInvoke = (h, channel, payload) => h.page.evaluate(([c, p]) => window.total.invoke(c, p), [channel, payload])

await scenario('67-year-boundary', async (h) => {
  const cur = fyStartYearOf(fixedToday)
  const prev = cur - 1
  const prevLabel = `${prev}-${String((prev + 1) % 100).padStart(2, '0')}`
  const prevEnd = `${cur}-03-31`
  const curStart = `${cur}-04-01`
  const curEnd = `${cur + 1}-03-31`

  // ---------------- 1. setup: books from the previous FY, an owner, openings, vouchers
  await h.invoke('company:create', {
    name: 'Boundary Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered',
    address: '', booksFrom: prev, email: null, phone: null, pan: null, tan: null
  })
  await h.relaunch()
  assertEq(await h.openCompany('Boundary Co'), 'gateway', 'opened Boundary Co')
  await h.invoke('users:save', { data: { name: 'Bina Owner', role: 'owner', pin: '1234', active: true } })

  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mk = (name, group, openingBalance = 0) =>
    h.invoke('master:ledgers:create', {
      name, groupId: gid(group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
    })
  await mk('Boundary Bank', 'Bank Accounts', 50_000_000) // ₹5,00,000 Dr
  await mk('Owner Capital', 'Capital Account', -50_000_000) // ₹5,00,000 Cr
  await mk('Office Rent', 'Indirect Expenses')
  const ledgers = await h.invoke('master:ledgers:list')
  const bank = ledgers.find((l) => l.name === 'Boundary Bank')
  const rent = ledgers.find((l) => l.name === 'Office Rent')
  const types = await h.invoke('master:voucherTypes:list')
  const paymentType = types.find((t) => t.kind === 'payment')
  const payment = (date, amount, narration) => ({
    voucherTypeId: paymentType.id, date, partyLedgerId: null, narration, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: rent.id, drCr: 'dr', amount },
      { ledgerId: bank.id, drCr: 'cr', amount }
    ],
    inventory: []
  })
  await h.invoke('voucher:save', { data: payment(`${prev}-06-10`, 1_200_000, 'Rent June') }) // ₹12,000
  const november = await h.invoke('voucher:save', { data: payment(`${prev}-11-15`, 800_000, 'Rent November') }) // ₹8,000
  await h.invoke('voucher:save', { data: payment(curStart, 500_000, 'Rent April') }) // ₹5,000, this FY

  // Hand-worked: Rent this FY = ₹5,000 Dr (last year's ₹20,000 restarts); bank opens this FY at
  // 5,00,000 − 12,000 − 8,000 = ₹4,80,000 Dr and closes at ₹4,75,000 Dr.
  const RENT_CUR = 500_000
  const BANK_OPEN = 48_000_000
  const BANK_CLOSE = 47_500_000
  const PRIOR_RENT = 2_000_000

  await h.relaunch()
  assertEq(await h.openCompany('Boundary Co'), 'lock', 'a company with users asks for sign-in')
  await h.clickText('Bina Owner')
  await h.fill('input-pin', '1234')
  await h.click('btn-unlock')
  await h.waitScreen('gateway')

  const tbTies = async (label) => {
    for (const asOn of [prevEnd, curEnd]) {
      const tb = await h.invoke('report:trialBalance', { asOn })
      assertEq(tb.totalDebit, tb.totalCredit, `TB ties as on ${asOn} — ${label}`)
    }
  }
  const tbRow = async (ledgerId, asOn = curEnd) => {
    const r = (await h.invoke('report:trialBalance', { asOn })).rows.find((x) => x.ledgerId === ledgerId)
    return r ? r.debit - r.credit : 0
  }

  /** TB screen (as on the period end) → the ledger's TB figure → row click → its statement. */
  const statementViaTb = async (ledger, label) => {
    await h.goto('trial-balance')
    const row = `[data-testid="rows-trial-balance"] tr.dt-row[data-row-id="${ledger.id}"]`
    await h.page.waitForSelector(row, { timeout: 15000 })
    const cell = (col) =>
      h.page.evaluate(
        ([sel, c]) => {
          const tr = document.querySelector(sel)
          const ths = [...tr.closest('table').querySelector('thead tr:last-child').children]
          return tr.children[ths.findIndex((th) => th.getAttribute('data-col') === c)].textContent.trim()
        },
        [row, col]
      )
    const tbFigure = signedPaise(await cell('debit')) - signedPaise(await cell('credit'))
    const groupTd = await h.page.evaluate((sel) => {
      const tr = document.querySelector(sel)
      const ths = [...tr.closest('table').querySelector('thead tr:last-child').children]
      return ths.findIndex((th) => th.getAttribute('data-col') === 'group')
    }, row)
    await h.page.click(`${row} > td:nth-child(${groupTd + 1})`)
    await h.waitScreen('ledger-statement')
    await h.page.waitForFunction((n) => document.querySelector('[data-testid="page-title"]')?.textContent?.trim() === n, ledger.name)
    const opening = await h.page.evaluate(() => {
      const span = [...document.querySelectorAll('[data-screen="ledger-statement"] span')].find((s) => s.textContent.startsWith('Opening balance ·'))
      return span?.textContent.replace('Opening balance ·', '').trim()
    })
    const closing = await h.page.textContent('[data-testid="ledger-statement-closing"]')
    const st = await h.invoke('report:ledger', { ledgerId: ledger.id, from: curStart, to: curEnd })
    assertEq(signedPaise(opening), st.opening, `${label}: statement opening on screen = report:ledger`)
    assertEq(signedPaise(closing), st.closing, `${label}: statement closing on screen = report:ledger`)
    assertEq(st.closing, tbFigure, `${label}: statement closing = the TB figure on screen`)
    assertEq(tbFigure, await tbRow(ledger.id), `${label}: TB screen = report:trialBalance`)
    await h.shot(`${label}-statement`)
    return { opening: st.opening, closing: st.closing }
  }

  // ---------------- 2. current FY before the close
  let s = await statementViaTb(rent, '02-rent-before')
  assertEq(s.opening, 0, 'expense ledger opens the new FY at 0')
  assertEq(s.closing, RENT_CUR, "expense ledger = this year's rent only")
  s = await statementViaTb(bank, '02-bank-before')
  assertEq(s.opening, BANK_OPEN, "bank opens the new FY with last year's balance")
  assertEq(s.closing, BANK_CLOSE, 'bank closing')
  assertEq(await tbRow(-5), PRIOR_RENT, "last year's rent sits in the computed Profit & Loss A/c (opening) row")
  await tbTies('before the close')

  // ---------------- 3. year-end close through the Year-end screen
  await h.goto('year-end')
  assertEq(await h.page.inputValue('[data-testid="input-year-end-fy"]'), String(prev), 'the previous FY is offered')
  await h.page.waitForSelector(`[data-testid="rows-year-end-pnl"] tr.dt-row[data-row-id="${rent.id}"]`, { timeout: 15000 })
  await h.shot('03-year-end-review')
  await h.page.getByRole('button', { name: 'Next: review journal' }).click()
  await h.page.waitForSelector('[data-testid="rows-year-end-journal"] tr.dt-row', { timeout: 10000 })
  await h.page.getByRole('button', { name: 'Next: confirm' }).click()
  await h.fill('input-year-end-confirm', 'CLOSE')
  await h.click('btn-year-end-post')
  await h.page.waitForFunction((l) => document.body.innerText.includes(`FY ${l} closed`), prevLabel, { timeout: 20000 })
  await h.shot('03-year-end-closed')

  const preview = await h.invoke('yearend:preview', { fyStartYear: prev })
  assert(preview.alreadyClosed, 'the previous FY reads as closed')
  const dayBook = await h.invoke('report:dayBook', { from: `${prev}-04-01`, to: prevEnd })
  const closing = dayBook.find((r) => r.yearEndClose)
  assert(closing, 'the closing journal is in the day book')
  assertEq(closing.date, prevEnd, 'dated the last day of the FY')
  const cj = await h.invoke('voucher:get', { id: closing.voucherId })
  assert(cj.isYearEndClose, 'flagged as the year-end closing journal')
  const retained = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Retained Earnings')
  assert(retained, 'Retained Earnings created by the close')
  const line = (lid) => cj.lines.find((l) => l.ledgerId === lid)
  assertEq(`${line(rent.id)?.drCr} ${line(rent.id)?.amount}`, `cr ${PRIOR_RENT}`, 'closing journal credits Rent with the year’s rent')
  assertEq(`${line(retained.id)?.drCr} ${line(retained.id)?.amount}`, `dr ${PRIOR_RENT}`, 'and debits Retained Earnings with the loss')
  assertEq((await h.invoke('company:lock:get')).date, prevEnd, 'the close locks the books up to 31 March')

  // Same statements and TB figures after the close; the P&L opening row became Retained Earnings.
  s = await statementViaTb(rent, '03-rent-after')
  assertEq(`${s.opening} ${s.closing}`, `0 ${RENT_CUR}`, 'expense ledger unchanged in the new FY after the close')
  s = await statementViaTb(bank, '03-bank-after')
  assertEq(`${s.opening} ${s.closing}`, `${BANK_OPEN} ${BANK_CLOSE}`, 'bank unchanged after the close')
  assertEq(await tbRow(-5), 0, 'no computed P&L opening row once the year is closed')
  assertEq(await tbRow(retained.id), PRIOR_RENT, 'Retained Earnings carries last year’s loss')
  // Last year's own statement ends at 0 (it includes the closing journal; reports.ts says so).
  assertEq((await h.invoke('report:ledger', { ledgerId: rent.id, from: `${prev}-04-01`, to: prevEnd })).closing, 0, 'last year’s Rent statement ends at 0')
  await tbTies('after the close')

  // ---------------- 4. the closing journal is immutable
  /** Click a Day book row on its Date cell (the account name is a ledger link). */
  const clickDate = async (rowSel) => {
    const idx = await h.page.evaluate((sel) => {
      const tr = document.querySelector(sel)
      const ths = [...tr.closest('table').querySelector('thead tr:last-child').children]
      return ths.findIndex((th) => th.getAttribute('data-col') === 'date')
    }, rowSel)
    await h.page.click(`${rowSel} > td:nth-child(${idx + 1})`)
  }
  await h.goto('daybook')
  await h.click('btn-period')
  await h.page.locator('[role="dialog"]').getByRole('button', { name: `FY ${prevLabel}` }).click()
  await h.click('btn-apply-period')
  const cjRow = `[data-testid="rows-daybook"] tr.dt-row[data-row-id="${closing.voucherId}"]`
  await h.page.waitForSelector(`${cjRow} [data-testid="daybook-year-end-chip"]`, { timeout: 15000 })
  await clickDate(cjRow)
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="year-end-close-banner"]', { timeout: 10000 })
  assert(await h.page.$eval('[data-testid="btn-save-voucher"]', (b) => b.matches(':disabled')), 'Save is disabled on the closing journal (read-only fieldset)')
  await h.page.keyboard.press('Meta+Enter')
  await h.page.waitForFunction(() => document.body.innerText.includes("Year-end closing entries can't be edited"), null, { timeout: 10000 })
  await h.shot('04-closing-journal-refused')
  const tampered = { ...payment(cj.date, 0, 'tampered'), voucherTypeId: cj.voucherTypeId, lines: cj.lines.map(({ ledgerId, drCr, amount }) => ({ ledgerId, drCr, amount })) }
  const edit = await rawInvoke(h, 'voucher:save', { id: cj.id, data: tampered })
  assert(!edit.ok, 'voucher:save refuses to alter the closing journal')
  assertEq(edit.code, 'year_end_close_immutable', 'refused as immutable (checked before the lock)')

  // ---------------- 5. the lock in Settings: shows the close's date; remove; set again
  const lockText = () => h.page.evaluate(() => [...document.querySelectorAll('p')].find((p) => /Books are locked up to|No lock/.test(p.textContent))?.textContent ?? '')
  const lockModal = '[role="dialog"][data-modal="Change period lock"]'
  await h.goto('settings')
  await h.click('tab-settings-about')
  await h.page.waitForFunction(() => /Books are locked up to/.test(document.body.innerText), null, { timeout: 10000 })
  assert((await lockText()).includes(`31-Mar-${String(cur % 100).padStart(2, '0')}`), `lock card shows 31 March (${await lockText()})`)
  const removeLock = async () => {
    await h.page.getByRole('button', { name: 'Change…' }).click()
    await h.page.waitForSelector(lockModal)
    await h.page.click(`${lockModal} button:has-text("Remove lock")`)
    await h.page.waitForSelector(lockModal, { state: 'detached' })
    await h.page.waitForFunction(() => /No lock/.test(document.body.innerText), null, { timeout: 10000 })
    assertEq((await h.invoke('company:lock:get')).date, null, 'lock removed')
  }
  await removeLock()
  await h.page.getByRole('button', { name: 'Change…' }).click()
  await h.page.waitForSelector(lockModal)
  await h.page.fill(`${lockModal} [data-testid="input-date"]`, `31-03-${cur}`)
  await h.page.press(`${lockModal} [data-testid="input-date"]`, 'Tab')
  await h.page.click(`${lockModal} button:has-text("Save")`)
  await h.page.waitForSelector(lockModal, { state: 'detached' })
  assertEq((await h.invoke('company:lock:get')).date, prevEnd, 'lock set back to 31 March from Settings')
  await h.shot('05-period-lock')

  // ---------------- 6. inside the lock: the editor and the service refuse
  await h.goto('daybook') // the period is still the previous FY
  // November's payment (No. 2): No. 1 of the type is reused by this FY's April payment, and the
  // editor's pre-save duplicate-number check is not FY-scoped (reported with WP 7.4).
  const lockedRow = `[data-testid="rows-daybook"] tr.dt-row[data-row-id="${november.id}"]`
  await h.page.waitForSelector(lockedRow, { timeout: 15000 })
  await clickDate(lockedRow)
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="btn-save-voucher"]:not([disabled])', { timeout: 10000 })
  await h.click('btn-save-voucher')
  await h.page.waitForFunction(() => document.body.innerText.includes('Books are locked up to'), null, { timeout: 10000 })
  assertEq(await h.page.$eval('[data-screen]', (el) => el.getAttribute('data-screen')), 'voucher-entry', 'the refused save stays in the editor')
  await h.shot('06-locked-save-refused')
  const after = await h.invoke('voucher:get', { id: november.id })
  assertEq(after.lines.find((l) => l.ledgerId === rent.id).amount, 800_000, 'the locked voucher is unchanged')
  const inLock = await rawInvoke(h, 'voucher:save', { data: payment(`${prev}-12-01`, 100_000, 'Inside the lock') })
  assert(!inLock.ok, 'a new voucher dated inside the lock is refused')
  assertEq(inLock.code, 'books_locked', 'refused with books_locked')
  await tbTies('after the lock refusals')

  // ---------------- 7. reopen: remove the lock, bin the closing journal; restore closes it again
  await h.goto('settings')
  await h.click('tab-settings-about')
  await h.page.waitForFunction(() => /Books are locked up to/.test(document.body.innerText), null, { timeout: 10000 })
  await removeLock()
  // The editor's Delete button sits in the closing journal's disabled fieldset (read-only), so
  // the bin goes through the same channel that button calls.
  await h.invoke('voucher:delete', { id: closing.voucherId })
  assert(!(await h.invoke('yearend:preview', { fyStartYear: prev })).alreadyClosed, 'binning the closing journal reopens the year')
  assertEq(await tbRow(-5), PRIOR_RENT, 'the P&L opening row is back')
  assertEq(await tbRow(retained.id), 0, 'Retained Earnings no longer carries the loss')
  await tbTies('after binning the closing journal')
  await h.goto('year-end')
  await h.page.waitForSelector(`[data-testid="rows-year-end-pnl"] tr.dt-row[data-row-id="${rent.id}"]`, { timeout: 15000 })
  assert(!(await h.page.evaluate((l) => document.body.innerText.includes(`Books for FY ${l} are already closed`), prevLabel)), 'Year-end screen: the year is open')
  assert(await h.page.getByRole('button', { name: 'Next: review journal' }).isEnabled(), 'the close can run again')
  await h.shot('07-year-reopened')

  await h.goto('settings')
  await h.click('tab-settings-bin')
  const binRow = `[data-testid="rows-settings-bin"] tr.dt-row[data-row-id="${closing.voucherId}"]`
  await h.page.waitForSelector(binRow, { timeout: 10000 })
  await h.page.click(`${binRow} button:has-text("Restore")`)
  await h.page.waitForSelector(binRow, { state: 'detached', timeout: 10000 })
  assert((await h.invoke('yearend:preview', { fyStartYear: prev })).alreadyClosed, 'restoring the closing journal closes the year again')
  assertEq(await tbRow(-5), 0, 'P&L opening row gone again')
  assertEq(await tbRow(retained.id), PRIOR_RENT, 'Retained Earnings carries the loss again')
  assertEq(await tbRow(rent.id), RENT_CUR, 'Rent this FY unchanged throughout')
  assertEq(await tbRow(bank.id), BANK_CLOSE, 'bank unchanged throughout')
  await tbTies('after restoring the closing journal')
  await h.goto('year-end')
  await h.page.waitForFunction((l) => document.body.innerText.includes(`Books for FY ${l} are already closed`), prevLabel, { timeout: 10000 })
})
