// DataTable platform gaps (WP 1.6b): tables inside a Modal, header controls that don't steal
// label width, the integer width model, grouped header bands, the toolbar with zero rows, footer
// context, per-row quantity formatting, the CSV money format and the nested-table CSS scope.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { DataTable, defineColumns, Popover, PopoverButton, type DataTableFooterContext } from '../../components/table'
import { Modal } from '../../components/ui'
import { headerMinWidth, KIND_DEFAULT_WIDTH } from '../../lib/table'
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

const keydown = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}
const bodyRows = (area = 'table'): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const activeIndex = (area = 'table'): number => bodyRows(area).findIndex((r) => r.dataset.active === 'true')
const popover = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-table-popover]')

beforeEach(() => {
  localStorage.clear()
  act(() => useSession.setState({ slug: 'alpha-co' }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a DataTable inside a Modal', () => {
  function Screen({ onClose, onActivate }: { onClose: () => void; onActivate?: (r: Row) => void }): React.JSX.Element {
    return (
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="behind" />
        <Modal title="Rules" onClose={onClose}>
          <button type="button" data-testid="modal-first">
            First
          </button>
          <DataTable columns={COLUMNS} rows={SMALL} testId="inner" onRowActivate={onActivate} />
        </Modal>
      </>
    )
  }

  it('keeps keyboard navigation for the table in the topmost modal and suspends the one behind it', () => {
    const onActivate = vi.fn()
    render(<Screen onClose={() => {}} onActivate={onActivate} />)
    keydown('ArrowDown')
    keydown('ArrowDown')
    expect(activeIndex('inner')).toBe(2)
    expect(activeIndex('behind')).toBe(0)
    keydown('End')
    keydown('Home')
    expect(activeIndex('inner')).toBe(0)
    keydown('Enter')
    expect(onActivate).toHaveBeenCalledWith(SMALL[0])
    // Enter on one of the dialog's buttons belongs to that button, not to the active row.
    onActivate.mockClear()
    keydown('Enter', screen.getByTestId('modal-first'))
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('a modal stacked on top suspends the table in the modal underneath', () => {
    render(
      <>
        <Modal title="Lower" onClose={() => {}}>
          <DataTable columns={COLUMNS} rows={SMALL} testId="lower" />
        </Modal>
        <Modal title="Confirm" onClose={() => {}}>
          <p>Sure?</p>
        </Modal>
      </>
    )
    keydown('ArrowDown')
    expect(activeIndex('lower')).toBe(0)
  })

  it('Esc closes a column-filter popover first, and only the next Esc closes the modal', () => {
    const onClose = vi.fn()
    render(<Screen onClose={onClose} />)
    fireEvent.click(screen.getByTestId('filter-inner-name'))
    expect(popover()).toBeTruthy()
    keydown('Escape')
    expect(popover()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('filter-inner-name')) // focus back on the trigger
    keydown('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the toolbar popovers (columns) behave the same way', () => {
    const onClose = vi.fn()
    render(<Screen onClose={onClose} />)
    fireEvent.click(screen.getByTestId('inner-table-columns'))
    expect(popover()).toBeTruthy()
    keydown('Escape')
    expect(popover()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Esc in the quick filter clears its text before it closes the modal', () => {
    const onClose = vi.fn()
    render(<Screen onClose={onClose} />)
    const quick = screen.getByTestId('inner-table-quick') as HTMLInputElement
    fireEvent.change(quick, { target: { value: 'Inv 9' } })
    expect(bodyRows('inner')).toHaveLength(1)
    keydown('Escape', quick)
    expect(quick.value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    keydown('Escape', quick)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('popovers portal into the dialog: they join its focus loop and stack above its content', () => {
    // jsdom has no layout; the Modal's Tab trap skips elements without an offsetParent.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
    render(<Screen onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('filter-inner-amount'))
    const pop = popover()!
    const dialog = document.querySelector<HTMLElement>('[data-modal="Rules"]')!
    expect(dialog.contains(pop)).toBe(true)
    expect(pop.className).toContain('z-50') // above the dialog content, inside the overlay (z-40)
    // Shift+Tab from the dialog's first control wraps to the popover's last control.
    const first = within(dialog).getByTestId('modal-close')
    act(() => first.focus())
    keydown('Tab', first, { shiftKey: true })
    const focusables = pop.querySelectorAll<HTMLElement>('button, input, select')
    expect(document.activeElement).toBe(focusables[focusables.length - 1])
  })

  it('outside any modal a popover still portals to <body>', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-name'))
    expect(popover()!.parentElement).toBe(document.body)
  })
})

describe('header controls do not take label width', () => {
  it('no sort arrow is laid out until the column is sorted; the funnel is an overlay marked active when filtering', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    const sort = screen.getByTestId('sort-table-amount')
    expect(sort.querySelectorAll('span')).toHaveLength(1) // the label only
    fireEvent.click(sort)
    expect(sort.textContent).toBe('Amount↑')
    const funnel = screen.getByTestId('filter-table-name')
    expect(funnel.classList.contains('dt-filter')).toBe(true)
    expect(funnel.parentElement?.tagName).toBe('TH') // an overlay on the header cell, not in the label's flex row
    expect(funnel.hasAttribute('data-active')).toBe(false)
    expect(funnel.tabIndex).toBe(0) // keyboard reachable while hidden
    fireEvent.click(funnel)
    fireEvent.change(screen.getByTestId('table-filter-name-a'), { target: { value: 'Inv' } })
    fireEvent.click(screen.getByTestId('table-filter-name-apply'))
    expect(funnel.hasAttribute('data-active')).toBe(true)
    expect(funnel.getAttribute('aria-label')).toBe('Filter Name (filtered)')
  })

  it('a default-width column is at least wide enough for its header label', () => {
    const cols = defineColumns<Row>([
      { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
      { id: 'amount', header: 'Amount incl. tax', kind: 'money', value: (r) => r.amount },
      { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date }
    ])
    const { container } = render(<DataTable columns={cols} rows={SMALL} />)
    const widths = Array.from(container.querySelectorAll('col')).map((c) => parseInt(c.style.width || '0', 10))
    expect(widths[1]).toBe(headerMinWidth('Amount incl. tax'))
    expect(widths[1]).toBeGreaterThan(KIND_DEFAULT_WIDTH.money!)
    expect(widths[2]).toBe(KIND_DEFAULT_WIDTH.date)
  })
})

describe('integer width model', () => {
  const measure = (w: number): void => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('overflow-auto') ? w : 0
    })
  }

  it('gives every column an integer width summing exactly to the container (no browser-shared pixels)', () => {
    measure(1001)
    const { container } = render(<DataTable columns={COLUMNS} rows={SMALL} trailing={() => null} trailingWidth={60} />)
    const table = container.querySelector('table')!
    expect(table.style.width).toBe('1001px')
    const widths = Array.from(container.querySelectorAll('col')).map((c) => Number(c.style.width.replace('px', '')))
    expect(widths.every((w) => Number.isInteger(w) && w > 0)).toBe(true)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(1001)
    // only the flexible text column (Name) grew
    expect(widths.slice(1)).toEqual([KIND_DEFAULT_WIDTH.date, KIND_DEFAULT_WIDTH.enum, KIND_DEFAULT_WIDTH.money, 60])
  })

  it('when every column is fixed the last text column takes the spare space', () => {
    measure(900)
    const cols = defineColumns<Row>([
      { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name, width: 140 },
      { id: 'kind', header: 'Kind', kind: 'text', value: (r) => r.kind, width: 100 },
      { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, width: 150 }
    ])
    const { container } = render(<DataTable columns={cols} rows={SMALL} />)
    const widths = Array.from(container.querySelectorAll('col')).map((c) => c.style.width)
    expect(widths).toEqual(['140px', '610px', '150px'])
  })

  it('respects minWidth and overflows only once the columns really do not fit', () => {
    measure(500)
    const cols = defineColumns<Row>([
      { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name, minWidth: 260 },
      { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount }
    ])
    const { container } = render(<DataTable columns={cols} rows={SMALL} />)
    expect(container.querySelector('table')!.style.width).toBe('500px') // 260 + 150 fits: no 160px guess
    cleanup()
    measure(300)
    const again = render(<DataTable columns={cols} rows={SMALL} />)
    expect(again.container.querySelector('table')!.style.width).toBe('410px') // scrolls sideways
  })
})

describe('grouped header bands', () => {
  const GCOLS = defineColumns<Row>([
    { id: 'name', header: 'Invoice no.', group: 'Portal', kind: 'text', value: (r) => r.name },
    { id: 'date', header: 'Date', group: 'Portal', kind: 'date', value: (r) => r.date },
    { id: 'kind', header: 'Type', group: 'Books', kind: 'enum', value: (r) => r.kind },
    { id: 'amount', header: 'Value', group: 'Books', kind: 'money', value: (r) => r.amount, aggregate: 'sum' },
    { id: 'id', header: 'Id', kind: 'number', value: (r) => r.id }
  ])
  const bands = (): [string, number][] =>
    Array.from(document.querySelectorAll<HTMLTableCellElement>('tr.dt-bands > *')).map((c) => [c.textContent ?? '', c.colSpan])

  it('renders a band row with th scope="colgroup" over its columns, one <colgroup> per band', () => {
    const { container } = render(<DataTable columns={GCOLS} rows={SMALL} renderDetail={() => 'd'} />)
    expect(bands()).toEqual([
      ['', 1], // the expander column
      ['Portal', 2],
      ['Books', 2],
      ['', 1]
    ])
    const ths = container.querySelectorAll('tr.dt-bands > th')
    expect(Array.from(ths).every((th) => th.getAttribute('scope') === 'colgroup')).toBe(true)
    expect(Array.from(container.querySelectorAll('colgroup')).map((g) => g.children.length)).toEqual([1, 2, 2, 1])
    // column headers stay concise
    expect(screen.getByTestId('sort-table-name').textContent).toBe('Invoice no.')
    expect(screen.getByTestId('sort-table-name').title).toContain('Portal · Invoice no.')
  })

  it('bands follow hide and reorder', () => {
    render(<DataTable columns={GCOLS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('table-table-columns'))
    expect(screen.getByTestId('table-table-col-name').closest('label')!.textContent).toBe('Portal · Invoice no.')
    fireEvent.click(screen.getByTestId('table-table-col-date')) // hide Portal · Date
    expect(bands()).toEqual([
      ['Portal', 1],
      ['Books', 2],
      ['', 1]
    ])
    fireEvent.click(screen.getByLabelText('Move Books · Type up')) // Type now sits before Portal's Invoice no.
    fireEvent.click(screen.getByLabelText('Move Books · Type up'))
    expect(bands()).toEqual([
      ['Books', 1],
      ['Portal', 1],
      ['Books', 1],
      ['', 1]
    ])
  })

  it('exports prefixed header labels', async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { path: '/tmp/x' } }))
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
    render(<DataTable columns={GCOLS} rows={SMALL} exportOptions={{ title: '2B', periodLabel: 'Apr' }} />)
    fireEvent.click(screen.getByTestId('table-table-csv'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const csv = (invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }).csv
    expect(csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe('Portal · Invoice no.,Portal · Date,Books · Type,Books · Value,Id')
    fireEvent.click(screen.getByTestId('table-table-pdf'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const pdf = invoke.mock.calls.find((c) => c[0] === 'report:pdf')![1] as { columns: { label: string }[] }
    expect(pdf.columns.map((c) => c.label)[3]).toBe('Books · Value')
  })

  it('no group on any visible column → no band row', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={SMALL} />)
    expect(container.querySelector('tr.dt-bands')).toBeNull()
    expect(container.querySelectorAll('colgroup')).toHaveLength(1)
  })
})

describe('toolbar and empty states', () => {
  it('keeps the toolbar (with screen controls) and the header when there are no rows; the empty state sits in the body', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        empty={{ title: 'No ledgers yet', hint: 'Create one' }}
        toolbarStart={<select data-testid="screen-filter" aria-label="Group" />}
        exportOptions={{ title: 'X', periodLabel: 'Y' }}
      />
    )
    expect(screen.getByTestId('table-table-toolbar')).toBeTruthy()
    expect(screen.getByTestId('screen-filter')).toBeTruthy()
    expect(screen.getByTestId('table-table-count').textContent).toBe('0 rows')
    expect(screen.getByTestId('sort-table-name')).toBeTruthy()
    const empty = screen.getByTestId('rows-table').querySelector('tr.dt-empty')!
    expect(empty.getAttribute('data-empty')).toBe('no-data')
    expect(within(empty as HTMLElement).getByText('No ledgers yet')).toBeTruthy()
    expect(screen.queryByTestId('table-table-reset-filters')).toBeNull()
    expect(screen.queryByTestId('table-table-csv')).toBeNull() // nothing to export
  })

  it('distinguishes "no rows match your filters" (with Clear filters) from no data', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    fireEvent.click(screen.getByTestId('filter-table-kind'))
    fireEvent.click(screen.getByLabelText('Sales'))
    fireEvent.click(screen.getByTestId('table-filter-kind-apply'))
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: 'Inv 9' } })
    const empty = screen.getByTestId('rows-table').querySelector('tr.dt-empty')!
    expect(empty.getAttribute('data-empty')).toBe('filtered')
    expect(screen.getByText('No rows match')).toBeTruthy()
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByTestId('table-table-reset-filters'))
    expect(bodyRows()).toHaveLength(3)
    expect(screen.queryByTestId('table-table-chip-kind')).toBeNull()
  })

  it('the toolbar (and its screen controls) stays while loading, without a misleading count', () => {
    render(<DataTable columns={COLUMNS} rows={[]} loading toolbarStart={<input data-testid="screen-search" aria-label="Search" />} />)
    expect(screen.getByTestId('skeleton-rows')).toBeTruthy()
    expect(screen.getByTestId('screen-search')).toBeTruthy()
    expect(screen.queryByTestId('table-table-count')).toBeNull()
  })

  it('toolbar={false} while loading renders just the skeleton (unchanged)', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={[]} loading toolbar={false} />)
    expect(container.firstElementChild?.getAttribute('data-testid')).toBe('skeleton-rows')
  })
})

