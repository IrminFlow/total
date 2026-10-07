// The design-system kit (components/kit): one block per component — the behaviour screens rely
// on (variants, a11y wiring, keyboard, dialog-layer stacking).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import {
  Badge,
  Banner,
  Button,
  Checklist,
  Chip,
  Drawer,
  DrawerSection,
  EmptyState,
  Field,
  IconButton,
  Kbd,
  MenuButton,
  Page,
  PageHeader,
  SkeletonRows,
  SkeletonTiles,
  Spinner,
  StatTile,
  TabBar,
  TextInput,
  Toolbar,
  ToolbarSpacer,
  isAnyModalOpen
} from '../components/kit'
import { Modal, Select } from '../components/ui'
import { useNav } from '../state/stores'

afterEach(() => cleanup())

const key = (k: string, target: EventTarget = window): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

describe('Button', () => {
  it('renders the four variants, `default` as secondary', () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button>S</Button>
        <Button variant="default">D</Button>
        <Button variant="ghost">G</Button>
        <Button variant="danger">X</Button>
      </>
    )
    expect(screen.getByText('P').className).toMatch(/bg-amberbar/)
    expect(screen.getByText('S').className).toBe(screen.getByText('D').className)
    expect(screen.getByText('X').className).toMatch(/text-danger/)
    expect(screen.getByText('G').getAttribute('type')).toBe('button')
  })

  it('loading disables, marks aria-busy and shows a decorative spinner', () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    )
    const b = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(b.querySelector('[aria-hidden="true"].animate-spin')).toBeTruthy()
    fireEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('sm size, icon slot, disabledTitle wrapper', () => {
    render(
      <Button size="sm" icon="⚙" disabled disabledTitle="Owners only">
        Options
      </Button>
    )
    const b = screen.getByRole('button', { name: /Options/ })
    expect(b.className).toMatch(/min-h-control-sm/)
    expect(b.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚙')
    expect(b.parentElement?.getAttribute('title')).toBe('Owners only')
  })

  it('IconButton is named by its label', () => {
    render(<IconButton label="Close">✕</IconButton>)
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})

describe('Field + inputs', () => {
  it('wires help text through aria-describedby', () => {
    render(
      <Field label="GSTIN" hint="15 characters">
        <TextInput data-testid="i" />
      </Field>
    )
    const input = screen.getByTestId('i')
    const id = input.getAttribute('aria-describedby')!
    expect(document.getElementById(id)?.textContent).toBe('15 characters')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByLabelText('GSTIN')).toBe(input)
  })

  it('an error replaces the hint, announces, and marks the control invalid', () => {
    render(
      <Field label="Rate" hint="percent" error="Too high" required>
        <Select data-testid="s">
          <option>1</option>
        </Select>
      </Field>
    )
    const s = screen.getByTestId('s')
    expect(s.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(s.getAttribute('aria-describedby')!)?.textContent).toBe('Too high')
    expect(screen.getByRole('alert').textContent).toBe('Too high')
    expect(screen.queryByText('percent')).toBeNull()
  })

  it('invalid prop works outside a Field; inputs follow the density control height', () => {
    render(<TextInput invalid aria-label="x" />)
    const i = screen.getByLabelText('x')
    expect(i.getAttribute('aria-invalid')).toBe('true')
    expect(i.className).toMatch(/min-h-control/)
  })
})

describe('TabBar', () => {
  function Harness({ onSelect }: { onSelect?: (id: string) => void }): React.JSX.Element {
    const [active, setActive] = useState<'a' | 'b' | 'c'>('a')
    return (
      <TabBar
        screen="demo"
        active={active}
        tabs={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta', count: 3 },
          { id: 'c', label: 'Gamma' }
        ]}
        onSelect={(id) => {
          setActive(id)
          onSelect?.(id)
        }}
      />
    )
  }

  it('ARIA tabs with testids and a roving tabindex', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('demo sections')
    const a = screen.getByTestId('tab-demo-a')
    expect(a.getAttribute('role')).toBe('tab')
    expect(a.getAttribute('aria-selected')).toBe('true')
    expect(a.tabIndex).toBe(0)
    expect(screen.getByTestId('tab-demo-b').tabIndex).toBe(-1)
    expect(screen.getByTestId('tab-demo-b').textContent).toBe('Beta3')
  })

  it('arrows move focus without activating; click/Enter activates', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const a = screen.getByTestId('tab-demo-a')
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('tab-demo-b'))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId('tab-demo-c'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(a) // wraps
    fireEvent.click(screen.getByTestId('tab-demo-c'))
    expect(onSelect).toHaveBeenCalledWith('c')
    expect(screen.getByTestId('tab-demo-c').getAttribute('aria-selected')).toBe('true')
  })
})

