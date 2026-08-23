// Scenario 11 — keyboard-only navigation: registry accelerators (the red letters), ↑↓↵ list
// navigation on the Day Book (the amber bar), and the Cmd/Ctrl-K command palette — no mouse
// anywhere after the initial company build.
//
// The accelerator sweep deliberately ENUMERATES the letters from the running app rather than
// from a copy of the table kept here: a screen added to the sidebar without an accelerator, or
// one whose letter changes, shows up as a real failure instead of silently going untested.
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

  // ---- every sidebar accelerator reaches its screen, from wherever we happen to be ----
  const accels = await h.page.$$eval('[data-nav-accel]', (els) =>
    els.map((el) => ({ accel: el.dataset.navAccel, screen: (el.dataset.testid || '').replace(/^nav-/, '') }))
  )
  assert(accels.length >= 20, `sidebar exposes its accelerators (found ${accels.length})`)

  const navButtons = await h.page.$$eval('[data-testid^="nav-"]', (els) => els.length)
  assert(
    accels.length === navButtons,
    `every visible sidebar item has an accelerator (${accels.length} of ${navButtons})`
  )

  // Return to the Gateway between letters so each one is exercised from the same place and a
  // failure names the letter rather than wherever we happened to be. Going via G and *waiting*
  // matters: nav.back()/home() run the unsaved-changes guard asynchronously, so pressing the
  // next letter immediately after Escape can land on the screen we were trying to leave.
  const home = async () => {
    await h.page.keyboard.press('Escape')
    await h.page.keyboard.press('g')
    await h.waitScreen('gateway', 20000)
  }

  for (const { accel, screen: target } of accels) {
    await home()
    await h.page.keyboard.press(accel.toLowerCase())
    await h.waitScreen(target, 20000)
  }
  await h.shot('05-accelerator-sweep')

  // ---- arrow-key selection works on every screen that renders a row table ----
  const rowScreens = []
  for (const { accel, screen: target } of accels) {
    await home()
    await h.page.keyboard.press(accel.toLowerCase())
    await h.waitScreen(target, 20000)
    const hasRows = await h.page.$$eval('[data-testid^="rows-"] tr[data-row-id]', (els) => els.length > 0)
    if (!hasRows) continue
    rowScreens.push(target)
    await h.page.keyboard.press('ArrowDown')
    const active = await h.page.$$eval('.kbar-row[data-active="true"]', (els) => els.length)
    assert(active > 0, `${target}: ArrowDown selects a row`)
  }
  assert(rowScreens.length > 0, `at least one screen exercised list navigation (${rowScreens.join(', ')})`)

  // A letter must never fire while the user is typing into a field.
  await home()
  await h.page.keyboard.press('m')
  await h.waitScreen('masters', 20000)
  const search = await h.page.$('input[type="text"], input:not([type])')
  if (search) {
    await search.click()
    await search.type('d')
    const stillMasters = await h.page.getAttribute('[data-screen]', 'data-screen')
    assert(stillMasters === 'masters', 'typing a letter into a field does not navigate')
    await h.page.keyboard.press('Escape')
  }

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
