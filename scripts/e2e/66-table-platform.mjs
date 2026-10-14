// Scenario 66 — Masters as a chart of accounts (WP 1.2) and the shared table platform
// (WP 1.6 / 1.7), in Demo Traders (full app):
//   1. Masters → Groups is a tree: a new ledger in a new sub-group ("Selling Costs" under
//      Indirect Expenses) sits under that group, under its parent, once expanded.
//   2. The tree filter "Sales" keeps the matching ledgers AND their ancestors (Indirect Expenses →
//      Selling Costs → Sales Commission Paid; Sales Accounts → Sales A/c) and drops groups with
//      nothing that matches (Capital Account) and the non-matching siblings in a kept group.
//   3. Masters → Ledgers has a Group column; its search finds a ledger by its group's name and a
//      party by its GSTIN.
//   4. Day book (DataTable): Debit sorts ascending then descending (aria-sort + the figures in
//      order), Shift-click adds Date as a secondary sort; the quick filter narrows the rows to the
//      ones whose text matches; a per-column filter (Debit ≥ ₹X) leaves only those rows, with a
//      chip; the column chooser hides Narration and Type.
//   5. That view is saved as "Big debits"; after a relaunch the Day book opens on it — same
//      filter, sort, hidden columns and row count.
//   6. CSV export of the current view: the header holds only the visible columns, one line per
//      filtered row + the totals row.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

/** "1,23,456.00" / "₹ 1,234.50 Dr" → paise (blank / dash = 0). */
function toPaise(text) {
  const t = String(text ?? '').replace(/[^0-9.-]/g, '')
  if (!t || t === '-' || t === '.') return 0
  const [r, p = '0'] = t.split('.')
  return Number(r) * 100 + Number((p + '00').slice(0, 2))
}

/** Each rendered data row of a DataTable as { colId: cellText }, by the header's column order. */
async function tableRows(h, area) {
  return h.page.evaluate((a) => {
    const table = document.querySelector(`[data-testid="rows-${a}"]`)?.closest('table')
    if (!table) return []
    const headRow = [...table.querySelectorAll('thead tr')].find((tr) => tr.querySelector('th[data-col]'))
    const ths = [...headRow.children]
    const cols = ths.map((th) => th.getAttribute('data-col'))
    return [...table.querySelectorAll(`[data-testid="rows-${a}"] > tr.dt-row`)].map((tr) => {
      const out = { _id: tr.getAttribute('data-row-id') }
      ;[...tr.children].forEach((td, i) => {
        if (cols[i]) out[cols[i]] = td.textContent.trim()
      })
      return out
    })
  }, area)
}

const visibleCols = (h, area) =>
  h.page.$$eval(`[data-testid="${area}-table"] thead th[data-col]`, (ths) => ths.map((th) => th.getAttribute('data-col')))

/** Minimal RFC 4180 reader (quoted cells hold "1,234.00"). */
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c !== ''))
}

const nonDecreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x)
const nonIncreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] >= x)

