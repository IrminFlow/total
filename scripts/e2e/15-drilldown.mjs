// Scenario 15 — drill-down everywhere (WP 1.8), in the Demo Traders company: on every main report
// screen, clicking a ledger NAME opens that ledger's edit window; closing it and clicking the
// row's blank area opens that ledger's statement. Screens whose rows already mean something else
// (Day Book → voucher, Outstandings → bills) check the name → edit half and their own row action,
// plus the path from there to the statement. ⌘E on an active row edits its ledger.
import { scenario, assert } from '../lib/harness.mjs'

/** Every rendered data row of a DataTable that carries a ledger link. */
const LINKED_ROW = (area) => `[data-testid="rows-${area}"] tr.dt-row:has([data-testid="ledger-link"])`

/** The name + id of the first ledger link inside `rowSel`. */
async function linkOf(h, rowSel) {
  await h.page.waitForSelector(`${rowSel} [data-testid="ledger-link"]`, { state: 'attached', timeout: 20000 })
  return h.page.$eval(`${rowSel} [data-testid="ledger-link"]`, (el) => ({
    name: el.textContent.trim(),
    id: Number(el.getAttribute('data-ledger-link'))
  }))
}

/** Click the name → assert the edit window for that ledger → close it. */
async function nameOpensEdit(h, rowSel, label) {
  const { name, id } = await linkOf(h, rowSel)
  assert(name && id > 0, `${label}: a ledger link with a name and id`)
  await h.page.click(`${rowSel} [data-testid="ledger-link"]`)
  const modal = `[role="dialog"][data-modal="Edit ${name}"]`
  await h.page.waitForSelector(modal, { timeout: 10000 })
  const fieldName = await h.page.$eval(`${modal} input`, (el) => el.value)
  assert(fieldName === name, `${label}: the edit window is for "${name}" (name field reads "${fieldName}")`)
  const screenNow = await h.page.$eval('[data-screen]', (el) => el.getAttribute('data-screen'))
  await h.shot(`${label}-edit`)
  await h.page.click(`${modal} [data-testid="modal-close"]`)
  await h.page.waitForSelector(modal, { state: 'detached', timeout: 10000 })
  // The name click must not ALSO have run the row's own action.
  const screenAfter = await h.page.$eval('[data-screen]', (el) => el.getAttribute('data-screen'))
  assert(screenAfter === screenNow, `${label}: closing the edit window leaves us on ${screenNow} (got ${screenAfter})`)
  return { name, id }
}

/** Assert the ledger statement screen is open for `name`. */
async function expectStatement(h, name, label) {
  await h.waitScreen('ledger-statement', 20000)
  const title = await h.page.$eval('[data-screen="ledger-statement"] h2', (el) => el.textContent.trim())
  assert(title === name, `${label}: the statement opened is "${name}" (got "${title}")`)
  await h.shot(`${label}-statement`)
}

/** Click a cell of the row that holds no link or button — the row's "white" space. */
async function clickBlank(h, rowSel) {
  const box = await h.page.$eval(rowSel, (tr) => {
    const td = [...tr.querySelectorAll('td')].find((c) => !c.querySelector('button, a, [role="button"]') && c.offsetWidth > 40)
    const r = (td ?? tr).getBoundingClientRect()
    return { x: r.left + r.width - 8, y: r.top + r.height / 2 }
  })
  await h.page.mouse.click(box.x, box.y)
}

/** A DataTable screen whose ledger rows: name → edit, blank → statement. */
async function ledgerTable(h, screen, area, label = screen) {
  await h.goto(screen, 20000)
  const sel = LINKED_ROW(area)
  await h.page.waitForSelector(sel, { state: 'attached', timeout: 20000 })
  const first = (await h.page.$$(sel))[0]
  const rowId = await first.getAttribute('data-row-id')
  const rowSel = `[data-testid="rows-${area}"] tr.dt-row[data-row-id="${rowId}"]`
  const { name } = await nameOpensEdit(h, rowSel, label)
  await clickBlank(h, rowSel)
  await expectStatement(h, name, label)
  return name
}