describe('footer context', () => {
  it('totalsLabel can be a function of the rows in view and the counts', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={SMALL}
        totalsLabel={(ctx) => `Total · ${ctx.filteredCount} of ${ctx.totalCount}${ctx.isFiltered ? ' (filtered)' : ''} · ${ctx.rows.filter((r) => r.kind === 'sales').length} sales`}
      />
    )
    const totals = screen.getByTestId('table-table-totals')
    expect(totals.textContent).toContain('Total · 3 of 3 · 2 sales')
    fireEvent.change(screen.getByTestId('table-table-quick'), { target: { value: 'Inv 9' } })
    expect(totals.textContent).toContain('Total · 1 of 3 (filtered) · 0 sales')
  })

  it('renderFooter receives the same counts', () => {
    const seen: DataTableFooterContext<Row>[] = []
    render(
      <DataTable
        columns={COLUMNS}
        rows={SMALL}
        renderFooter={(ctx) => {
          seen.push(ctx)
          return (
            <tr className="total-row">
              <td colSpan={ctx.colSpan}>n={ctx.filteredCount}</td>
            </tr>
          )
        }}
      />
    )
    expect(seen.at(-1)).toMatchObject({ filteredCount: 3, totalCount: 3, isFiltered: false, colSpan: 4 })
  })

  it('a function totalsLabel that yields a string also labels the exported totals row', async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { path: '/tmp/x' } }))
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
    render(<DataTable columns={COLUMNS} rows={SMALL} totalsLabel={(ctx) => `Total (${ctx.filteredCount})`} exportOptions={{ title: 'T', periodLabel: 'P' }} />)
    fireEvent.click(screen.getByTestId('table-table-csv'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const csv = (invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }).csv
    expect(csv.trim().split(/\r?\n/).at(-1)).toContain('Total (3)')
  })
})