describe('Drawer', () => {
  it('is a labelled modal dialog layer; Esc and the close button close it', () => {
    const onClose = vi.fn()
    render(
      <Drawer title="Options" subtitle="Saved per screen" onClose={onClose} testId="d">
        <DrawerSection title="Display">
          <button>Inside</button>
        </DrawerSection>
      </Drawer>
    )
    const d = screen.getByRole('dialog', { name: 'Options' })
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(isAnyModalOpen()).toBe(true)
    expect(d.contains(document.activeElement)).toBe(true) // focus moved in
    expect(screen.getByRole('region', { name: 'Display' })).toBeTruthy()
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('drawer-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('stacks with Modal: Esc closes the modal on top first, then the drawer', () => {
    function Stack(): React.JSX.Element {
      const [drawer, setDrawer] = useState(true)
      const [modal, setModal] = useState(true)
      return (
        <>
          {drawer && (
            <Drawer title="Panel" onClose={() => setDrawer(false)}>
              <p>body</p>
            </Drawer>
          )}
          {modal && (
            <Modal title="Confirm" onClose={() => setModal(false)}>
              <p>sure?</p>
            </Modal>
          )}
        </>
      )
    }
    render(<Stack />)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    key('Escape')
    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeTruthy()
    key('Escape')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    expect(isAnyModalOpen()).toBe(false)
  })

  it('restores focus to the opener on close', () => {
    function Opener(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && (
            <Drawer title="D" onClose={() => setOpen(false)}>
              <button>x</button>
            </Drawer>
          )}
        </>
      )
    }
    render(<Opener />)
    const opener = screen.getByText('open')
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).not.toBe(opener)
    key('Escape')
    expect(document.activeElement).toBe(opener)
  })
})

describe('PageHeader', () => {
  it('title is the h1; period, tabs and actions render; no options button without options', () => {
    useNav.setState({ stack: [{ name: 'daybook' }] })
    render(
      <Page width="wide">
        <PageHeader title="Day book" period="01-Apr-26 → 31-Mar-27" actions={<Button variant="primary">New</Button>} />
      </Page>
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Day book')
    expect(screen.getByTestId('page-period').textContent).toMatch(/31-Mar-27/)
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy()
    expect(screen.queryByTestId('btn-daybook-options')).toBeNull()
    expect(screen.getByTestId('page-header').parentElement?.className).toMatch(/max-w-6xl/)
  })

  it('Options opens the drawer (button or F12); Reset and Done in the footer', () => {
    useNav.setState({ stack: [{ name: 'trial-balance' }] })
    const onReset = vi.fn()
    render(<PageHeader title="Trial balance" options={{ content: <p>zero rows</p>, onReset }} />)
    fireEvent.click(screen.getByTestId('btn-trial-balance-options'))
    expect(screen.getByTestId('options-trial-balance').textContent).toMatch(/zero rows/)
    fireEvent.click(screen.getByTestId('options-trial-balance-reset'))
    expect(onReset).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('options-trial-balance-done'))
    expect(screen.queryByTestId('options-trial-balance')).toBeNull()
    key('F12')
    expect(screen.getByTestId('options-trial-balance')).toBeTruthy()
  })
})

