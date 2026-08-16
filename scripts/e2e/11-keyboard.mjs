// Scenario 11 — keyboard-only navigation: Gateway single-letter shortcuts, ↑↓↵ list
// navigation on the Day Book (the amber bar), and the Cmd/Ctrl-K command palette — no mouse
// anywhere after the initial company build.
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
})
