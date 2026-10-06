// DataTable follow-ups — expandable detail rows (incl. variable heights under virtualisation),
// keyboard claim with several tables, non-activatable rows, pointer reorder/resize of columns,
// and the visible PDF row cap.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { DataTable, defineColumns, type RowKey } from '../../components/table'
import { Modal } from '../../components/ui'
import { buildRowLayout, itemAt } from '../../lib/table'
import { useSession, useToasts } from '../../state/stores'

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
  { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum' }
])

const SMALL: Row[] = [
  { id: 1, name: 'Inv 10', date: '2026-04-03', amount: 150000, kind: 'sales' },
  { id: 2, name: 'Inv 9', date: '2026-04-01', amount: 2500, kind: 'purchase' },
  { id: 3, name: 'Inv 2', date: '2026-04-02', amount: 99, kind: 'sales' }
]

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, name: `Row ${i}`, date: '2026-04-01', amount: 100, kind: i % 2 ? 'purchase' : 'sales' }))
/** Built once per file: the 50k-row tests only read it. */
const ROWS_50K = makeRows(50_000)

const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}
const bodyRows = (area = 'table'): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const activeRow = (area = 'table'): HTMLElement | undefined => bodyRows(area).find((r) => r.dataset.active === 'true')
const firstCellText = (tr: HTMLElement | undefined): string | undefined =>
  tr?.querySelector('td:not(.dt-expander)')?.textContent ?? undefined
const pointer = (target: EventTarget, type: string, clientX: number): void => {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }))
  })
}

