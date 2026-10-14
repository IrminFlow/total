// WP 10.5 — the simple shell by keyboard:
//   - Esc closes the TOPMOST layer only: dialog → panel (Help / Ask Total / AI) → the form's own
//     "discard?" → the app's "back". An open picker list or a field that clears itself keeps its
//     Esc; the full app's panel is not a layer (its keys are exactly as before).
//   - shortcuts never fire while typing: ? (help), / (search), the tour's Enter;
//     / focuses the screen's search box, and only with no modifier and no dialog open;
//   - ⌘K reaches every simple flow (registry → palette rows);
//   - pickers: Enter never creates (8.4) — the shared TypeAhead's behaviour, and a lint that every
//     type-ahead under simple/** IS the shared component.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DockModeContext, DockedDrawer, isPanelOpen, routePanelEscape } from '../components/kit'
import { Modal, isAnyModalOpen } from '../components/ui'
import { TypeAhead, type PickerOption } from '../components/pickers'
import { handleRadioArrows, handleSlashKey, screenSearchBox, syncRovingRadios, useRovingRadios } from '../lib/simpleKeys'
import { handleHelpKey } from '../help/keys'
import { useHelpPanel } from '../help/store'
import { useNav, useSession } from '../state/stores'
import { SIMPLE_ENTRIES, screenDef, simplePaletteRows } from '../lib/screens'
import { DEFAULT_FEATURES } from '@shared/features'

/** A form like MakeBill's: Esc (not in a box) asks before discarding — window, capture phase. */
function Form({ onEscape }: { onEscape: () => void }): React.JSX.Element {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || isAnyModalOpen()) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      onEscape()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onEscape])
  return (
    <div>
      <button type="button" data-testid="form-button">
        Something on the form
      </button>
      <input aria-label="Name" data-testid="form-input" data-consumes-escape="" />
    </div>
  )
}

function Stack({ dock, onFormEscape, initialModal = false }: { dock: 'dock' | 'overlay' | null; onFormEscape: () => void; initialModal?: boolean }): React.JSX.Element {
  const [panel, setPanel] = useState(true)
  const [modal, setModal] = useState(initialModal)
  return (
    <>
      <Form onEscape={onFormEscape} />
      <DockModeContext.Provider value={dock}>
        {panel && (
          <DockedDrawer title="Help" onClose={() => setPanel(false)} width={400} testId="panel">
            <button type="button" data-testid="panel-button">
              In the panel
            </button>
          </DockedDrawer>
        )}
      </DockModeContext.Provider>
      {modal && (
        <Modal title="Are you sure?" onClose={() => setModal(false)}>
          <button type="button" data-testid="modal-button">
            OK
          </button>
        </Modal>
      )}
    </>
  )
}

const esc = (el: Element | Window = document.body): void => {
  fireEvent.keyDown(el, { key: 'Escape' })
}

beforeEach(() => {
  localStorage.clear()
  window.total = { platform: 'test', invoke: vi.fn(async () => ({ ok: true, data: [] })) } as unknown as typeof window.total
  act(() => {
    useSession.setState({ slug: 'kb', locked: false, user: null, ui: { mode: 'simple' }, from: '2026-04-01', to: '2027-03-31' } as never)
    useNav.setState({ stack: [{ name: 'gateway' }] })
    useHelpPanel.setState({ open: false, article: null, follow: false, query: '' })
  })
})
afterEach(() => cleanup())