describe('per-row quantity formatting in cells', () => {
  interface Item {
    id: number
    qty: number
    dec: number
    unit: string
  }
  it('renders each row with its own decimals and unit — no text override needed', () => {
    const cols = defineColumns<Item>([
      { id: 'id', header: 'Item', kind: 'text', value: (r) => String(r.id) },
      { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qty, decimals: (r) => r.dec, unit: (r) => r.unit }
    ])
    render(
      <DataTable
        columns={cols}
        rows={[
          { id: 1, qty: 2500, dec: 0, unit: 'pcs' },
          { id: 2, qty: 1250, dec: 3, unit: 'kg' }
        ]}
      />
    )
    expect(bodyRows().map((r) => r.querySelectorAll('td')[1]!.textContent)).toEqual(['3 pcs', '1.250 kg'])
  })
})

describe('CSV money format', () => {
  it("exportOptions.csvMoneyFormat 'plain' writes signed decimals; the PDF keeps the display format", async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { path: '/tmp/x' } }))
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
    const cols = defineColumns<Row>([
      { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
      { id: 'amount', header: 'Balance', kind: 'money', signed: true, value: (r) => (r.kind === 'sales' ? r.amount : -r.amount) }
    ])
    render(<DataTable columns={cols} rows={SMALL} exportOptions={{ title: 'C', periodLabel: 'P', csvMoneyFormat: 'plain' }} />)
    fireEvent.click(screen.getByTestId('table-table-csv'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const csv = (invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }).csv
    expect(csv.trim().split(/\r?\n/).slice(1)).toEqual(['Inv 10,1500.00', 'Inv 9,-25.00', 'Inv 2,0.99'])
    fireEvent.click(screen.getByTestId('table-table-pdf'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const pdf = invoke.mock.calls.find((c) => c[0] === 'report:pdf')![1] as { rows: { cells: string[] }[] }
    expect(pdf.rows[1]!.cells[1]).toBe('25.00 Cr')
  })
})