beforeEach(() => {
  localStorage.clear()
  act(() => useSession.setState({ slug: 'alpha-co' }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('expandable detail rows', () => {
  const detail = (r: Row): React.JSX.Element => <div data-testid={`detail-${r.id}`}>Bills for {r.name}</div>

  it('a chevron (aria-expanded) toggles a full-width detail row without activating the row', () => {
    const onActivate = vi.fn()
    render(<DataTable columns={COLUMNS} rows={SMALL} rowKey={(r) => r.id} renderDetail={detail} onRowActivate={onActivate} />)
    const chevron = screen.getByTestId('table-expand-2')
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron)
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    const tr = screen.getByTestId('detail-2').closest('tr')!
    expect(tr.classList.contains('dt-detail')).toBe(true)
    expect(tr.querySelector('td')!.colSpan).toBe(5) // 4 columns + the chevron column
    expect(chevron.getAttribute('aria-controls')).toBe(tr.id)
    expect(tr.previousElementSibling?.getAttribute('data-row-id') ?? firstCellText(tr.previousElementSibling as HTMLElement)).toBe('Inv 9')
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.click(chevron)
    expect(screen.queryByTestId('detail-2')).toBeNull()
  })

  it('→ expands and ← collapses the active row; non-expandable rows ignore it', () => {
    render(
      <DataTable columns={COLUMNS} rows={SMALL} rowKey={(r) => r.id} renderDetail={detail} isRowExpandable={(r) => r.id !== 3} />
    )
    press('ArrowRight')
    expect(screen.getByTestId('detail-1')).toBeTruthy()
    press('ArrowDown') // the detail row is not a navigation stop
    expect(firstCellText(activeRow())).toBe('Inv 9')
    press('ArrowRight')
    expect(screen.getByTestId('detail-2')).toBeTruthy()
    press('ArrowLeft')
    expect(screen.queryByTestId('detail-2')).toBeNull()
    press('ArrowDown')
    press('ArrowRight')
    expect(screen.queryByTestId('detail-3')).toBeNull()
    expect(screen.queryByTestId('table-expand-3')).toBeNull()
  })

  it('controlled mode reports changes and renders only what the parent passes', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DataTable columns={COLUMNS} rows={SMALL} rowKey={(r) => r.id} renderDetail={detail} expanded={new Set()} onExpandedChange={onChange} />
    )
    fireEvent.click(screen.getByTestId('table-expand-1'))
    expect(onChange).toHaveBeenCalledWith(new Set([1]))
    expect(screen.queryByTestId('detail-1')).toBeNull() // parent hasn't accepted it yet
    rerender(<DataTable columns={COLUMNS} rows={SMALL} rowKey={(r) => r.id} renderDetail={detail} expanded={new Set([1, 3])} onExpandedChange={onChange} />)
    expect(screen.getByTestId('detail-1')).toBeTruthy()
    expect(screen.getByTestId('detail-3')).toBeTruthy()
  })

  it('expanded state follows the row key through sorting', () => {
    render(<DataTable columns={COLUMNS} rows={SMALL} rowKey={(r) => r.id} renderDetail={detail} defaultExpanded={[2]} />)
    fireEvent.click(screen.getByTestId('sort-table-amount'))
    const tr = screen.getByTestId('detail-2').closest('tr')!
    expect(firstCellText(tr.previousElementSibling as HTMLElement)).toBe('Inv 9')
  })

  it('50,000 rows with 313 expanded (variable measured heights): bounded DOM, exact spacers, End reaches the last row', () => {
    const N = 50_000
    const isOpen = (i: number): boolean => i % 160 === 0
    const heightOf = (id: number): number => 40 + (id % 5) * 30
    const measured = new Set<number>()
    // A plain prototype patch (restored below) rather than vi.spyOn: a spy records every call,
    // and this one is hit for every rendered row on every render.
    const realRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      let height = 0
      if (this.classList.contains('dt-detail')) {
        const id = Number((this as HTMLElement).dataset.detailFor)
        measured.add(id)
        height = heightOf(id)
      } else if (this.classList.contains('dt-row')) height = 33
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
    }
    onTestFinished(() => {
      Element.prototype.getBoundingClientRect = realRect
    })
    const rows = ROWS_50K
    const expanded = new Set<RowKey>(rows.filter((r) => isOpen(r.id)).map((r) => r.id))
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState<ReadonlySet<RowKey>>(expanded)
      return (
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          renderDetail={(r) => <div>Detail {r.id}</div>}
          expanded={open}
          onExpandedChange={setOpen}
        />
      )
    }
    render(<Host />)
    const table = screen.getByRole('table')
    expect(table.getAttribute('aria-rowcount')).toBe(String(N + 313 + 1))
    const tbody = screen.getByTestId('rows-table')
    expect(tbody.querySelectorAll('tr').length).toBeLessThan(90)
    expect(measured.has(0)).toBe(true) // row 0's detail rendered and reported its height

    const expectSpacersConsistent = (): void => {
      // Expected layout: measured details use their real height, the rest the 120px estimate.
      const L = buildRowLayout(N, 33, (i) => (isOpen(i) ? (measured.has(i) ? heightOf(i) : 120) : 0))
      const items = Array.from(tbody.querySelectorAll<HTMLElement>('tr.dt-row')).map((tr) => Number(tr.dataset.item))
      const first = items[0]!
      const last = items[items.length - 1]!
      const spacers = Array.from(tbody.querySelectorAll<HTMLElement>('tr.dt-spacer'))
      const top = tbody.firstElementChild!.classList.contains('dt-spacer') ? parseFloat(spacers[0]!.style.height) : 0
      const bottom = tbody.lastElementChild!.classList.contains('dt-spacer') ? parseFloat(spacers[spacers.length - 1]!.style.height) : 0
      expect(top).toBeCloseTo(L.offsets[first]!, 5)
      expect(bottom).toBeCloseTo(L.total - L.offsets[last + 1]!, 5)
      // every expanded row in the window is followed by its detail row
      for (const tr of tbody.querySelectorAll<HTMLElement>('tr.dt-row')) {
        const i = Number(tr.dataset.item)
        expect(tr.nextElementSibling?.classList.contains('dt-detail') ?? false).toBe(isOpen(i))
      }
    }
    expectSpacersConsistent()

    press('End')
    expect(firstCellText(activeRow())).toBe('Row 49999')
    expectSpacersConsistent()
    expect(tbody.querySelectorAll('tr').length).toBeLessThan(90)

    press('Home')
    press('ArrowDown')
    press('ArrowRight') // row 1 is not expanded yet → expands
    expect(table.getAttribute('aria-rowcount')).toBe(String(N + 314 + 1))
    expect(activeRow()?.nextElementSibling?.classList.contains('dt-detail')).toBe(true)
    press('ArrowLeft')
    expect(table.getAttribute('aria-rowcount')).toBe(String(N + 313 + 1))

    // PageDown over expanded rows moves by height, not by a fixed count: from row 0 (expanded,
    // its detail measured at 40px) one 607px page (640 viewport − one row) lands exactly where
    // the pure offset index says, which is fewer rows than a fixed-height page would move.
    press('Home')
    press('PageDown')
    const after = Number(firstCellText(activeRow())!.replace('Row ', ''))
    const L = buildRowLayout(N, 33, (i) => (isOpen(i) ? (measured.has(i) ? heightOf(i) : 120) : 0))
    expect(after).toBe(itemAt(L, L.offsets[0]! + 640 - 33))
    expect(after).toBeLessThan(Math.floor((640 - 33) / 33))
    expect(after).toBeGreaterThan(5)
  }, 20_000)
})