describe('Badge, Chip, StatTile, Banner, Toolbar, EmptyState, skeletons, Kbd', () => {
  it('Badge carries its tone', () => {
    render(<Badge tone="warning">Optional</Badge>)
    expect(screen.getByText('Optional').dataset.tone).toBe('warning')
    expect(screen.getByText('Optional').className).toMatch(/text-warning/)
  })

  it('Chip: removable and toggle forms', () => {
    const onRemove = vi.fn()
    const onClick = vi.fn()
    render(
      <>
        <Chip onRemove={onRemove} removeLabel="Remove Apr 2026">
          Apr 2026
        </Chip>
        <Chip onClick={onClick} selected>
          Sales
        </Chip>
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Apr 2026' }))
    expect(onRemove).toHaveBeenCalled()
    const toggle = screen.getByRole('button', { name: 'Sales' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onClick).toHaveBeenCalled()
  })

  it('StatTile: label, value, delta, sparkline slot; clickable tile is a button', () => {
    const onClick = vi.fn()
    render(<StatTile label="Receivables" value="1,000.00" delta="+5%" deltaTone="up" sparkline={<svg data-testid="spark" />} onClick={onClick} testId="t" />)
    const tile = screen.getByTestId('t')
    expect(tile.tagName).toBe('BUTTON')
    expect(tile.textContent).toMatch(/Receivables1,000.00\+5%/)
    expect(screen.getByText('+5%').className).toMatch(/text-success/)
    expect(screen.getByTestId('spark')).toBeTruthy()
    fireEvent.click(tile)
    expect(onClick).toHaveBeenCalled()
  })

  it('Banner: danger is an alert, info a status; action and dismiss', () => {
    const onDismiss = vi.fn()
    render(
      <>
        <Banner tone="danger" title="Books don't balance" action={<Button>Fix</Button>} onDismiss={onDismiss}>
          Check opening balances
        </Banner>
        <Banner tone="info">FYI</Banner>
      </>
    )
    expect(screen.getByRole('alert').textContent).toMatch(/Books don't balance.*Check opening balances/)
    expect(screen.getByRole('status').textContent).toBe('FYI')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('Toolbar is a labelled toolbar', () => {
    render(
      <Toolbar label="Filters">
        <button>a</button>
        <ToolbarSpacer />
        <button>b</button>
      </Toolbar>
    )
    expect(screen.getByRole('toolbar', { name: 'Filters' }).querySelectorAll('button')).toHaveLength(2)
  })

  it('EmptyState, skeletons, Spinner, Kbd', () => {
    render(
      <>
        <EmptyState title="Nothing yet" hint="Press V" action={<Button>Add</Button>} compact testId="e" />
        <SkeletonRows rows={3} />
        <SkeletonTiles count={2} />
        <Spinner />
        <Kbd>⌘K</Kbd>
      </>
    )
    expect(screen.getByTestId('e').textContent).toMatch(/Nothing yet.*Press V.*Add/)
    expect(screen.getByTestId('skeleton-rows').children).toHaveLength(3)
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy()
    expect(screen.getByText('⌘K').tagName).toBe('KBD')
  })
})

describe('MenuButton (kit Popover)', () => {
  it('opens a role=menu; arrows move focus; picking closes and runs the item', () => {
    const del = vi.fn()
    render(
      <MenuButton
        label="More"
        testId="more"
        items={[
          { label: 'Duplicate', onSelect: vi.fn() },
          { label: 'Delete', onSelect: del, danger: true, testId: 'more-delete' }
        ]}
      />
    )
    fireEvent.click(screen.getByTestId('more'))
    const menu = screen.getByRole('menu')
    expect(document.activeElement?.textContent).toBe('Duplicate')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Delete')
    fireEvent.click(screen.getByTestId('more-delete'))
    expect(del).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Checklist', () => {
  it('shows progress, ticks done steps and offers an action on the rest', () => {
    const onOpen = vi.fn()
    render(
      <Checklist
        items={[
          { id: 'company', label: 'Company details', done: true },
          { id: 'voucher', label: 'First voucher', hint: 'A sale', done: false }
        ]}
        onOpen={onOpen}
      />
    )
    expect(screen.getByTestId('onboarding-checklist-progress').textContent).toBe('1 of 2 done')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(screen.getByTestId('onboarding-checklist-company').dataset.done).toBe('true')
    expect(screen.queryByTestId('onboarding-checklist-company-open')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open: First voucher' }))
    expect(onOpen).toHaveBeenCalledWith('voucher')
  })

  it('hideDone collapses finished steps', () => {
    render(<Checklist hideDone items={[{ id: 'a', label: 'A', done: true }, { id: 'b', label: 'B', done: false }]} />)
    expect(screen.queryByTestId('onboarding-checklist-a')).toBeNull()
    expect(screen.getByTestId('onboarding-checklist-b')).toBeTruthy()
  })
})
