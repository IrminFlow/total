// WP 10.5 — accessibility of the simple shell and its screens, checked on the rendered DOM (no
// axe in deps — a role / name / label sweep in the same spirit, plus the landmarks):
//   - every button, link, tab, radio, option and menu item has an accessible name;
//   - every input / select / textarea is labelled; aria-describedby / aria-labelledby resolve;
//   - tabs sit in a tablist, options in a listbox, radios in a radiogroup; dialogs are named;
//   - no duplicate ids; decorative SVGs are hidden from readers; tables have column headers;
//   - the shell has banner / navigation / main, and the panels are named complementary regions;
//   - window sizes: under 1200 px the sidebar is icons-only with each label as the button's name
//     (and beside it on focus); under 1600 px the panels overlay the screen instead of docking.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import type { SellSetup } from '@shared/simple/sell'
import { SIMPLE_SECTION_IDS } from '@shared/simple/uiMode'
import { useNav, useSession } from '../state/stores'
import { Shell } from '../components/Shell'
import { SimpleSection } from '../simple/SimpleSection'
import { SetupWizard } from '../simple/SetupWizard'
import { MakeBill } from '../simple/sell/MakeBill'
import { HelpPanel } from '../simple/help/HelpPanel'
import { useHelpPanel } from '../help/store'
import { SaveBar } from '../simple/SaveBar'
import { DockModeContext, DockedDrawer } from '../components/kit'
import { SIMPLE_DOCK_FROM, SIMPLE_NAV_COLLAPSE_BELOW } from '../lib/simpleLayout'
import { a11yProblems, textOf } from './helpers/a11yProblems'

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 5, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false }) as Ledger
const SETUP: SellSetup = {
  walkInId: null,
  customers: [{ id: 10, name: 'Ramesh', stateCode: '27', phone: null, creditHold: false }],
  moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }],
  defaults: { cash: 30, upi: 30, card: 30, bank: 30 },
  memoryId: null,
  salesAccountId: 20
}
const INFO: CompanyInfo = { name: 'Sharma Kirana', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }

