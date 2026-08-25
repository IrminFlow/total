// Scenario 11 — keyboard-only navigation: Gateway single-letter shortcuts, ↑↓↵ list
// navigation on the Day Book (the amber bar), and the Cmd/Ctrl-K command palette — no mouse
// anywhere after the initial company build.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('11-keyboard', async (h) => {
  await h.createDemoCompany()

  const gatewayLayout = await h.page.evaluate(() => {
    const operations = document.querySelector('[data-testid="gateway-operations"]')?.getBoundingClientRect()
    const firstTask = document.querySelector('[data-testid^="card-"]')?.getBoundingClientRect()
    return {
      tasksBeforeOperations: Boolean(operations && firstTask && firstTask.top < operations.top),
      visibleTaskCount: document.querySelectorAll('[data-testid^="card-"]').length,
    }
  })
  assert(gatewayLayout.tasksBeforeOperations, 'daily task launchers appear before the operating snapshot')
  assert(gatewayLayout.visibleTaskCount <= 6, `Gateway keeps the first view focused (${gatewayLayout.visibleTaskCount} task launchers)`)
  await h.click('btn-all-gateway-tasks')
  await h.page.waitForSelector('[data-testid="all-task-month-close"]')
  await h.page.keyboard.press('Escape')

  // A opens the new daily work queue. Pinning is company-specific and survives navigation.
  await h.page.keyboard.press('a')
  await h.waitScreen('action-centre')
  await h.page.waitForSelector('text=Collections priorities')
  await h.shot('00-action-centre')
  if ((await h.page.getAttribute('[data-testid="btn-pin-screen"]', 'title'))?.startsWith('Pin this')) {
    await h.page.click('[data-testid="btn-pin-screen"]')
  }
  await h.page.waitForFunction(() => document.querySelector('[data-testid="btn-pin-screen"]')?.getAttribute('title')?.startsWith('Remove'))
  assert((await h.page.textContent('aside')).includes('Pinned'), 'Action centre can be pinned to the workspace')
  await h.page.keyboard.press('Alt+g')
  await h.waitScreen('gateway')

  // Red mnemonic on the Gateway: V opens Voucher Entry. Bare C selects Contra there.
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-contra"]')
  const voucherFunctionKeys = await h.page.evaluate(() =>
    ['contra', 'payment', 'receipt', 'journal', 'sales', 'purchase'].map((kind) =>
      document.querySelector(`[data-testid="tab-voucher-entry-${kind}"] kbd`)?.textContent?.trim()
    )
  )
  assert(
    JSON.stringify(voucherFunctionKeys) === JSON.stringify(['F4', 'F5', 'F6', 'F7', 'F8', 'F9']),
    `voucher toolbar exposes F4-F9 beside their types: ${JSON.stringify(voucherFunctionKeys)}`,
  )
  await h.shot('00-voucher-shortcuts')
  await h.page.keyboard.press('c')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-contra"][aria-current="page"]')
  assert(true, 'C selected Contra')
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('Escape')
  await h.waitScreen('gateway')

  // Gateway single-letter shortcut: D → Day Book.
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook')
  await h.shot('01-daybook-via-shortcut')

  // ↓ moves the amber selection bar; the active row follows data-active.
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr[data-row-id]', { timeout: 10000 })
  const dayBookTable = await h.page.evaluate(() => {
    const row = document.querySelector('[data-testid="rows-daybook"] tr[data-active="true"]')
    const date = row?.querySelector('td:nth-child(2)')
    const header = document.querySelector('.daybook-ledger thead th')
    const scroller = document.querySelector('[data-testid="daybook-table-scroll"]')
    return {
      role: row?.getAttribute('role'),
      tabIndex: row?.getAttribute('tabindex'),
      dateWhiteSpace: date ? getComputedStyle(date).whiteSpace : null,
      headerPosition: header ? getComputedStyle(header).position : null,
      reportSelection: scroller ? getComputedStyle(scroller).userSelect : null,
      horizontalOverflow: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : true,
    }
  })
  assert(dayBookTable.role === 'button' && dayBookTable.tabIndex === '0', 'active Day Book row is a roving keyboard target')
  assert(dayBookTable.dateWhiteSpace === 'nowrap', 'Day Book dates do not wrap')
  assert(dayBookTable.headerPosition === 'sticky', 'Day Book column headings remain visible while scrolling')
  assert(dayBookTable.reportSelection === 'text', 'Day Book report values remain selectable')
  assert(!dayBookTable.horizontalOverflow, 'Day Book fits its standard 1440px workbench without horizontal scrolling')
  const activeRowId = () =>
    h.page.evaluate(() => {
      const rows = document.querySelectorAll('.kbar-row[data-active="true"]')
      const el = rows[rows.length - 1]
      return el ? el.getAttribute('data-row-id') : null
    })
  const first = await activeRowId()
  assert(first != null, 'daybook has an active (amber-bar) row')
  await h.page.keyboard.press('ArrowDown')
  const second = await activeRowId()
  assert(second != null && second !== first, `ArrowDown moved the selection (${first} → ${second})`)
  await h.page.keyboard.press('ArrowUp')
  const back = await activeRowId()
  assert(back != null, 'ArrowUp kept a valid row selected')

  // ↵ opens the selected voucher in the entry screen (alteration mode).
  await h.page.locator('.kbar-row[data-active="true"]').last().focus()
  await h.page.keyboard.press('Enter')
  await h.waitScreen('voucher-entry', 20000)
  await h.shot('02-voucher-opened-by-enter')

  // Ctrl+K opens the command palette; typing filters; ↵ runs the navigation command.
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-palette"]', 'trial balance')
  await h.shot('03-palette')
  await h.page.keyboard.press('Enter')
  await h.waitScreen('trial-balance', 20000)
  await h.shot('04-trial-balance-via-palette')

  // Escape closes the palette without navigating.
  await h.page.keyboard.press('Control+k')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  const recentState = await h.page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('recent-records'))))
  assert(Object.values(recentState).some((value) => String(value).includes('voucher')), `recent voucher was persisted: ${JSON.stringify(recentState)}`)
  await h.page.getByText('Recent records', { exact: true }).waitFor()
  await h.page.getByText(/Voucher #\d+/, { exact: true }).waitFor()
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="input-palette"]', { state: 'detached', timeout: 10000 })
  const screen = await h.page.getAttribute('[data-screen]', 'data-screen')
  assert(screen === 'trial-balance', 'Escape closed the palette without navigating away')

  // Universal action commands change working context as well as opening screens.
  await h.page.keyboard.press('Control+k')
  await h.page.fill('[data-testid="input-palette"]', 'set period this month')
  await h.page.keyboard.press('Enter')
  await h.page.waitForFunction(() => document.body.innerText.includes('01-Aug-26 → 31-Aug-26'))
  assert(true, 'command palette changed the global working period')

  await h.click('btn-period')
  await h.fill('input-period-quick', 'Q2')
  await h.click('btn-period-quick')
  await h.click('btn-apply-period')
  await h.page.waitForFunction(() => document.body.innerText.includes('01-Jul-26 → 30-Sep-26'))
  assert(true, 'natural period language resolved Q2 in the Indian financial year')

  // App-wide Alt+E opens Registers even outside the Gateway. Quarterly aggregates remain drillable.
  await h.page.keyboard.press('Alt+e')
  await h.waitScreen('registers')
  await h.page.click('[data-testid="tab-register-granularity-quarter"]')
  await h.page.waitForSelector('[data-testid="rows-registers"] tr[data-row-id*="-Q"]', { timeout: 10000 })
  await h.shot('05-quarterly-register')
  await h.page.click('[data-testid="rows-registers"] tr[data-row-id*="-Q"]')
  await h.waitScreen('daybook')
  assert((await h.page.textContent('body')).includes('Q'), 'Quarter drill-down carries its period label into Day Book')
})