await scenario('15-drilldown', async (h) => {
  await h.createDemoCompany()

  // ---- plain ledger tables: name → edit, blank → statement ----
  await ledgerTable(h, 'trial-balance', 'trial-balance')
  await ledgerTable(h, 'masters', 'masters-ledgers', 'masters-ledgers')

  // ---- the statement header: group breadcrumb + Edit opens the same window ----
  const crumb = await h.page.textContent('[data-testid="ledger-statement-breadcrumb"]')
  assert(crumb && crumb.trim().length > 0, `statement shows the ledger's group breadcrumb (got "${crumb}")`)
  const stTitle = await h.page.$eval('[data-screen="ledger-statement"] h2', (el) => el.textContent.trim())
  await h.click('btn-statement-edit-ledger')
  await h.page.waitForSelector(`[role="dialog"][data-modal="Edit ${stTitle}"]`, { timeout: 10000 })
  await h.page.click('[role="dialog"] [data-testid="modal-close"]')

  // ---- P&L / Balance Sheet trees: a ledger leaf ----
  for (const screen of ['profit-loss', 'balance-sheet']) {
    await h.goto(screen, 20000)
    // Expand collapsed (▸) groups, level by level, until a ledger leaf shows.
    for (let i = 0; i < 6 && !(await h.page.$('[data-testid="statement-ledger"]')); i++) {
      await h.page.evaluate(() => {
        for (const b of document.querySelectorAll('[data-screen] button')) {
          if (b.querySelector('span.inline-block')?.textContent === '▸') b.click()
        }
      })
      await h.page.waitForTimeout(100)
    }
    await h.page.waitForSelector('[data-testid="statement-ledger"]', { timeout: 10000 })
    const leafId = await h.page.$eval('[data-testid="statement-ledger"]', (el) => el.getAttribute('data-drill-ledger'))
    const leaf = `[data-testid="statement-ledger"][data-drill-ledger="${leafId}"]`
    const { name } = await nameOpensEdit(h, leaf, screen)
    const box = await h.page.$eval(leaf, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width * 0.7, y: r.top + r.height / 2 }
    })
    await h.page.mouse.click(box.x, box.y)
    await expectStatement(h, name, screen)
  }

  // ---- Day Book: name → edit; the row opens the voucher; the edit window reaches the statement ----
  await h.goto('daybook', 20000)
  const dbRowId = await h.page.$eval(LINKED_ROW('daybook'), (tr) => tr.getAttribute('data-row-id'))
  const dbRow = `[data-testid="rows-daybook"] tr.dt-row[data-row-id="${dbRowId}"]`
  const dbLedger = await nameOpensEdit(h, dbRow, 'daybook')
  await clickBlank(h, dbRow)
  await h.waitScreen('voucher-entry', 20000)
  await h.page.keyboard.press('Escape')
  await h.waitScreen('daybook', 20000)
  await h.page.click(`${dbRow} [data-testid="ledger-link"]`)
  await h.page.waitForSelector(`[role="dialog"][data-modal="Edit ${dbLedger.name}"]`, { timeout: 10000 })
  await h.click('btn-ledger-statement')
  await expectStatement(h, dbLedger.name, 'daybook-via-edit')

  // ---- Outstandings: name → edit; row → bills; Statement → statement ----
  await h.goto('outstandings', 20000)
  const osRowId = await h.page.$eval(LINKED_ROW('outstandings'), (tr) => tr.getAttribute('data-row-id'))
  const osRow = `[data-testid="rows-outstandings"] tr.dt-row[data-row-id="${osRowId}"]`
  const party = await nameOpensEdit(h, osRow, 'outstandings')
  await clickBlank(h, osRow)
  await h.page.waitForSelector(`[data-testid="outstandings-bills-${osRowId}"]`, { timeout: 10000 })
  await h.page.click(`${osRow} [data-testid="btn-outstandings-statement"]`)
  await expectStatement(h, party.name, 'outstandings')

  // ---- Gateway top receivables: name → edit, row → statement ----
  await h.goto('gateway', 20000)
  const topId = await h.page.$eval('[data-testid="top-ledger"]', (el) => el.getAttribute('data-drill-ledger'))
  const top = `[data-testid="top-ledger"][data-drill-ledger="${topId}"]`
  const topLedger = await nameOpensEdit(h, top, 'gateway')
  const tb = await h.page.$eval(top, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width * 0.75, y: r.top + r.height / 2 }
  })
  await h.page.mouse.click(tb.x, tb.y)
  await expectStatement(h, topLedger.name, 'gateway')

  // ---- ⌘E on the active Trial balance row ----
  await h.goto('trial-balance', 20000)
  await h.page.waitForSelector('[data-testid="rows-trial-balance"] tr.dt-row[data-active="true"] [data-testid="ledger-link"]', { timeout: 20000 })
  const activeName = await h.page.$eval(
    '[data-testid="rows-trial-balance"] tr.dt-row[data-active="true"] [data-testid="ledger-link"]',
    (el) => el.textContent.trim()
  )
  await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e')
  await h.page.waitForSelector(`[role="dialog"][data-modal="Edit ${activeName}"]`, { timeout: 10000 })
  await h.shot('trial-balance-cmd-e')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })
  await h.waitScreen('trial-balance', 10000)
})