/** Answers `(max-width: Npx)` queries as a window `width` px wide would. */
function windowWidth(width: number | null): void {
  if (width == null) {
    // @ts-expect-error -- jsdom has no matchMedia; tests put it back to "absent"
    delete window.matchMedia
    return
  }
  window.matchMedia = ((query: string) => {
    const m = /max-width:\s*([\d.]+)px/.exec(query)
    return { matches: m ? width <= Number(m[1]) : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }
  }) as unknown as typeof window.matchMedia
}

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: [ledger(10, 'Ramesh', 2), ledger(20, 'Sales', 5), ledger(30, 'Cash', 1)] }
      case 'master:units:list': return { ok: true, data: [{ id: 4, name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' }] }
      case 'simple:sell:setup': return { ok: true, data: SETUP }
      case 'ai:settings:get': return { ok: true, data: { settings: { enabled: false }, keyPresent: false, ready: false, blocker: 'off' } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => undefined } as unknown as typeof window.total
  act(() => {
    useSession.setState({ slug: 'sharma', locked: false, user: null, info: INFO, ui: { mode: 'simple' }, from: '2026-04-01', to: '2027-03-31', workingDate: '2026-10-14' } as never)
    useNav.setState({ stack: [{ name: 'gateway' }] })
    useHelpPanel.setState({ open: false, article: null, follow: false, query: '' })
  })
})
afterEach(() => {
  cleanup()
  windowWidth(null)
  delete document.documentElement.dataset.shell
})

// ---------------------------------------------------------------------------------------------

describe('the simple shell (WP 10.5)', () => {
  it('landmarks: one banner, the navigation, main; the help panel is a named complementary region', async () => {
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    await screen.findByTestId('simple-nav')
    expect(document.querySelectorAll('body > div header, header[data-testid="simple-header"]').length).toBe(1)
    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('main')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-help'))
    const panel = await screen.findByTestId('help-panel')
    expect(panel.tagName).toBe('ASIDE')
    expect(screen.getByRole('complementary', { name: 'Help' })).toBe(panel)
    expect(a11yProblems()).toEqual([])
    // html[data-shell] scopes the simple token tweaks; the full app never has it.
    expect(document.documentElement.dataset.shell).toBe('simple')
  })

  it('the skip link comes first and every header / sidebar control is named', async () => {
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    await screen.findByTestId('simple-nav')
    const focusables = document.querySelectorAll<HTMLElement>('a[href], button')
    expect(focusables[0]!.getAttribute('data-testid')).toBe('skip-to-content')
    expect(a11yProblems()).toEqual([])
  })

  it(`under ${SIMPLE_NAV_COLLAPSE_BELOW} px the sidebar is icons only: each button is named by its label, shown beside it on focus`, async () => {
    windowWidth(1024)
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    const nav = await screen.findByTestId('simple-nav')
    expect(nav.getAttribute('data-collapsed')).toBe('true')
    const sell = screen.getByTestId('simple-nav-sell')
    expect(textOf(sell)).toBe('') // icon only
    expect(sell.getAttribute('aria-label')).toBe('Sell')
    expect(screen.getByRole('button', { name: 'Sell' })).toBe(sell)
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Support/ })).toBeTruthy()
    fireEvent.focus(sell)
    expect(textOf(screen.getByTestId('simple-nav-tip'))).toBe('Sell')
    expect(screen.getByTestId('simple-nav-tip').getAttribute('aria-hidden')).toBe('true') // the name is the aria-label: no double reading
    fireEvent.blur(sell)
    expect(screen.queryByTestId('simple-nav-tip')).toBeNull()
    expect(a11yProblems()).toEqual([])
  })

  it(`at ${SIMPLE_NAV_COLLAPSE_BELOW} px and wider the sidebar shows its labels`, async () => {
    windowWidth(1440)
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    const nav = await screen.findByTestId('simple-nav')
    expect(nav.getAttribute('data-collapsed')).toBeNull()
    expect(textOf(screen.getByTestId('simple-nav-sell'))).toBe('Sell')
  })

  it(`the panels overlay the screen under ${SIMPLE_DOCK_FROM} px and dock beside it from there`, async () => {
    windowWidth(1440)
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    await screen.findByTestId('simple-nav')
    fireEvent.click(screen.getByTestId('btn-help'))
    const panel = await screen.findByTestId('help-panel')
    expect(panel.hasAttribute('data-overlay')).toBe(true)
    expect(panel.className).toContain('fixed')
    cleanup()
    windowWidth(1920)
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    await screen.findByTestId('simple-nav')
    act(() => useHelpPanel.getState().openForScreen('getting-started'))
    const docked = await screen.findByTestId('help-panel')
    expect(docked.hasAttribute('data-overlay')).toBe(false)
    expect(docked.className).toContain('relative')
  })

  it('opening a panel moves the keyboard into it; closing gives it back', async () => {
    wrap(<Shell onOpenPalette={() => {}}><p>Home</p></Shell>)
    await screen.findByTestId('simple-nav')
    const btn = screen.getByTestId('btn-help')
    btn.focus()
    fireEvent.click(btn)
    const panel = await screen.findByTestId('help-panel')
    expect(document.activeElement).toBe(panel)
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('help-panel')).toBeNull())
    expect(document.activeElement).toBe(btn)
  })

  it('the full app is untouched: no dock provider (the panel docks, is not an Esc layer, has no tabindex)', () => {
    render(
      <DockedDrawer title="Assistant" onClose={() => {}} width={400} testId="plain">
        x
      </DockedDrawer>
    )
    const el = screen.getByTestId('plain')
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.hasAttribute('data-overlay')).toBe(false)
    expect(el.className).toBe('t-drawer-in relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-raised')
  })

  it('an overlay panel is still a named complementary region', () => {
    render(
      <DockModeContext.Provider value="overlay">
        <DockedDrawer title="Help" onClose={() => {}} width={400} testId="ov">
          x
        </DockedDrawer>
      </DockModeContext.Provider>
    )
    expect(screen.getByRole('complementary', { name: 'Help' })).toBe(screen.getByTestId('ov'))
    expect(a11yProblems()).toEqual([])
  })
})