describe('paging', () => {
  it('PageUp from the last row moves a full page (not one row), PageDown mirrors it', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS_50K} rowKey={(r) => r.id} />)
    press('End')
    press('PageUp')
    const up = Number(firstCellText(activeRow())!.replace('Row ', ''))
    expect(49_999 - up).toBeGreaterThan(10)
    press('PageDown')
    expect(firstCellText(activeRow())).toBe('Row 49999')
  })
})

describe('several tables on one screen', () => {
  it('the last table clicked or focused gets the keyboard; modals still win', () => {
    render(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="a" />
        <DataTable columns={COLUMNS} rows={SMALL} testId="b" />
      </>
    )
    press('ArrowDown') // b mounted last → it has the keyboard
    expect(firstCellText(activeRow('b'))).toBe('Inv 9')
    expect(firstCellText(activeRow('a'))).toBe('Inv 10')

    pointer(bodyRows('a')[2]!, 'pointerdown', 10)
    press('ArrowDown')
    expect(firstCellText(activeRow('a'))).toBe('Inv 9')
    expect(firstCellText(activeRow('b'))).toBe('Inv 9')

    act(() => {
      screen.getByTestId('b-table-quick').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    press('ArrowDown')
    expect(firstCellText(activeRow('b'))).toBe('Inv 2')
    expect(firstCellText(activeRow('a'))).toBe('Inv 9')
  })

  it('a modal suspends whichever table holds the keyboard', () => {
    const { rerender } = render(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="a" />
        <DataTable columns={COLUMNS} rows={SMALL} testId="b" />
      </>
    )
    pointer(bodyRows('a')[0]!, 'pointerdown', 10)
    rerender(
      <>
        <DataTable columns={COLUMNS} rows={SMALL} testId="a" />
        <DataTable columns={COLUMNS} rows={SMALL} testId="b" />
        <Modal title="Dialog" onClose={() => {}}>
          <p>hi</p>
        </Modal>
      </>
    )
    press('ArrowDown')
    expect(firstCellText(activeRow('a'))).toBe('Inv 10')
    expect(firstCellText(activeRow('b'))).toBe('Inv 10')
  })
})

describe('non-activatable rows', () => {
  it('get no pointer cursor and ignore Enter and clicks, but still show the keyboard bar', () => {
    const onActivate = vi.fn()
    render(<DataTable columns={COLUMNS} rows={SMALL} onRowActivate={onActivate} isRowActivatable={(r) => r.id !== 1} />)
    const [first, second] = bodyRows()
    expect(first!.classList.contains('cursor-pointer')).toBe(false)
    expect(first!.classList.contains('kbar-row')).toBe(true)
    expect(second!.classList.contains('cursor-pointer')).toBe(true)
    expect(first!.dataset.active).toBe('true')
    press('Enter')
    fireEvent.click(first!)
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('pointer reorder + resize of columns', () => {
  // Header cells laid out 100px apart, in DOM order.
  const mockHeaderRects = (): void => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.tagName === 'TH') {
        const ths = Array.from(this.parentElement!.children)
        const i = ths.indexOf(this)
        return { x: i * 100, y: 0, top: 0, left: i * 100, right: i * 100 + 100, bottom: 30, width: 100, height: 30, toJSON: () => ({}) } as DOMRect
      }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
    })
  }
  const order = (): (string | null)[] => screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-col'))

  it('dragging a header moves it, shows the drop edge, and never sorts', async () => {
    mockHeaderRects()
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="drag" />)
    const sortBtn = screen.getByTestId('sort-drag-name')
    pointer(sortBtn, 'pointerdown', 50)
    pointer(window, 'pointermove', 52) // under the 5px threshold — still a click
    expect(document.querySelector('th.dt-dragging')).toBeNull()
    pointer(window, 'pointermove', 260)
    expect(document.querySelector('th[data-col="name"]')!.classList.contains('dt-dragging')).toBe(true)
    expect(document.querySelector('th[data-col="kind"]')!.classList.contains('dt-drop-after')).toBe(true)
    pointer(window, 'pointerup', 260)
    fireEvent.click(sortBtn) // the click the browser fires after a drag
    expect(order()).toEqual(['date', 'kind', 'name', 'amount'])
    expect(screen.getByTestId('sort-drag-name').closest('th')!.getAttribute('aria-sort')).toBe('none')
    expect(JSON.parse(localStorage.getItem('total-tableview-alpha-co-drag')!).current.order.slice(0, 4)).toEqual(['date', 'kind', 'name', 'amount'])
    await act(() => new Promise((r) => setTimeout(r, 0)))
    fireEvent.click(screen.getByTestId('sort-drag-name')) // a real click later still sorts
    expect(screen.getByTestId('sort-drag-name').closest('th')!.getAttribute('aria-sort')).toBe('ascending')
  })

  it('a plain click (no movement) on a header still sorts', () => {
    mockHeaderRects()
    render(<DataTable columns={COLUMNS} rows={SMALL} />)
    const btn = screen.getByTestId('sort-table-date')
    pointer(btn, 'pointerdown', 150)
    pointer(window, 'pointerup', 150)
    fireEvent.click(btn)
    expect(btn.closest('th')!.getAttribute('aria-sort')).toBe('ascending')
    expect(order()).toEqual(['name', 'date', 'kind', 'amount'])
  })

  it('dragging the right edge resizes the column (and does not start a reorder)', () => {
    mockHeaderRects()
    render(<DataTable columns={COLUMNS} rows={SMALL} viewId="rs" />)
    const handle = screen.getByTestId('resize-rs-name')
    pointer(handle, 'pointerdown', 100)
    pointer(window, 'pointermove', 140)
    pointer(window, 'pointermove', 170)
    expect(document.querySelector('th.dt-dragging')).toBeNull()
    pointer(window, 'pointerup', 170)
    const col = screen.getByRole('table').querySelectorAll('col')[0] as HTMLElement
    expect(col.style.width).toBe('170px')
    expect(JSON.parse(localStorage.getItem('total-tableview-alpha-co-rs')!).current.widths).toEqual({ name: 170 })
    expect(order()).toEqual(['name', 'date', 'kind', 'amount'])
    fireEvent.doubleClick(handle) // double-click resets
    expect(col.style.width).toBe('')
  })
})

describe('export caps', () => {
  it('PDF over the 5,000-row cap is trimmed visibly (footer note + toast); CSV is not', async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { path: '/tmp/x' } }))
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
    act(() => useToasts.setState({ toasts: [] }))
    render(<DataTable columns={COLUMNS} rows={makeRows(6000)} exportOptions={{ title: 'Big', periodLabel: 'FY', footNote: 'Screen note' }} />)
    fireEvent.click(screen.getByTestId('table-table-pdf'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const pdf = invoke.mock.calls.find((c) => c[0] === 'report:pdf')![1] as { rows: { cells: string[]; rule?: boolean }[]; footNote: string }
    expect(pdf.rows).toHaveLength(5000)
    expect(pdf.rows.at(-1)!.rule).toBe(true)
    expect(pdf.rows.at(-1)!.cells).toContain('6,000.00') // totals over all 6,000 rows
    expect(pdf.footNote).toContain('Screen note')
    expect(pdf.footNote).toContain('first 4,999 of 6,000 lines')
    expect(useToasts.getState().toasts.some((t) => t.kind === 'warning' && t.text.includes('4,999 of 6,000'))).toBe(true)

    fireEvent.click(screen.getByTestId('table-table-csv'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const csv = invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }
    expect(csv.csv.trim().split(/\r?\n/)).toHaveLength(1 + 6000 + 1) // header + every row + totals
  })

  it('PDF under the cap has no truncation note', async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { path: '/tmp/x' } }))
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
    render(<DataTable columns={COLUMNS} rows={SMALL} exportOptions={{ title: 'Small', periodLabel: 'FY' }} />)
    fireEvent.click(screen.getByTestId('table-table-pdf'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    const pdf = invoke.mock.calls.find((c) => c[0] === 'report:pdf')![1] as { rows: unknown[]; footNote?: string }
    expect(pdf.rows).toHaveLength(4)
    expect(pdf.footNote).toBeUndefined()
  })
})