await scenario('66-table-platform', async (h) => {
  await h.createDemoCompany()

  // ---------------- setup: a sub-group with a ledger whose name says "Sales"
  let groups = await h.invoke('master:groups:list')
  const indirect = groups.find((g) => g.name === 'Indirect Expenses')
  assert(indirect, 'seeded Indirect Expenses group')
  await h.invoke('master:groups:create', { name: 'Selling Costs', parentId: indirect.id })
  groups = await h.invoke('master:groups:list')
  const selling = groups.find((g) => g.name === 'Selling Costs')
  await h.invoke('master:ledgers:create', {
    name: 'Sales Commission Paid', groupId: selling.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  // A non-matching sibling under the same parent, which the "Sales" filter must drop.
  await h.invoke('master:ledgers:create', {
    name: 'Courier Charges', groupId: indirect.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const commission = ledgers.find((l) => l.name === 'Sales Commission Paid')
  const courier = ledgers.find((l) => l.name === 'Courier Charges')
  const salesAc = ledgers.find((l) => l.name === 'Sales A/c')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const party = ledgers.find((l) => l.gstin)
  assert(commission && courier && salesAc && cash && party, 'setup ledgers + a demo party with a GSTIN')
  const ancestry = (groupId) => {
    const out = []
    for (let g = groups.find((x) => x.id === groupId); g; g = groups.find((x) => x.id === g.parentId)) out.push(g)
    return out
  }

  // ---------------- 1. Groups tab: the ledger sits under its group, under the group's parent
  await h.goto('masters')
  await h.click('tab-masters-groups')
  await h.page.waitForSelector('[data-testid="coa-tree"]', { timeout: 15000 })
  await h.click('coa-expand-all')
  const leaf = `[data-testid="coa-ledger"][data-ledger-id="${commission.id}"]`
  await h.page.waitForSelector(leaf, { timeout: 10000 })
  /** The group ids enclosing a ledger leaf, nearest first (DOM nesting). */
  const enclosing = (sel) =>
    h.page.$eval(sel, (el) => {
      const ids = []
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.getAttribute('role') === 'treeitem') {
          const row = n.querySelector(':scope > [data-testid="coa-group"]')
          if (row) ids.push(Number(row.getAttribute('data-row-id')))
        }
      }
      return ids
    })
  const chain = ancestry(selling.id).map((g) => g.id)
  assertEq(JSON.stringify(await enclosing(leaf)), JSON.stringify(chain), 'Sales Commission Paid nests under Selling Costs → Indirect Expenses (→ root)')
  await h.shot('01-chart-of-accounts')

  // ---------------- 2. tree filter "Sales": matches + their ancestors, nothing else
  await h.fill('coa-filter', 'Sales')
  await h.page.waitForSelector(`[data-testid="coa-ledger"][data-ledger-id="${courier.id}"]`, { state: 'detached', timeout: 10000 })
  await h.page.waitForSelector(leaf, { timeout: 10000 }) // ancestors opened as you type
  assertEq(JSON.stringify(await enclosing(leaf)), JSON.stringify(chain), 'filtered: the matching ledger keeps its whole ancestor chain')
  await h.page.waitForSelector(`[data-testid="coa-ledger"][data-ledger-id="${salesAc.id}"]`, { timeout: 10000 })
  const shownGroups = await h.page.$$eval('[data-testid="coa-group"]', (els) => els.map((e) => Number(e.getAttribute('data-row-id'))))
  for (const g of chain) assert(shownGroups.includes(g), `filtered tree keeps ancestor group ${groups.find((x) => x.id === g).name}`)
  const capital = groups.find((g) => g.name === 'Capital Account')
  assert(capital && !shownGroups.includes(capital.id), 'a group with no match (Capital Account) is filtered out')
  const shownLeaves = await h.page.$$eval('[data-testid="coa-ledger"]', (els) => els.map((e) => Number(e.getAttribute('data-ledger-id'))))
  assert(!shownLeaves.includes(cash.id), 'Cash (no match) is filtered out')
  await h.shot('02-chart-filter-sales')

  // ---------------- 3. Ledgers tab: Group column; search by group name and by GSTIN
  await h.click('tab-masters-ledgers')
  await h.waitScreen('masters')
  await h.page.waitForSelector('[data-testid="masters-ledgers-table"] thead th[data-col="group"]', { timeout: 10000 })
  const row = (id) => `[data-testid="rows-masters-ledgers"] tr.dt-row[data-row-id="${id}"]`
  await h.fill('masters-ledgers-filter', 'Selling Costs')
  await h.page.waitForSelector(`${row(cash.id)}`, { state: 'detached', timeout: 10000 })
  let rows = await tableRows(h, 'masters-ledgers')
  assertEq(rows.length, 1, 'search "Selling Costs" (a group name) finds exactly the ledger in that group')
  assertEq(rows[0].name, 'Sales Commission Paid', 'the group-name match is the ledger under it')
  assertEq(rows[0].group, 'Selling Costs', 'the Group column shows its group')
  await h.fill('masters-ledgers-filter', 'Indirect Expenses') // ancestors count too
  await h.page.waitForSelector(row(courier.id), { timeout: 10000 })
  rows = await tableRows(h, 'masters-ledgers')
  assert(rows.some((r) => r.name === 'Sales Commission Paid'), 'an ancestor group name finds the ledger in its sub-group')
  await h.fill('masters-ledgers-filter', party.gstin)
  await h.page.waitForSelector(`${row(courier.id)}`, { state: 'detached', timeout: 10000 })
  rows = await tableRows(h, 'masters-ledgers')
  const sameGstin = ledgers.filter((l) => l.gstin === party.gstin).length
  assertEq(rows.length, sameGstin, `GSTIN search lists the ledger(s) with GSTIN ${party.gstin}`)
  assert(rows.every((r) => r.gstin === party.gstin) && rows.some((r) => r.name === party.name), 'the GSTIN match is the party')
  await h.shot('03-ledgers-gstin')

  // ---------------- 4. Day book: sort, multi-sort, quick filter, column filter, hide columns
  await h.goto('daybook')
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr.dt-row', { timeout: 15000 })
  const all = await tableRows(h, 'daybook')
  assert(all.length >= 10, `Demo Traders has plenty of day-book rows (${all.length})`)
  const total = all.length
  const sortBtn = (c) => `[data-testid="sort-daybook-${c}"]`
  const ariaSort = (c) => h.page.getAttribute(`[data-testid="daybook-table"] thead th[data-col="${c}"]`, 'aria-sort')

  await h.page.click(sortBtn('debit'))
  await h.page.waitForFunction(() => document.querySelector('[data-testid="daybook-table"] th[data-col="debit"]')?.getAttribute('aria-sort') === 'ascending')
  let debits = (await tableRows(h, 'daybook')).map((r) => toPaise(r.debit))
  assertEq(debits.length, total, 'sorting keeps every row')
  assert(nonDecreasing(debits), `Debit ascending: ${debits.join(',')}`)
  assert(debits[0] < debits[debits.length - 1], 'the demo has different debit amounts to order')
  await h.page.click(sortBtn('debit'))
  await h.page.waitForFunction(() => document.querySelector('[data-testid="daybook-table"] th[data-col="debit"]')?.getAttribute('aria-sort') === 'descending')
  debits = (await tableRows(h, 'daybook')).map((r) => toPaise(r.debit))
  assert(nonIncreasing(debits), `Debit descending: ${debits.join(',')}`)
  assertEq(debits[0], Math.max(...all.map((r) => toPaise(r.debit))), 'the largest debit is first')

  // Shift-click: Date becomes the secondary key (ties on Debit run by date).
  await h.page.click(sortBtn('date'), { modifiers: ['Shift'] })
  await h.page.waitForFunction(() => document.querySelector('[data-testid="daybook-table"] th[data-col="date"]')?.getAttribute('aria-sort') === 'ascending')
  assertEq(await ariaSort('debit'), 'descending', 'Shift-click keeps the primary sort')
  assertEq((await h.page.textContent(`${sortBtn('date')} sup`))?.trim(), '2', 'Date is marked as sort key 2')
  const dateOf = new Map(
    (await h.invoke('report:dayBook', { from: '2000-04-01', to: '2099-03-31', includeOutOfBooks: true })).map((v) => [String(v.voucherId), v.date])
  )
  const multi = (await tableRows(h, 'daybook')).map((r) => ({ d: toPaise(r.debit), date: dateOf.get(r._id) }))
  assert(multi.every((m) => m.date), 'every day-book row maps to a voucher date')
  for (let i = 1; i < multi.length; i++) {
    assert(multi[i - 1].d >= multi[i].d, 'multi-sort: Debit still descending')
    if (multi[i - 1].d === multi[i].d) assert(multi[i - 1].date <= multi[i].date, `multi-sort: equal debits run by date (${multi[i - 1].date} > ${multi[i].date})`)
  }
  await h.shot('04-daybook-sorted')

  // Quick filter: a word from the first row's account — expected = rows whose text columns match.
  const word = all[0].account.split(/\s+/).find((w) => w.length >= 4) ?? all[0].account
  const q = word.toLowerCase()
  const expectQuick = all.filter((r) => ['type', 'number', 'account', 'narration'].some((c) => (r[c] ?? '').toLowerCase().includes(q))).length
  assert(expectQuick > 0 && expectQuick < total, `quick filter "${word}" should narrow (${expectQuick} of ${total})`)
  await h.fill('daybook-table-quick', word)
  await h.page.waitForFunction(
    ([n, t]) => document.querySelector('[data-testid="daybook-table-count"]')?.textContent?.trim() === `${n} of ${t} rows`,
    [expectQuick, total],
    { timeout: 10000 }
  )
  rows = await tableRows(h, 'daybook')
  assertEq(rows.length, expectQuick, 'quick filter narrows the rendered rows')
  await h.fill('daybook-table-quick', '')
  await h.page.waitForFunction((t) => document.querySelector('[data-testid="daybook-table-count"]')?.textContent?.trim() === `${t} rows`, total)

  // Column filter: Debit ≥ the median debit (typed in rupees).
  const sortedAmounts = all.map((r) => toPaise(r.debit)).sort((a, b) => a - b)
  const threshold = sortedAmounts[Math.floor(sortedAmounts.length / 2)]
  const expectBig = sortedAmounts.filter((d) => d >= threshold).length
  assert(expectBig < total, 'the threshold leaves some rows out')
  await h.page.hover('[data-testid="daybook-table"] thead th[data-col="debit"]')
  await h.click('filter-daybook-debit')
  await h.page.selectOption('[data-testid="daybook-filter-debit-op"]', 'gte')
  await h.fill('daybook-filter-debit-a', (threshold / 100).toFixed(2))
  await h.click('daybook-filter-debit-apply')
  await h.page.waitForSelector('[data-testid="daybook-table-chip-debit"]', { timeout: 10000 })
  await h.page.waitForFunction(
    ([n, t]) => document.querySelector('[data-testid="daybook-table-count"]')?.textContent?.trim() === `${n} of ${t} rows`,
    [expectBig, total],
    { timeout: 10000 }
  )
  rows = await tableRows(h, 'daybook')
  assertEq(rows.length, expectBig, 'Debit ≥ filter leaves exactly the rows at or above the threshold')
  assert(rows.every((r) => toPaise(r.debit) >= threshold), 'every remaining row clears the threshold')

  // Column chooser: hide Narration and Type.
  await h.click('daybook-table-columns')
  await h.page.uncheck('[data-testid="daybook-table-col-narration"]')
  await h.page.uncheck('[data-testid="daybook-table-col-type"]')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="daybook-table-columns-popover"]', { state: 'detached', timeout: 5000 })
  let cols = await visibleCols(h, 'daybook')
  assert(!cols.includes('narration') && !cols.includes('type'), `Narration and Type hidden (${cols.join(',')})`)
  assert(cols.includes('account') && cols.includes('debit'), 'other columns stay')

  // ---------------- 5. save the view, relaunch, it is still applied
  await h.click('daybook-table-views')
  await h.click('daybook-table-view-save-as')
  await h.fill('daybook-table-view-name', 'Big debits')
  await h.click('daybook-table-view-save')
  await h.page.waitForFunction(() => document.querySelector('[data-testid="daybook-table-views"]')?.textContent?.includes('Big debits'))
  await h.shot('05-daybook-view-saved')

  await h.relaunch()
  assertEq(await h.openCompany('Demo Traders'), 'gateway', 'reopened Demo Traders')
  await h.goto('daybook')
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr.dt-row', { timeout: 15000 })
  const viewsLabel = await h.page.textContent('[data-testid="daybook-table-views"]')
  assert(viewsLabel.includes('Big debits') && !viewsLabel.includes('•'), `the saved view is active and unmodified after relaunch ("${viewsLabel.trim()}")`)
  await h.page.waitForSelector('[data-testid="daybook-table-chip-debit"]', { timeout: 10000 })
  cols = await visibleCols(h, 'daybook')
  assert(!cols.includes('narration') && !cols.includes('type'), 'hidden columns survive the relaunch')
  assertEq(await ariaSort('debit'), 'descending', 'sort survives the relaunch')
  assertEq(await ariaSort('date'), 'ascending', 'secondary sort survives the relaunch')
  rows = await tableRows(h, 'daybook')
  assertEq(rows.length, expectBig, 'the column filter survives the relaunch')
  assert(nonIncreasing(rows.map((r) => toPaise(r.debit))), 'rows still in Debit-descending order')

  // ---------------- 6. CSV export of the current view
  const exportsDir = path.join(h.dataDir, 'companies', 'demo-traders', 'exports')
  const before = new Set(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [])
  await h.click('daybook-table-csv')
  await h.page.waitForFunction(() => document.body.textContent?.includes('Saved to exports'), null, { timeout: 20000 })
  const added = fs.readdirSync(exportsDir).filter((f) => !before.has(f) && f.endsWith('.csv'))
  assertEq(added.length, 1, `one CSV written (${added.join(', ')})`)
  const csv = parseCsv(fs.readFileSync(path.join(exportsDir, added[0]), 'utf8'))
  const labels = await h.page.$$eval('[data-testid="daybook-table"] thead th[data-col]', (ths) =>
    ths.map((th) => th.querySelector('[data-testid^="sort-"] span')?.textContent?.trim() ?? th.textContent.trim())
  )
  assertEq(JSON.stringify(csv[0]), JSON.stringify(labels), 'CSV header = the visible columns, in order')
  assert(!csv[0].includes('Narration') && !csv[0].includes('Type'), 'hidden columns are not exported')
  const body = csv.slice(1)
  const totalsRow = body[body.length - 1]
  assert(totalsRow.some((c) => c.startsWith('Total')), `last CSV line is the totals row (${totalsRow.join(' | ')})`)
  assertEq(body.length - 1, expectBig, 'CSV data lines = the filtered rows')
  const debitIdx = csv[0].indexOf('Debit')
  assert(body.slice(0, -1).every((r) => toPaise(r[debitIdx]) >= threshold), 'every exported row clears the filter')
  assert(nonIncreasing(body.slice(0, -1).map((r) => toPaise(r[debitIdx]))), 'exported rows keep the sort')
  await h.shot('06-daybook-after-relaunch')
})