describe('Esc closes the topmost layer only (simple shell)', () => {
  it('dialog → panel → form, one Esc each', async () => {
    const formEsc = vi.fn()
    render(<Stack dock="overlay" onFormEscape={formEsc} initialModal />)
    expect(isPanelOpen()).toBe(true)
    esc(screen.getByTestId('modal-button'))
    await waitFor(() => expect(screen.queryByText('Are you sure?')).toBeNull())
    expect(screen.getByTestId('panel')).toBeTruthy()
    expect(formEsc).not.toHaveBeenCalled()
    // The keyboard is on the form, but the panel is the top layer.
    screen.getByTestId('form-button').focus()
    esc(screen.getByTestId('form-button'))
    await waitFor(() => expect(screen.queryByTestId('panel')).toBeNull())
    expect(formEsc).not.toHaveBeenCalled()
    expect(isPanelOpen()).toBe(false)
    esc(screen.getByTestId('form-button'))
    expect(formEsc).toHaveBeenCalledTimes(1)
  })

  it('Esc inside the panel closes it and never reaches the form', async () => {
    const formEsc = vi.fn()
    render(<Stack dock="dock" onFormEscape={formEsc} />)
    esc(screen.getByTestId('panel-button'))
    await waitFor(() => expect(screen.queryByTestId('panel')).toBeNull())
    expect(formEsc).not.toHaveBeenCalled()
  })

  it('a field that clears itself, or an open picker list, keeps its Esc', () => {
    const formEsc = vi.fn()
    render(<Stack dock="overlay" onFormEscape={formEsc} />)
    const box = screen.getByTestId('form-input')
    box.focus()
    esc(box)
    expect(screen.getByTestId('panel')).toBeTruthy()
    const combo = document.createElement('input')
    combo.setAttribute('role', 'combobox')
    combo.setAttribute('aria-expanded', 'true')
    document.body.appendChild(combo)
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(e, 'target', { value: combo })
    expect(routePanelEscape(e)).toBe(false)
    combo.remove()
    expect(screen.getByTestId('panel')).toBeTruthy()
  })

  it('review: the ⌘K palette over an open panel takes Esc first (one Esc closes the palette, not the panel)', async () => {
    const formEsc = vi.fn()
    render(<Stack dock="overlay" onFormEscape={formEsc} />)
    // The palette's overlay (CommandPalette.tsx) — not a dialog layer, so it says it owns Esc.
    const overlay = document.createElement('div')
    overlay.setAttribute('data-esc-layer', '')
    const box = document.createElement('input')
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(e, 'target', { value: box })
    expect(routePanelEscape(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    overlay.remove()
    expect(screen.getByTestId('panel')).toBeTruthy()
    esc(screen.getByTestId('form-button'))
    await waitFor(() => expect(screen.queryByTestId('panel')).toBeNull())
  })

  it('review: a window crossing 1600 px (overlay ↔ dock) keeps the keyboard in the panel and its place in the Esc stack', async () => {
    function Two({ dock }: { dock: 'dock' | 'overlay' }): React.JSX.Element {
      const [help, setHelp] = useState(true)
      const [ask, setAsk] = useState(true)
      return (
        <DockModeContext.Provider value={dock}>
          {help && (
            <DockedDrawer title="Help" onClose={() => setHelp(false)} width={400} testId="help">
              <p>help</p>
            </DockedDrawer>
          )}
          {ask && (
            <DockedDrawer title="Ask" onClose={() => setAsk(false)} width={400} testId="ask">
              <textarea aria-label="Question" data-testid="ask-box" />
            </DockedDrawer>
          )}
        </DockModeContext.Provider>
      )
    }
    const { rerender } = render(<Two dock="overlay" />)
    screen.getByTestId('ask-box').focus()
    rerender(<Two dock="dock" />)
    expect(document.activeElement).toBe(screen.getByTestId('ask-box'))
    rerender(<Two dock="overlay" />)
    expect(document.activeElement).toBe(screen.getByTestId('ask-box'))
    // Ask Total opened last: it is still the top layer after the resizes.
    esc(document.body)
    await waitFor(() => expect(screen.queryByTestId('ask')).toBeNull())
    expect(screen.getByTestId('help')).toBeTruthy()
  })

  it('the full app (no dock provider): the panel is not a layer — Esc on the screen reaches the form as before', () => {
    const formEsc = vi.fn()
    render(<Stack dock={null} onFormEscape={formEsc} />)
    expect(isPanelOpen()).toBe(false)
    esc(screen.getByTestId('form-button'))
    expect(formEsc).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('panel')).toBeTruthy()
  })
})

describe('shortcuts never fire while typing', () => {
  function Screen({ children }: { children: ReactNode }): React.JSX.Element {
    return <main id="main">{children}</main>
  }

  it('/ focuses the screen’s search box — not from a box, not with a modifier, not under a dialog', () => {
    render(
      <Screen>
        <input aria-label="Other box" data-testid="other" />
        <form role="search" aria-label="Ask Total">
          <input aria-label="Ask" data-testid="ask" />
        </form>
      </Screen>
    )
    expect(screenSearchBox()).toBe(screen.getByTestId('ask'))
    const key = (target: Element, init: KeyboardEventInit = {}): boolean => {
      const e = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true, ...init })
      Object.defineProperty(e, 'target', { value: target })
      return handleSlashKey(e)
    }
    expect(key(screen.getByTestId('other'))).toBe(false) // typing a "/" in a box
    expect(key(document.body, { metaKey: true })).toBe(false) // ⌘/ is help, not search
    expect(key(document.body)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('ask'))
  })

  it('/ does nothing on a screen without a search box, or while a dialog is open', () => {
    render(
      <Screen>
        <p>Nothing to search</p>
      </Screen>
    )
    const e = new KeyboardEvent('keydown', { key: '/', cancelable: true })
    expect(handleSlashKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    cleanup()
    render(
      <>
        <Screen>
          <input type="search" aria-label="Filter rows" data-testid="filter" />
        </Screen>
        <Modal title="A dialog" onClose={() => {}}>
          <p>x</p>
        </Modal>
      </>
    )
    expect(handleSlashKey(new KeyboardEvent('keydown', { key: '/' }))).toBe(false)
    expect(document.activeElement).not.toBe(screen.getByTestId('filter'))
  })

  it('arrow keys move between a question’s choices and pick the one they land on (every simple radio group)', () => {
    const picked = vi.fn()
    function Group(): React.JSX.Element {
      const [v, setV] = useState('cash')
      useEffect(() => {
        const on = (e: KeyboardEvent): void => void handleRadioArrows(e)
        window.addEventListener('keydown', on, true)
        return () => window.removeEventListener('keydown', on, true)
      }, [])
      return (
        <div role="radiogroup" aria-label="Paid how?">
          {['cash', 'upi', 'card'].map((x) => (
            <button key={x} type="button" role="radio" aria-checked={v === x} data-testid={`r-${x}`} onClick={() => (setV(x), picked(x))}>
              {x}
            </button>
          ))}
        </div>
      )
    }
    render(<Group />)
    screen.getByTestId('r-cash').focus()
    fireEvent.keyDown(screen.getByTestId('r-cash'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('r-upi'))
    expect(screen.getByTestId('r-upi').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(screen.getByTestId('r-upi'), { key: 'ArrowLeft' })
    fireEvent.keyDown(screen.getByTestId('r-cash'), { key: 'ArrowUp' }) // wraps to the last
    expect(document.activeElement).toBe(screen.getByTestId('r-card'))
    expect(picked.mock.calls.map((c) => c[0])).toEqual(['upi', 'cash', 'card'])
  })

  it('review: a question is ONE Tab stop — the picked choice, else the first (roving tabindex)', async () => {
    function Groups(): React.JSX.Element {
      useRovingRadios(true)
      const [v, setV] = useState<string | null>(null)
      return (
        <>
          <div role="radiogroup" aria-label="Paid how?">
            {['cash', 'upi', 'card'].map((x) => (
              <button key={x} type="button" role="radio" aria-checked={v === x} data-testid={`g-${x}`} onClick={() => setV(x)}>
                {x}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Who?">
            <button type="button" role="radio" aria-checked={false} disabled data-testid="w-off">off</button>
            <button type="button" role="radio" aria-checked={false} data-testid="w-on">on</button>
          </div>
        </>
      )
    }
    render(<Groups />)
    const tab = (id: string): number => screen.getByTestId(id).tabIndex
    expect([tab('g-cash'), tab('g-upi'), tab('g-card')]).toEqual([0, -1, -1])
    expect([tab('w-off'), tab('w-on')]).toEqual([-1, 0]) // a disabled choice is never the stop
    fireEvent.click(screen.getByTestId('g-card'))
    await waitFor(() => expect([tab('g-cash'), tab('g-upi'), tab('g-card')]).toEqual([-1, -1, 0]))
    // The sync itself (no observer): a static group.
    const g = document.createElement('div')
    g.setAttribute('role', 'radiogroup')
    g.innerHTML = '<button role="radio" aria-checked="false"></button><button role="radio" aria-checked="true"></button>'
    syncRovingRadios(g.parentNode ?? (document.createDocumentFragment().appendChild(g), g.parentNode!))
    expect([...g.querySelectorAll('button')].map((b) => b.tabIndex)).toEqual([-1, 0])
  })

  it('? opens help only when no box has the keyboard', () => {
    render(<input aria-label="Name" data-testid="name" />)
    const inBox = new KeyboardEvent('keydown', { key: '?', cancelable: true })
    Object.defineProperty(inBox, 'target', { value: screen.getByTestId('name') })
    expect(handleHelpKey(inBox)).toBe(false)
    expect(useHelpPanel.getState().open).toBe(false)
    const free = new KeyboardEvent('keydown', { key: '?', cancelable: true })
    Object.defineProperty(free, 'target', { value: document.body })
    expect(handleHelpKey(free)).toBe(true)
    expect(useHelpPanel.getState().open).toBe(true)
  })
})

describe('⌘K reaches every simple flow', () => {
  it('every simple-native entry of the registry is a palette row (all features on, registered, AI ready)', () => {
    const allOn = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, true])) as unknown as typeof DEFAULT_FEATURES
    const rows = simplePaletteRows({ features: { ...allOn, manufacturing: true }, regular: true, aiReady: true })
    const labels = new Set(rows.map((r) => r.label))
    const missing = SIMPLE_ENTRIES.filter((e) => screenDef(e.screenName)?.modes.includes('simple') && !labels.has(e.label)).map((e) => e.id)
    expect(missing).toEqual([])
    for (const s of ['sell', 'buy', 'money', 'people', 'reports', 'taxes', 'settings']) expect(rows.some((r) => r.id === `section-${s}`)).toBe(true)
  })
})

describe('pickers: Enter never creates', () => {
  const OPTIONS: PickerOption[] = [
    { id: 1, label: 'Sales' },
    { id: 2, label: 'Salary' }
  ]
  it('Enter picks the highlighted match; with no match it does nothing; only ↓ past the matches + Enter creates', () => {
    const onPick = vi.fn()
    const onCreate = vi.fn()
    render(<TypeAhead options={OPTIONS} value={null} onPick={onPick} onCreate={onCreate} placeholder="Account" testId="pick" />)
    const input = screen.getByTestId('pick')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sal' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(1)
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Rent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('Rent')
  })

  // Every type-ahead under simple/** is the shared TypeAhead (components/pickers.tsx) — the one
  // that implements the rule above. A hand-made combobox / listbox there would not.
  const root = resolve(__dirname, '../simple')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f)) files.push(p)
    }
  }
  walk(root)
  /** Not type-aheads, each for a stated reason. */
  const ALLOWED: Record<string, RegExp[]> = {
    // A grid of category TILES (buttons, role="option" in a listbox) — nothing is typed; its
    // "Search all accounts" mode is the shared LedgerPicker.
    'CategoryPicker.tsx': [/role="listbox"/, /role="option"/],
    // Name suggestions for a NEW party's name box (a native <datalist>); nothing is created
    // until the whole step is saved.
    'OpeningsSteps.tsx': [/<datalist/]
  }
  it('no hand-made combobox, listbox or datalist under simple/** (outside the two stated exceptions)', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const allowed = ALLOWED[relative(root, f)] ?? []
      for (const re of [/role="combobox"/, /role="listbox"/, /role="option"/, /<datalist/, /aria-autocomplete/]) {
        if (re.test(src) && !allowed.some((a) => a.source === re.source)) bad.push(`${relative(root, f)}: ${re.source}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('every picker a simple screen imports comes from the shared pickers', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        const names = m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, ''))
        const from = m[2]!
        if (names.some((n) => /^(TypeAhead|LedgerPicker|StockItemPicker|ItemPicker|PartyPicker)$/.test(n)) && !/components\/(pickers|stockPickers)$/.test(from)) bad.push(`${relative(root, f)} imports a picker from ${from}`)
      }
    }
    expect(bad).toEqual([])
    expect(files.some((f) => /import\s*\{[^}]*\bTypeAhead\b[^}]*\}\s*from\s*'[^']*components\/pickers'/.test(readFileSync(f, 'utf8')))).toBe(true)
  })
})