describe('simple screens: names, labels, roles (WP 10.5)', () => {
  it.each(SIMPLE_SECTION_IDS.filter((s) => s !== 'home'))('the %s section page', async (section) => {
    wrap(<SimpleSection section={section} />)
    await waitFor(() => expect(document.querySelector('h1')).toBeTruthy())
    expect(a11yProblems()).toEqual([])
  })

  it('the setup wizard, step by step (radio cards in named groups; errors described)', async () => {
    wrap(<SetupWizard today="2026-10-14" onFinish={vi.fn(async () => {})} onSample={vi.fn()} onSampleFull={vi.fn()} onFullForm={vi.fn()} onImportBackup={vi.fn()} />)
    expect(a11yProblems()).toEqual([])
    fireEvent.change(screen.getByTestId('setup-name'), { target: { value: 'Ramesh Kirana' } })
    fireEvent.click(screen.getByTestId('setup-next'))
    expect(screen.getByTestId('setup-wizard').getAttribute('data-step')).toBe('type')
    // Next moved the keyboard to the new step's first question.
    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    fireEvent.click(screen.getByTestId('setup-next')) // nothing picked → the error, described
    const group = screen.getByRole('radiogroup')
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Pick the kind of business closest to yours.')
    expect(a11yProblems()).toEqual([])
    // Arrow keys move between the cards and pick the one they land on.
    const first = screen.getAllByRole('radio')[0]!
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const second = screen.getAllByRole('radio')[1]!
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('aria-checked')).toBe('true')
  })

  it('Make a bill: every field labelled, the preview line live in the Save bar', async () => {
    wrap(<MakeBill />)
    await waitFor(() => expect((screen.getByTestId('btn-sell-save') as HTMLButtonElement).disabled).toBe(false))
    expect(a11yProblems()).toEqual([])
    const bar = screen.getByTestId('save-bar')
    const preview = screen.getByTestId('sell-preview')
    expect(bar.contains(preview)).toBe(true)
    expect(preview.getAttribute('aria-live')).toBe('polite')
    expect(bar.contains(screen.getByTestId('btn-sell-save'))).toBe(true)
  })

  it('the help panel on its own', async () => {
    act(() => useHelpPanel.getState().openForScreen('getting-started'))
    wrap(<HelpPanel />)
    await screen.findByTestId('help-panel')
    expect(a11yProblems()).toEqual([])
  })

  it('the Save bar: total, a live preview, the buttons', () => {
    render(
      <SaveBar total="₹1,180.00" totalTestId="t" preview="Bill ₹1,180.00 to Ramesh." previewTestId="p" shortcuts="⌘↵ saves">
        <button type="button">Save</button>
      </SaveBar>
    )
    expect(textOf(screen.getByTestId('p'))).toBe('Bill ₹1,180.00 to Ramesh.')
    expect(screen.getByTestId('p').getAttribute('aria-live')).toBe('polite')
    // Money reads as shown — no hidden "rupees" duplicate next to it.
    expect(textOf(screen.getByTestId('t'))).toBe('₹1,180.00')
    expect(screen.getByTestId('save-bar').querySelectorAll('.sr-only').length).toBe(0)
  })
})

describe('the sweep itself', () => {
  it('catches what it is meant to', () => {
    render(
      <div>
        <button type="button" />
        <input />
        <div role="tab">x</div>
        <span aria-describedby="nope">y</span>
        <svg />
        <table>
          <tbody>
            <tr>
              <td>1</td>
            </tr>
          </tbody>
        </table>
      </div>
    )
    const p = a11yProblems()
    expect(p.some((x) => x.startsWith('no name: button'))).toBe(true)
    expect(p.some((x) => x.startsWith('no label: input'))).toBe(true)
    expect(p.some((x) => x.includes('outside [role="tablist"]'))).toBe(true)
    expect(p.some((x) => x.includes('missing #nope'))).toBe(true)
    expect(p.some((x) => x.startsWith('svg not hidden'))).toBe(true)
    expect(p.some((x) => x.startsWith('table without column headers'))).toBe(true)
  })
})
