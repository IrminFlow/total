// Scenario 47 — WP 8.1 company mode: a new company opens in the full (accountant) app; the owner
// switches it to simple in Settings → How Total looks; the simple sidebar has ≤ 10 entries;
// Settings opens through the simple shell; a mapped screen (People → Customers and suppliers =
// the ledger list filtered to parties) opens inside the simple shell, and "Accountant view" shows
// the same screen in the full shell with the same state, "Back to simple" returns; switching
// back restores the identical accountant sidebar; another (accountant) company is unchanged.
// Light and dark screenshots of Home, every section and Settings for the visual review.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

/** Deep equality (the harness assertEq is ===). */
const assertSame = (actual, expected, label) => assertEq(JSON.stringify(actual), JSON.stringify(expected), label)

const SECTIONS = ['sell', 'buy', 'money', 'stock', 'people', 'reports', 'taxes', 'settings']

await scenario('47-mode-switch', async (h) => {
  // Entries and section heads (the ▾ / ▸ open state is the user's own preference — opening
  // Settings expands System — so it is not compared).
  const accountantSidebar = () =>
    h.page.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Main"] [data-testid^="nav-"]')].map((b) => `${b.getAttribute('data-testid')}|${b.textContent?.replace(/[▾▸]/g, '')}`)
    )
  const simpleSidebar = () =>
    h.page.evaluate(() => [...document.querySelectorAll('[data-testid="simple-nav"] [data-testid^="simple-nav-"]')].map((b) => b.textContent))
  const attached = (sel) => h.page.waitForSelector(sel, { state: 'attached', timeout: 10000 })
  const absent = async (sel) => assertEq(await h.page.$(sel), null, `${sel} is not on screen`)

  await h.createCompanyUI('Mode Switch Co')
  assertSame((await h.invoke('company:current')).ui, { mode: 'accountant' }, 'a new company is accountant (no ui meta)')
  const before = await accountantSidebar()
  assert(before.some((x) => x.startsWith('nav-voucher-entry|')) && before.some((x) => x.startsWith('nav-trial-balance|')), 'full sidebar')
  await absent('[data-testid="simple-nav"]')
  await absent('[data-testid="btn-back-to-simple"]')

  // The owner (no users yet = everyone is the owner) switches to simple.
  await h.goto('settings')
  await h.click('tab-settings-appearance')
  await attached('[data-testid="mode-setting"]')
  await h.click('btn-mode-simple')
  await attached('[data-testid="simple-nav"]')
  assertEq((await h.invoke('company:current')).ui.mode, 'simple', 'meta ui written')
  const audit = await h.invoke('audit:list', { entity: 'company', page: 0 })
  assert(audit.rows.some((r) => r.action === 'update' && JSON.parse(r.afterJson ?? '{}').ui?.mode === 'simple'), 'mode switch audited as a company update')

  const entries = await simpleSidebar()
  assert(entries.length <= 10, `simple sidebar has ${entries.length} entries (≤ 10)`)
  assertSame(entries, ['Home', 'Sell', 'Buy', 'Money', 'Stock', 'People', 'Reports', 'Taxes', 'Settings'], 'simple sections')
  assertEq((await h.page.textContent('[data-testid="btn-search"]'))?.trim(), 'Search ⌘K', 'palette labelled Search')

  // Light: Home, every section, Settings → How Total looks.
  const tour = async (theme) => {
    await h.click('simple-nav-home')
    await h.waitScreen('gateway')
    await attached('[data-testid="simple-home"]')
    await h.shot(`${theme}-home`)
    for (const s of SECTIONS) {
      await h.click(`simple-nav-${s}`)
      await attached(`[data-testid="simple-section-${s}"]`)
      await h.waitIdle()
      await h.shot(`${theme}-section-${s}`)
    }
    await h.click('simple-entry-looks')
    await h.waitScreen('settings')
    await h.shot(`${theme}-settings-looks`)
  }
  await tour('light')

  // Settings opened through the simple shell stays in it.
  await h.click('simple-nav-settings')
  await attached('[data-testid="simple-section-settings"]')
  await h.click('simple-entry-business')
  await h.waitScreen('company-info')
  await attached('[data-testid="simple-nav"]')

  // A mapped screen: People → Customers and suppliers (ledgers filtered to parties).
  await h.click('simple-nav-people')
  await h.click('simple-entry-customers-suppliers')
  await h.waitScreen('masters')
  await attached('[data-testid="masters-ledgers-parties-only"]')
  await attached('[data-testid="simple-nav"]')
  await h.fill('masters-ledgers-filter', 'Ramesh')
  await h.shot('light-mapped-screen')

  // Accountant view: the full shell, the same screen and state.
  await h.click('btn-accountant-view')
  await attached('nav[aria-label="Main"]')
  await absent('[data-testid="simple-nav"]')
  await h.waitScreen('masters')
  assertEq(await h.page.inputValue('[data-testid="masters-ledgers-filter"]'), 'Ramesh', 'filter kept across the view switch')
  await attached('[data-testid="masters-ledgers-parties-only"]')
  await h.shot('light-accountant-view')
  const remembered = await h.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('total-view:') && k.endsWith(':masters')))
  assertEq(remembered.length, 1, 'the accountant view is remembered for this screen')

  // Back to simple.
  await h.click('btn-back-to-simple')
  await attached('[data-testid="simple-nav"]')
  assertEq(await h.page.inputValue('[data-testid="masters-ledgers-filter"]'), 'Ramesh', 'state kept going back')

  // Dark: the same tour.
  await h.click('btn-theme')
  await h.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await tour('dark')
  await h.click('btn-theme')

  // Switch back to the full app: the identical accountant sidebar.
  await h.click('btn-mode-accountant')
  await attached('nav[aria-label="Main"]')
  assertEq((await h.invoke('company:current')).ui.mode, 'accountant', 'back to accountant')
  await h.click('nav-gateway')
  await h.waitScreen('gateway')
  assertSame(await accountantSidebar(), before, 'accountant sidebar identical after the round trip')
  await absent('[data-testid="btn-back-to-simple"]')

  // Another company, never switched: the old sidebar, no toggle.
  await h.click('btn-switch-company')
  await h.createCompanyUI('Plain Accountant Co')
  assertSame(await accountantSidebar(), before, 'an accountant company shows the 0.10 sidebar')
  await absent('[data-testid="simple-nav"]')
  await absent('[data-testid="btn-back-to-simple"]')
  await absent('[data-testid="btn-accountant-view"]')
})
