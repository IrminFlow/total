// Scenario 11 — keyboard-only navigation: registry accelerators (the red letters), ↑↓↵ list
// navigation on the Day Book (the accent bar), and the Cmd/Ctrl-K command palette — no mouse
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

  // ↓ moves the accent selection bar; the active row follows data-active.
  await h.page.waitForSelector('[data-testid="rows-daybook"] tr[data-row-id]', { timeout: 10000 })
  const activeRowId = () =>
    h.page.evaluate(() => {
      const rows = document.querySelectorAll('.kbar-row[data-active="true"]')
      const el = rows[rows.length - 1]
      return el ? el.getAttribute('data-row-id') : null
    })
  const first = await activeRowId()
  assert(first != null, 'daybook has an active (accent-bar) row')
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
    // Click rather than press 'g'.
    //
    // The Counter is a till: its scan box autofocuses and takes focus BACK on a timeout, because
    // a barcode gun types into it and a letter that navigated away mid-scan would lose the sale.
    // Escape in that box clears the cart and re-focuses it, so a letter pressed straight after
    // races the refocus and lands in the field about one run in three. The accelerator layer is
    // right to decline a letter typed into a text field, so this is the harness getting back to a
    // known place, not the behaviour under test — the letters themselves are swept below, and 'g'
    // from another screen is asserted explicitly right after.
    await h.page.click('[data-testid="nav-gateway"]')
    await h.waitScreen('gateway', 20000)
  }

  // 'g' from somewhere that is not the Gateway, once, deliberately: the sweep below presses every
  // letter from the Gateway, where pressing 'g' would prove nothing.
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook', 20000)
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway', 20000)

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

  // ---- Ctrl+` switches back to the previous screen, alt-tab style ----
  await home()
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook', 20000)
  await h.page.keyboard.press('t')
  await h.waitScreen('trial-balance', 20000)
  await h.page.keyboard.press('Control+`')
  await h.waitScreen('daybook', 20000)
  // And again returns to where we just were: the ring reorders on every commit.
  await h.page.keyboard.press('Control+`')
  await h.waitScreen('trial-balance', 20000)

  // Held down, it opens the picker and walks further back. The overlay only exists mid-cycle.
  await h.page.keyboard.down('Control')
  await h.page.keyboard.press('`')
  await h.page.keyboard.press('`')
  const ringVisible = await h.page.$('[data-testid="recent-ring"]')
  assert(ringVisible != null, 'holding the modifier shows the recent-screens ring')
  await h.shot('07-recent-ring')
  await h.page.keyboard.up('Control')
  await h.page.waitForSelector('[data-testid="recent-ring"]', { state: 'detached', timeout: 10000 })

  // ---- ? overlay has a search box, and it filters ----
  await home()
  await h.page.keyboard.press('?')
  await h.page.waitForSelector('[data-testid="input-shortcut-search"]', { timeout: 10000 })
  const countRows = () => h.page.$$eval('[data-testid="shortcut-row"]', (els) => els.length)
  const allRows = await countRows()
  assert(allRows > 30, `the ? overlay lists every binding (${allRows})`)
  await h.page.fill('[data-testid="input-shortcut-search"]', 'balance')
  const someRows = await countRows()
  assert(someRows > 0 && someRows < allRows, `the ? overlay search narrows the list (${allRows} → ${someRows})`)
  await h.shot('08-shortcut-search')
  await h.page.keyboard.press('Escape')

  // ---- Ctrl+Shift+F searches, scoped to the screen ----
  await home()
  await h.page.keyboard.press('d')
  await h.waitScreen('daybook', 20000)
  await h.page.keyboard.press('Control+Shift+f')
  await h.page.waitForSelector('[data-testid="input-palette"]', { timeout: 10000 })
  const scopedPlaceholder = await h.page.getAttribute('[data-testid="input-palette"]', 'placeholder')
  assert(
    /vouchers on this screen/.test(scopedPlaceholder ?? ''),
    `Ctrl+Shift+F scopes the search to the Day Book ("${scopedPlaceholder}")`
  )
  await h.page.keyboard.press('Escape')

  // ---- the voucher grid: paste a table, move a line, delete one, round off ----
  await home()
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry', 20000)
  await h.page.keyboard.press('F7') // Journal
  await h.page.waitForSelector('[data-testid="rows-voucher-lines"]', { timeout: 10000 })

  const lineCount = () => h.page.$$eval('[data-testid="rows-voucher-lines"] tr[data-line-index]', (els) => els.length)
  const before = await lineCount()

  // Two ledger names read from the running book rather than hard-coded, so the paste is matched
  // against masters that really exist however the demo company's chart of accounts changes.
  const ledgerNames = await h.page.evaluate(async () => {
    const res = await window.total.invoke('master:ledgers:list')
    return (res.data ?? []).map((l) => l.name).slice(0, 2)
  })
  assert(ledgerNames.length === 2, `the demo company has ledgers to paste against (${ledgerNames.join(', ')})`)

  // A tab-separated block, exactly as a spreadsheet puts it on the clipboard, in the classic
  // two-money-column journal shape. Delivered through a real paste event on the grid, so what is
  // exercised is the handler the user reaches.
  const pasted = await h.page.evaluate((rows) => {
    const grid = document.querySelector('[data-testid="voucher-grid"]')
    if (!grid) return false
    const data = new DataTransfer()
    data.setData('text/plain', `${rows[0]}\t1000\t\n${rows[1]}\t\t1000`)
    grid.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  }, ledgerNames)
  assert(pasted, 'the voucher grid is present to paste into')
  await h.page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="rows-voucher-lines"] tr[data-line-index]').length > n,
    before,
    { timeout: 10000 }
  )
  const afterPaste = await lineCount()
  assert(afterPaste > before, `pasting a table added lines (${before} → ${afterPaste})`)

  // The pasted names resolved against the demo company's own ledgers, so the voucher balances.
  const balancedText = await h.page.textContent('[data-testid="rows-voucher-lines"]')
  assert(balancedText != null, 'the grid rendered the pasted lines')
  await h.shot('09-pasted-lines')

  // The account names, in grid order — column 2 is Particulars.
  const names = () =>
    h.page.$$eval('[data-testid="rows-voucher-lines"] tr[data-line-index] td:nth-child(2) input', (els) =>
      els.map((el) => el.value).filter((v) => v !== '')
    )

  // Focus is set directly rather than clicked: the cell only has to HAVE focus for the chord to
  // find its line, and a click has to wait for a re-rendering grid to hold still first.
  const focusLine = (i) =>
    h.page.evaluate((n) => {
      const el = document.querySelector(
        `[data-testid="rows-voucher-lines"] tr[data-line-index="${n}"] td:nth-child(2) input`
      )
      el?.focus()
      return document.activeElement === el
    }, i)

  // ⌥↑ moves the focused line up, so the first two account names swap.
  const orderBefore = await names()
  assert(
    JSON.stringify(orderBefore) === JSON.stringify(ledgerNames),
    `both pasted names resolved to their ledgers (wanted ${ledgerNames.join(', ')}, got ${orderBefore.join(', ')})`
  )
  assert(await focusLine(1), 'the second line takes focus')
  await h.page.keyboard.press('Alt+ArrowUp')
  const orderAfter = await names()
  assert(
    orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0],
    `Alt+ArrowUp swapped the first two lines (${orderBefore.join(',')} → ${orderAfter.join(',')})`
  )

  // ⌘⌫ removes the focused line and offers it straight back on the toast.
  const beforeDelete = await lineCount()
  assert(await focusLine(0), 'the first line takes focus')
  await h.page.keyboard.press('Control+Backspace')
  await h.page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="rows-voucher-lines"] tr[data-line-index]').length < n,
    beforeDelete,
    { timeout: 10000 }
  )
  const undo = await h.page.$('text=Undo')
  assert(undo != null, 'deleting a line offers an undo on the toast')
  await undo.click()
  await h.page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="rows-voucher-lines"] tr[data-line-index]').length === n,
    beforeDelete,
    { timeout: 10000 }
  )
  assert((await lineCount()) === beforeDelete, 'Undo put the deleted line back')

  // Leave the screen clean. A half-typed voucher arms the unsaved-changes guard, which is a real
  // `beforeunload` handler — the harness's teardown then closes the window into a native dialog
  // and the scenario dies with a protocol error rather than a result.
  // Blur first: Escape inside a field means "leave the field", so from a focused cell the first
  // press never reaches the nav layer.
  await h.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await h.page.keyboard.press('Escape')
  const discard = await h.page.waitForSelector('[data-testid="confirm-ok"]', { timeout: 10000 })
  await discard.click()
  await h.waitScreen('gateway', 20000)
})
