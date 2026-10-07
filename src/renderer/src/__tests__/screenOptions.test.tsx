// Screen options (the PageHeader Options drawer): defaults saved per company + screen in
// localStorage, defensive parsing, reset, and the drawer's table section driving the screen's
// DataTable (column chooser, export).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OptionToggle, OptionsTable, parseScreenOptions, screenOptionsKey, useScreenOptions } from '../components/ScreenOptions'
import { Page, PageHeader } from '../components/ui'
import { DataTable, defineColumns, tableActions } from '../components/table'
import { useNav, useSession } from '../state/stores'

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useSession.setState({ slug: 'alpha-co' })
    useNav.setState({ stack: [{ name: 'trial-balance' }] })
  })
})
afterEach(() => cleanup())

interface Row {
  id: number
  name: string
}
const COLUMNS = defineColumns<Row>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'id', header: 'Id', kind: 'number', value: (r) => r.id }
])

function Screen(): React.JSX.Element {
  const opts = useScreenOptions('trial-balance', { hideZero: false, mode: 'detail' as 'detail' | 'monthly' }, { mode: ['detail', 'monthly'] })
  return (
    <Page>
      <PageHeader
        title="Trial balance"
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionToggle label="Hide zero" checked={opts.options.hideZero} onChange={(v) => opts.set('hideZero', v)} testId="opt-hide-zero" />
              <OptionsTable area="tb" />
            </>
          )
        }}
      />
      <span data-testid="state">{JSON.stringify(opts.options)}</span>
      <DataTable testId="tb" columns={COLUMNS} rows={[{ id: 1, name: 'A' }]} exportOptions={{ title: 'TB', periodLabel: '' }} />
    </Page>
  )
}

const state = (): Record<string, unknown> => JSON.parse(screen.getByTestId('state').textContent!)

describe('parseScreenOptions', () => {
  const defaults = { a: false, mode: 'x' as 'x' | 'y', n: 3 }
  it('falls back on missing, corrupt or wrongly-typed values', () => {
    expect(parseScreenOptions(null, defaults)).toEqual(defaults)
    expect(parseScreenOptions('{oops', defaults)).toEqual(defaults)
    expect(parseScreenOptions('[1]', defaults)).toEqual(defaults)
    expect(parseScreenOptions(JSON.stringify({ a: 'yes', n: 5, extra: 1 }), defaults)).toEqual({ a: false, mode: 'x', n: 5 })
  })
  it('rejects values outside an allowed list', () => {
    expect(parseScreenOptions(JSON.stringify({ mode: 'z' }), defaults, { mode: ['x', 'y'] }).mode).toBe('x')
    expect(parseScreenOptions(JSON.stringify({ mode: 'y' }), defaults, { mode: ['x', 'y'] }).mode).toBe('y')
  })
})

describe('Options drawer persistence', () => {
  it('a toggled option is saved per company + screen and restored on remount', () => {
    const first = render(<Screen />)
    fireEvent.click(screen.getByTestId('btn-trial-balance-options'))
    fireEvent.click(screen.getByTestId('opt-hide-zero'))
    expect(state().hideZero).toBe(true)
    expect(JSON.parse(localStorage.getItem(screenOptionsKey('alpha-co', 'trial-balance'))!)).toMatchObject({ hideZero: true })
    first.unmount()
    render(<Screen />)
    expect(state().hideZero).toBe(true)
  })

  it('another company keeps its own options', () => {
    localStorage.setItem(screenOptionsKey('alpha-co', 'trial-balance'), JSON.stringify({ hideZero: true }))
    render(<Screen />)
    expect(state().hideZero).toBe(true)
    act(() => useSession.setState({ slug: 'beta-co' }))
    expect(state().hideZero).toBe(false)
  })

  it('Reset to defaults restores the declared defaults and clears storage', () => {
    localStorage.setItem(screenOptionsKey('alpha-co', 'trial-balance'), JSON.stringify({ hideZero: true, mode: 'monthly' }))
    render(<Screen />)
    expect(state()).toEqual({ hideZero: true, mode: 'monthly' })
    fireEvent.click(screen.getByTestId('btn-trial-balance-options'))
    fireEvent.click(screen.getByTestId('options-trial-balance-reset'))
    expect(state()).toEqual({ hideZero: false, mode: 'detail' })
    expect(localStorage.getItem(screenOptionsKey('alpha-co', 'trial-balance'))).toBeNull()
  })

  it("the table section opens the table's column chooser (closing the drawer) and exports", async () => {
    vi.useFakeTimers()
    try {
      render(<Screen />)
      expect(tableActions('tb')).toBeTruthy()
      fireEvent.click(screen.getByTestId('btn-trial-balance-options'))
      fireEvent.click(screen.getByTestId('options-tb-columns'))
      expect(screen.queryByTestId('options-trial-balance')).toBeNull()
      act(() => {
        vi.runAllTimers()
      })
      expect(screen.getByTestId('tb-table-columns-popover')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
