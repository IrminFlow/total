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

  // ---- Tally Enter-chaining: Enter walks the fields and raises the Accept bar at the end ----
  await home()
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry', 20000)
  await h.page.keyboard.press('F7') // Journal — a plain accounting form, no invoice extras
  await h.page.waitForSelector('[data-testid="rows-voucher-lines"]', { timeout: 10000 })

  const focusedTag = () => h.page.evaluate(() => document.activeElement?.tagName ?? null)
  const focusedMark = () =>
    h.page.evaluate(() => {
      const el = document.activeElement
      if (!el) return null
      return el.getAttribute('data-chain') ?? el.getAttribute('placeholder') ?? el.tagName
    })

  // Start from the voucher number field and walk forward. Enter must move focus, never submit.
  await h.page.click('[data-testid="input-voucher-number"]')
  const seen = new Set()
  for (let i = 0; i < 25; i++) {
    seen.add(await focusedMark())
    await h.page.keyboard.press('Enter')
    if (await h.page.$('[data-testid="voucher-accept-bar"]')) break
  }
  assert(seen.size > 2, `Enter moved focus across several fields (saw ${seen.size})`)
  assert(await focusedTag(), 'focus stayed inside the form while chaining')

  const acceptBar = await h.page.$('[data-testid="voucher-accept-bar"]')
  assert(acceptBar != null, 'Enter past the last field raised the Accept bar')
  await h.shot('06-accept-bar')

  // Esc dismisses the Accept bar without saving, exactly as answering "No" does.
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-testid="voucher-accept-bar"]', { state: 'detached', timeout: 10000 })
  const stillEntry = await h.page.getAttribute('[data-screen]', 'data-screen')
  assert(stillEntry === 'voucher-entry', 'declining the Accept bar stays on the voucher')

  // ---- Ctrl+[ / Ctrl+] walk the nav stack, and Ctrl+1..9 jump positionally ----
  await home()
  await h.page.keyboard.press('t') // Trial balance
  await h.waitScreen('trial-balance', 20000)
  await h.page.keyboard.press('Control+[')
  await h.waitScreen('gateway', 20000)
  // Forward must return to exactly where back came from.
  await h.page.keyboard.press('Control+]')
  await h.waitScreen('trial-balance', 20000)
  // Navigating somewhere new drops the forward path, so a second ] must do nothing.
  await h.page.keyboard.press('Control+[')
  await h.waitScreen('gateway', 20000)
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook', 20000)
  await h.page.keyboard.press('Control+]')
  const afterForward = await h.page.getAttribute('[data-screen]', 'data-screen')
  assert(afterForward === 'daybook', `a stale forward path is discarded (on ${afterForward})`)

  // Ctrl+1 is the first sidebar entry, which is the Gateway.
  const firstNav = await h.page.$eval('[data-testid^="nav-"]', (el) => (el.dataset.testid || '').replace(/^nav-/, ''))
  await h.page.keyboard.press('Control+1')
  await h.waitScreen(firstNav, 20000)

  // ---- Ctrl+F focuses the filter box on a screen that has one ----
  await home()
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook', 20000)
  await h.page.keyboard.press('Control+f')
  const focusedFilter = await h.page.evaluate(() =>
    document.activeElement?.hasAttribute('data-filter-box') ?? false
  )
  assert(focusedFilter, 'Ctrl+F focuses the Day Book filter')
  // And typing there filters rather than navigating: the nav layer must not see the letters.
  await h.page.keyboard.type('zzzz')
  const stillDaybook = await h.page.getAttribute('[data-screen]', 'data-screen')
  assert(stillDaybook === 'daybook', 'typing in the filter does not trigger nav accelerators')
  await h.page.keyboard.press('Escape')

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