describe('nested tables and the Popover export', () => {
  it('the sticky-header and single-line rules only reach the DataTable’s own rows (child combinators)', () => {
    const css = readFileSync(resolve(__dirname, '../../app.css'), 'utf8')
    expect(css).not.toMatch(/\.data-table thead th/)
    expect(css).not.toMatch(/\.data-table td\s*[{,]/)
    expect(css).toMatch(/\.data-table > thead > tr > th/)
    expect(css).toMatch(/\.data-table > tbody > tr > td/)
  })

  it('a nested table in a detail row can have its own <thead>', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={SMALL}
        rowKey={(r) => r.id}
        defaultExpanded={[1]}
        renderDetail={() => (
          <table className="ledger-table" data-testid="nested">
            <thead>
              <tr>
                <th>Bill</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>B-1</td>
              </tr>
            </tbody>
          </table>
        )}
      />
    )
    expect(within(screen.getByTestId('nested')).getByRole('columnheader').textContent).toBe('Bill')
  })

  it('Popover and PopoverButton are exported from components/table', () => {
    function Host(): React.JSX.Element {
      const ref = useRef<HTMLButtonElement>(null)
      const [open, setOpen] = useState(true)
      return (
        <>
          <button ref={ref}>anchor</button>
          {open && (
            <Popover anchor={ref} onClose={() => setOpen(false)} label="Menu">
              <button>Item</button>
            </Popover>
          )}
          <PopoverButton label="More" popoverLabel="More" open={false} setOpen={() => {}} render={() => null}>
            More
          </PopoverButton>
        </>
      )
    }
    render(<Host />)
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()
    keydown('Escape')
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  })
})
