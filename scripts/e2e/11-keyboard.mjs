// Scenario 11 — keyboard-only navigation: Gateway single-letter shortcuts, ↑↓↵ list
// navigation on the Day Book (the amber bar), the Cmd/Ctrl-K command palette, and ←/→ on the
// sidebar section headings — no mouse anywhere after the initial company build.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('11-keyboard', async (h) => {
  await h.createDemoCompany()

  // Gateway single-letter shortcut: D → Day Book.
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook')
  await h.shot('01-daybook-via-shortcut')

  // ↓ moves the amber selection bar; the active row follows data-active.
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr[data-row-id]', { timeout: 10000 })
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
  assert(back === first, 'ArrowUp moved back to the first row')

  // ↵ opens the selected voucher in the entry screen (alteration mode).
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
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="input-palette"]', { state: 'detached', timeout: 10000 })
  const screen = await h.page.getAttribute('[data-screen]', 'data-screen')
  assert(screen === 'trial-balance', 'Escape closed the palette without navigating away')

  // Sidebar section headings: → expands, ← collapses (Banking isn't the active section).
  const bankingOpen = () => h.page.getAttribute('[data-testid="nav-section-banking"]', 'aria-expanded')
  await h.page.focus('[data-testid="nav-section-banking"]')
  await h.page.keyboard.press('ArrowRight')
  assert((await bankingOpen()) === 'true', 'ArrowRight expanded the Banking section')
  assert(await h.page.isVisible('[data-testid="nav-banking"]'), 'Banking items are visible once expanded')
  await h.page.keyboard.press('ArrowLeft')
  assert((await bankingOpen()) === 'false', 'ArrowLeft collapsed the Banking section')

  // Voucher F-keys, split in WP 2.5d (design §9 Q10): Ctrl+F8 / Ctrl+F9 are the credit / debit
  // note; Alt+F8 / Alt+F9 are the delivery challan / GRN — and do nothing while Orders & challans
  // is off (no stock-note screens), rather than opening a note as before.
  const selected = (kind) => h.page.getAttribute(`[data-testid="tab-voucher-entry-${kind}"]`, 'aria-selected')
  await h.goto('voucher-entry')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-sales"]', { timeout: 10000 })
  await h.page.keyboard.press('F8')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-sales"][aria-selected="true"]', { timeout: 5000 })
  await h.page.keyboard.press('Control+F8')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-credit_note"][aria-selected="true"]', { timeout: 5000 })
  await h.page.keyboard.press('Control+F9')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-debit_note"][aria-selected="true"]', { timeout: 5000 })
  await h.page.keyboard.press('Alt+F8')
  await h.page.waitForTimeout(300)
  assert((await selected('debit_note')) === 'true', 'Alt+F8 with Orders & challans off leaves the voucher type alone')
  assert((await h.page.locator('[data-testid="tab-voucher-entry-delivery_note"]').count()) === 0, 'no delivery challan tab while the feature is off')
  await h.shot('05-ctrl-f9-debit-note')

  // With Orders & challans on, Alt+F8 / Alt+F9 open the challan / GRN.
  const features = await h.invoke('config:features:get')
  await h.invoke('config:features:set', { ...features, inventory: true, orders: true })
  await h.relaunch()
  await h.openCompany('Demo Traders')
  await h.goto('voucher-entry')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-sales"]', { timeout: 10000 })
  await h.page.keyboard.press('Alt+F8')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-delivery_note"][aria-selected="true"]', { timeout: 5000 })
  await h.page.keyboard.press('Alt+F9')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-receipt_note"][aria-selected="true"]', { timeout: 5000 })
  await h.page.keyboard.press('Control+F8')
  await h.page.waitForSelector('[data-testid="tab-voucher-entry-credit_note"][aria-selected="true"]', { timeout: 5000 })
  await h.shot('06-alt-f9-then-ctrl-f8')
})
