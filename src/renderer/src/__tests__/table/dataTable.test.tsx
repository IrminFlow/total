// DataTable (components/table) — virtualisation, keyboard navigation, sorting, filtering,
// column hide, saved views + persistence, legacy useReportConfig migration.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { DataTable, defineColumns, tableViewStorageKey, useTableView } from '../../components/table'
import { Modal } from '../../components/ui'
import { useSession } from '../../state/stores'

interface Row {
  id: number
  name: string
  date: string
  amount: number
  kind: 'sales' | 'purchase'
}

const COLUMNS = defineColumns<Row>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date },
  { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: [{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }] },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum' }
])

const SMALL: Row[] = [
  { id: 1, name: 'Inv 10', date: '2026-04-03', amount: 150000, kind: 'sales' },
  { id: 2, name: 'Inv 9', date: '2026-04-01', amount: 2500, kind: 'purchase' },
  { id: 3, name: 'Inv 2', date: '2026-04-02', amount: 99, kind: 'sales' }
]

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Row ${i}`,
    date: '2026-04-01',
    amount: i * 100,
    kind: i % 2 ? 'purchase' : 'sales'
  }))
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

const bodyRows = (area = 'table'): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const names = (area = 'table'): string[] => bodyRows(area).map((tr) => tr.querySelector('td')!.textContent ?? '')
const activeRow = (): HTMLElement | null => document.querySelector('tr.kbar-row[data-active="true"]')

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useSession.setState({ slug: 'alpha-co' })
  })
})
afterEach(() => cleanup())

describe('DataTable virtualisation', () => {
  it('renders 50,000 rows with only a bounded number of <tr> in the DOM', () => {
    const rows = makeRows(50_000)
    const t0 = performance.now()
    render(<DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id} />)
    const elapsed = performance.now() - t0
    const trs = screen.getByTestId('rows-table').querySelectorAll('tr')
    expect(trs.length).toBeLessThan(80)
    expect(bodyRows().length).toBeGreaterThan(10)
    // The full size is still announced and the spacer reserves the rest of the scroll height.
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('50001')
    const spacer = screen.getByTestId('rows-table').querySelector<HTMLElement>('tr.dt-spacer')!
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(1_000_000)
    expect(elapsed).toBeLessThan(3000)
    // Totals cover every row, not just the rendered window: Σ i*100 for i < 50k.
    expect(screen.getByTestId('table-table-totals').textContent).toContain('1,24,99,75,000.00')
  })

  it('End / Home / PageDown move the active row and render it even outside the window', () => {
    const rows = makeRows(50_000)
    const onActivate = vi.fn()
    render(<DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id} onRowActivate={onActivate} />)
    expect(activeRow()?.textContent).toContain('Row 0')

    press('End')
    expect(activeRow()?.querySelector('td')?.textContent).toBe('Row 49999')
    expect(activeRow()?.getAttribute('aria-rowindex')).toBe('50001')
    press('Enter')
    expect(onActivate).toHaveBeenCalledWith(rows[49_999])

    press('Home')
    expect(activeRow()?.querySelector('td')?.textContent).toBe('Row 0')

    press('PageDown')
    const afterPage = Number(activeRow()?.querySelector('td')?.textContent?.replace('Row ', ''))
    expect(afterPage).toBeGreaterThan(5)
    press('ArrowDown')
    expect(activeRow()?.querySelector('td')?.textContent).toBe(`Row ${afterPage + 1}`)
    press('PageUp')
    press('ArrowUp')
    expect(activeRow()?.querySelector('td')?.textContent).toBe('Row 0')
    expect(screen.getByTestId('rows-table').querySelectorAll('tr').length).toBeLessThan(80)
  })

  it('small lists are not windowed', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    expect(screen.getByRole('table').hasAttribute('data-virtual')).toBe(false)
    expect(bodyRows()).toHaveLength(3)
  })
})

describe('DataTable keyboard + activation', () => {
  it('Enter and click activate; non-activatable rows do nothing', () => {
    const onActivate = vi.fn()
    render(<DataTable columns={COLUMNS} rows={SMALL} onRowActivate={onActivate} isRowActivatable={(r) => r.id !== 2} />)
    press('ArrowDown')
    press('Enter') // row 2 is not activatable
    expect(onActivate).not.toHaveBeenCalled()
    press('ArrowDown')
    press('Enter')
    expect(onActivate).toHaveBeenLastCalledWith(SMALL[2])
    fireEvent.click(bodyRows()[0]!)
    expect(onActivate).toHaveBeenLastCalledWith(SMALL[0])
  })

  it('dblclick mode ignores single clicks', () => {
    const onActivate = vi.fn()
    render(<DataTable columns={COLUMNS} rows={SMALL} onRowActivate={onActivate} activateOn="dblclick" />)
    fireEvent.click(bodyRows()[1]!)
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.doubleClick(bodyRows()[1]!)
    expect(onActivate).toHaveBeenCalledWith(SMALL[1])
  })

  it('is suspended while a modal is open and only the topmost table responds', () => {
    const { rerender } = render(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="under" />
      </>
    )
    rerender(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="under" />
        <Modal title="Dialog" onClose={() => {}}>
          <p>hi</p>
        </Modal>
      </>
    )
    press('ArrowDown')
    expect(bodyRows('under')[0]!.dataset.active).toBe('true')
    rerender(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="under" />
        <DataTable columns={COLUMNS} rows={SMALL} testId="over" />
      </>
    )
    press('ArrowDown')
    expect(bodyRows('over')[1]!.dataset.active).toBe('true')
    expect(bodyRows('under')[0]!.dataset.active).toBe('true')
  })

  it('ignores keys typed into the quick filter', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    const input = screen.getByTestId('table-table-quick')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(bodyRows()[0]!.dataset.active).toBe('true')
  })
})

describe('DataTable sorting', () => {
  it('cycles asc → desc → none with aria-sort and a numeric-aware order', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    const th = screen.getByTestId('sort-table-name').closest('th')!
    expect(th.getAttribute('aria-sort')).toBe('none')
    fireEvent.click(screen.getByTestId('sort-table-name'))
    expect(th.getAttribute('aria-sort')).toBe('ascending')
    expect(names()).toEqual(['Inv 2', 'Inv 9', 'Inv 10'])
    fireEvent.click(screen.getByTestId('sort-table-name'))
    expect(th.getAttribute('aria-sort')).toBe('descending')
    expect(names()).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])
    fireEvent.click(screen.getByTestId('sort-table-name'))
    expect(th.getAttribute('aria-sort')).toBe('none')
    expect(names()).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])
  })

  it('shift-click adds a secondary sort', () => {
    const rows: Row[] = [
      { id: 1, name: 'B', date: '2026-04-02', amount: 1, kind: 'sales' },
      { id: 2, name: 'A', date: '2026-04-02', amount: 1, kind: 'sales' },
      { id: 3, name: 'C', date: '2026-04-01', amount: 1, kind: 'sales' }
    ]
    render(<DataTable columns={COLUMNS} rows={rows} />)
    fireEvent.click(screen.getByTestId('sort-table-date'))
    fireEvent.click(screen.getByTestId('sort-table-name'), { shiftKey: true })
    expect(names()).toEqual(['C', 'A', 'B'])
    expect(screen.getByTestId('sort-table-date').closest('th')!.getAttribute('aria-sort')).toBe('ascending')
    expect(screen.getByTestId('sort-table-name').closest('th')!.getAttribute('aria-sort')).toBe('ascending')
  })
})

describe('DataTable filtering', () => {
  it('quick filter narrows rows and updates the totals', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: 'inv 1' } })
    expect(names()).toEqual(['Inv 10'])
    expect(screen.getByTestId('table-table-count').textContent).toContain('1 of 3')
    expect(screen.getByTestId('table-table-totals').textContent).toContain('1,500.00')
  })

  it('a money column filter parses rupees, shows a chip and can be cleared', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-amount'))
    const dialog = screen.getByRole('dialog', { name: 'Filter Amount' })
    fireEvent.change(within(dialog).getByTestId('table-filter-amount-op'), { target: { value: 'gte' } })
    fireEvent.change(within(dialog).getByTestId('table-filter-amount-a'), { target: { value: '25' } })
    fireEvent.click(within(dialog).getByTestId('table-filter-amount-apply'))
    expect(names()).toEqual(['Inv 10', 'Inv 9'])
    expect(screen.getByTestId('table-table-chip-amount').textContent).toContain('Amount ≥ 25.00')
    fireEvent.click(within(screen.getByTestId('table-table-chip-amount')).getByRole('button'))
    expect(names()).toHaveLength(3)
  })

  it('rejects an unparseable amount inline instead of applying it', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-amount'))
    fireEvent.change(screen.getByTestId('table-filter-amount-a'), { target: { value: '12.345' } })
    fireEvent.click(screen.getByTestId('table-filter-amount-apply'))
    expect(screen.getByRole('alert').textContent).toMatch(/amount/)
    expect(names()).toHaveLength(3)
  })

  it('enum filter is one-of', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-kind'))
    fireEvent.click(screen.getByLabelText('Purchase'))
    fireEvent.click(screen.getByTestId('table-filter-kind-apply'))
    expect(names()).toEqual(['Inv 9'])
  })

  it('date filter accepts Tally smart dates', () => {
    act(() => useSession.setState({ workingDate: '2026-06-15' }))
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-date'))
    fireEvent.change(screen.getByTestId('table-filter-date-op'), { target: { value: 'after' } })
    fireEvent.change(screen.getByTestId('table-filter-date-a'), { target: { value: '1/4' } })
    fireEvent.keyDown(screen.getByTestId('table-filter-date-a'), { key: 'Enter' })
    expect(names()).toEqual(['Inv 10', 'Inv 2'])
  })

  it('Esc closes a filter popover without reaching window listeners', () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-name'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    press('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onWindowKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowKey)
  })

  it('shows a "no rows match" state with a reset when everything is filtered out', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: 'zzz' } })
    expect(screen.getByText('No rows match')).toBeTruthy()
    fireEvent.click(screen.getByTestId('table-table-reset-filters'))
    expect(names()).toHaveLength(3)
  })
})

describe('DataTable columns, grouping, empty/loading', () => {
  it('column chooser hides and reorders columns', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('table-table-columns'))
    fireEvent.click(screen.getByTestId('table-table-col-date'))
    expect(screen.queryByTestId('sort-table-date')).toBeNull()
    fireEvent.click(screen.getByLabelText('Move Amount up'))
    const headers = screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-col'))
    expect(headers).toEqual(['name', 'amount', 'kind'])
  })

  it('groups with subtotals and collapses', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.change(screen.getByTestId('table-table-group'), { target: { value: 'kind' } })
    const groups = Array.from(document.querySelectorAll('tr.dt-group'))
    expect(groups.map((g) => g.querySelector('td')!.textContent)).toEqual(['▾Purchase1', '▾Sales2'])
    expect(groups[1]!.textContent).toContain('1,500.99')
    fireEvent.click(screen.getByLabelText('Collapse Sales'))
    expect(bodyRows().filter((r) => !r.classList.contains('dt-group'))).toHaveLength(1)
  })

  it('loading shows skeleton rows; no rows shows the empty state', () => {
    const { rerender } = render(<DataTable columns={COLUMNS} rows={[]} loading />)
    expect(screen.getByTestId('skeleton-rows')).toBeTruthy()
    rerender(<DataTable columns={COLUMNS} rows={[]} empty={{ title: 'No vouchers yet' }} />)
    expect(screen.getByText('No vouchers yet')).toBeTruthy()
  })

  it('action cells never activate the row', () => {
    const onActivate = vi.fn()
    const onPdf = vi.fn()
    render(
      <DataTable
        columns={COLUMNS}
        rows={SMALL}
        onRowActivate={onActivate}
        trailing={(r) => (
          <button type="button" onClick={() => onPdf(r.id)}>
            PDF
          </button>
        )}
      />
    )
    fireEvent.click(screen.getAllByText('PDF', { selector: 'tbody button' })[0]!)
    expect(onPdf).toHaveBeenCalledWith(1)
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('view persistence', () => {
  it('persists the view per company + screen and restores it on remount', () => {
    const first = render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    fireEvent.click(screen.getByTestId('sort-tb-amount'))
    fireEvent.click(screen.getByTestId('tb-table-density'))
    first.unmount()
    const stored = JSON.parse(localStorage.getItem(tableViewStorageKey('alpha-co', 'tb'))!)
    expect(stored.current.sort).toEqual([{ id: 'amount', dir: 'asc' }])
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    expect(names('tb')).toEqual(['Inv 2', 'Inv 9', 'Inv 10'])
    expect(screen.getByRole('table').dataset.density).toBe('compact')
  })

  it('another company does not inherit the view', () => {
    const first = render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    fireEvent.click(screen.getByTestId('sort-tb-amount'))
    first.unmount()
    act(() => useSession.setState({ slug: 'beta-co' }))
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    expect(names('tb')).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])
  })

  it('saves, switches, renames, deletes and resets named views through the menu', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    fireEvent.click(screen.getByTestId('sort-tb-name'))
    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByTestId('tb-table-view-save-as'))
    fireEvent.change(screen.getByTestId('tb-table-view-name'), { target: { value: 'By name' } })
    fireEvent.click(screen.getByTestId('tb-table-view-save'))
    expect(screen.getByTestId('tb-table-views').textContent).toContain('By name')

    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByTestId('tb-table-view-default'))
    expect(names('tb')).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])

    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByText('By name'))
    expect(names('tb')).toEqual(['Inv 2', 'Inv 9', 'Inv 10'])

    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByTestId('tb-table-view-rename'))
    fireEvent.change(screen.getByTestId('tb-table-view-name'), { target: { value: 'Alpha' } })
    fireEvent.keyDown(screen.getByTestId('tb-table-view-name'), { key: 'Enter' })
    expect(screen.getByTestId('tb-table-views').textContent).toContain('Alpha')

    fireEvent.click(screen.getByTestId('sort-tb-amount')) // modify the active view
    expect(screen.getByTestId('tb-table-views').textContent).toContain('•')

    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByTestId('tb-table-view-delete'))
    expect(screen.getByTestId('tb-table-views').textContent).toContain('Default view')
    const stored = JSON.parse(localStorage.getItem(tableViewStorageKey('alpha-co', 'tb'))!)
    expect(stored.saved).toEqual([])

    fireEvent.click(screen.getByTestId('tb-table-views'))
    fireEvent.click(screen.getByTestId('tb-table-view-reset'))
    expect(names('tb')).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])
  })

  it('corrupt stored state falls back to defaults', () => {
    localStorage.setItem(tableViewStorageKey('alpha-co', 'tb'), '{"v":1,"current":{"v":1,"sort":"garbage"')
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="tb" />)
    expect(names('tb')).toEqual(['Inv 10', 'Inv 9', 'Inv 2'])
  })

  it('migrates hidden columns from a legacy useReportConfig key', () => {
    localStorage.setItem('total-reportcfg-alpha-co-daybook', JSON.stringify({ kind: false, amount: true }))
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="daybook" legacyReportKey="daybook" />)
    expect(screen.queryByTestId('sort-daybook-kind')).toBeNull()
    expect(screen.getByTestId('sort-daybook-amount')).toBeTruthy()
  })

  it('useTableView exposes the controller for screens that need it', () => {
    const { result } = renderHook(() => useTableView('x', COLUMNS))
    act(() => result.current.setView((v) => ({ ...v, groupBy: 'kind' })))
    act(() => result.current.saveAs('Grouped'))
    act(() => result.current.switchTo(null))
    expect(result.current.view.groupBy).toBeNull()
    act(() => result.current.switchTo('Grouped'))
    expect(result.current.view.groupBy).toBe('kind')
    expect(result.current.active).toBe('Grouped')
  })
})
