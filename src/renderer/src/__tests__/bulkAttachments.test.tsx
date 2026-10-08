// WP 6.4 — DataTable multi-select (checkboxes, select-all in view, Shift range, Space), the Day
// book's selection bar → bulk edit preview → apply, the attachment list (add / open / remove by
// id, never a path), and party notes / tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DayBookRow } from '@shared/reports'
import type { Attachment } from '@shared/attachments'
import type { BulkResult } from '@shared/bulkEdit'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { DayBook } from '../screens/DayBook'
import { AttachmentList } from '../components/attachments/Attachments'
import { PartyNotesPanel } from '../components/partyNotes/PartyNotes'
import { DialogHost } from '../components/dialogs'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const SLOW = { timeout: 4000 }

const DAYBOOK: DayBookRow[] = [1, 2, 3].map((n) => ({
  voucherId: 10 + n, date: `2026-04-0${n}`, voucherType: 'Journal', kind: 'journal', number: String(n), account: `Rent ${n}`, accountLedgerId: 30 + n,
  narration: `Rent ${n}`, debit: 1000 * n, credit: 0, isOptional: false, postDated: false
}))

const PREVIEW: BulkResult = {
  batchId: null, summary: '2 vouchers: narration append “(ok)”', applied: 1, refused: 1, unchanged: 0,
  records: [
    { entity: 'voucher', id: 11, label: 'Journal 1 · 2026-04-01', status: 'applied', reason: null, before: 'Rent 1', after: 'Rent 1 (ok)', warnings: ['Renumbered 1 → 4'] },
    { entity: 'voucher', id: 12, label: 'Journal 2 · 2026-04-02', status: 'refused', reason: 'Books are locked up to 2026-04-02', before: 'Rent 2', after: 'Rent 2 (ok)', warnings: [] }
  ]
}

const FILES: Attachment[] = [
  { id: 7, entity: 'voucher', entityId: 11, fileName: 'bill.pdf', mime: 'application/pdf', size: 20480, sha256: 'a'.repeat(64), addedBy: 'os:priya', addedAt: '2026-04-03 10:00:00' },
  { id: 8, entity: 'voucher', entityId: 11, fileName: 'photo.jpg', mime: 'image/jpeg', size: 512, sha256: 'b'.repeat(64), addedBy: 'Priya', addedAt: '2026-04-04 10:00:00' }
]

beforeEach(() => {
  localStorage.clear()
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'report:dayBook': return { ok: true, data: DAYBOOK }
      case 'attachments:counts': return { ok: true, data: { 11: 2 } }
      case 'attachments:list': return { ok: true, data: FILES }
      case 'attachments:add': return { ok: true, data: { added: [FILES[0]], refused: [{ fileName: 'x.exe', reason: '.exe can’t be attached' }] } }
      case 'attachments:open': return { ok: true, data: null }
      case 'attachments:remove': return { ok: true, data: null }
      case 'bulk:preview': return { ok: true, data: PREVIEW }
      case 'bulk:apply': return { ok: true, data: { ...PREVIEW, batchId: 4 } }
      case 'bulk:list': return { ok: true, data: [] }
      case 'partyNotes:list':
        return {
          ok: true,
          data: (payload as { includeDone?: boolean }).includeDone
            ? [{ id: 2, ledgerId: 31, ledgerName: 'Zeta', kind: 'task', text: 'Old call', dueDate: '2026-04-01', doneAt: '2026-04-02 09:00:00', createdBy: 'x', createdAt: '' }]
            : [{ id: 1, ledgerId: 31, ledgerName: 'Zeta', kind: 'task', text: 'Call about March', dueDate: '2000-01-01', doneAt: null, createdBy: 'x', createdAt: '' }]
        }
      case 'partyNotes:add': return { ok: true, data: { id: 3, ...(payload as object) } }
      case 'partyNotes:update': return { ok: true, data: { id: 1 } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha-co', from: '2026-04-01', to: '2027-03-31', user: null, workingDate: '2026-04-10' })
    useNav.setState({ go: vi.fn(), stack: [{ name: 'daybook' }] })
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

interface R { id: number; name: string }
const COLS = defineColumns<R>([{ id: 'name', header: 'Name', kind: 'text', value: (r) => r.name }])
const ROWS: R[] = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => ({ id: i + 1, name }))

function Selectable({ onSel }: { onSel: (s: Set<RowKey>) => void }): React.JSX.Element {
  const [sel, setSel] = useState<Set<RowKey>>(new Set())
  return (
    <DataTable
      testId="t"
      columns={COLS}
      rows={ROWS}
      rowKey={(r) => r.id}
      selection={{
        selected: sel,
        onChange: (n) => {
          setSel(n)
          onSel(n)
        },
        isSelectable: (r) => r.name !== 'Delta'
      }}
    />
  )
}

describe('DataTable multi-select', () => {
  it('checkboxes, select-all in view (skipping unselectable rows), Shift range and Space', () => {
    const onSel = vi.fn()
    render(<Selectable onSel={onSel} />)
    const last = (): number[] => [...(onSel.mock.calls.at(-1)![0] as Set<number>)].sort()
    fireEvent.click(screen.getByTestId('t-select-1'))
    expect(last()).toEqual([1])
    expect(screen.getByTestId('t-select-1').closest('tr')!.hasAttribute('data-selected')).toBe(true)
    fireEvent.click(screen.getByTestId('t-select-3'), { shiftKey: true })
    expect(last()).toEqual([1, 2, 3])
    expect((screen.getByTestId('t-select-4') as HTMLInputElement).disabled).toBe(true)
    // All selectable rows in view are selected → the header box clears them.
    const all = screen.getByTestId('t-select-all') as HTMLInputElement
    expect(all.checked).toBe(true)
    fireEvent.click(all)
    expect(last()).toEqual([])
    fireEvent.click(all)
    expect(last()).toEqual([1, 2, 3])
    // Space toggles the active (first) row.
    fireEvent.keyDown(window, { key: ' ' })
    expect(last()).toEqual([2, 3])
    expect((screen.getByTestId('t-select-all') as HTMLInputElement).indeterminate).toBe(true)
  })
})

describe('Day book bulk edit', () => {
  it('select → bar → change → server preview → apply', async () => {
    wrap(<DayBook />)
    await waitFor(() => expect(screen.getByTestId('rows-daybook').querySelectorAll('tr.dt-row')).toHaveLength(3), SLOW)
    expect(screen.queryByTestId('daybook-bulkbar')).toBeNull()
    fireEvent.click(screen.getByTestId('daybook-select-11'))
    fireEvent.click(screen.getByTestId('daybook-select-12'))
    expect(screen.getByTestId('daybook-bulk-count').textContent).toBe('2 vouchers selected')
    fireEvent.click(screen.getByTestId('daybook-bulk-edit'))
    const modal = await screen.findByTestId('bulk-modal')
    expect((within(modal).getByTestId('bulk-apply') as HTMLButtonElement).disabled).toBe(true) // preview first
    fireEvent.change(within(modal).getByTestId('bulk-narration-text'), { target: { value: '(ok)' } })
    fireEvent.click(within(modal).getByTestId('bulk-preview-run'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('bulk:preview', { target: 'voucher', ids: [11, 12], change: { field: 'narration', mode: 'append', text: '(ok)' }, scope: { from: '2026-04-01', to: '2027-03-31' } })
    )
    const rows = await screen.findByTestId('rows-bulk-preview')
    expect(rows.textContent).toContain('Books are locked up to 2026-04-02')
    expect(rows.textContent).toContain('Rent 1 → Rent 1 (ok) · Renumbered 1 → 4')
    expect(screen.getByTestId('bulk-preview-summary').textContent).toContain('1 will change')
    fireEvent.click(screen.getByTestId('bulk-apply'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('bulk:apply', expect.objectContaining({ ids: [11, 12] })))
    await waitFor(() => expect(screen.queryByTestId('bulk-modal')).toBeNull())
    expect(screen.queryByTestId('daybook-bulkbar')).toBeNull() // selection cleared
    // The row's Files action shows its count.
    expect(within(screen.getByTestId('rows-daybook')).getAllByTestId('btn-daybook-files')[0]!.textContent).toBe('Files · 2')
  })
})

describe('Attachment list', () => {
  it('lists files, adds through the main-process picker, opens and removes by id', async () => {
    wrap(<AttachmentList target={{ entity: 'voucher', entityId: 11 }} />)
    const rows = await screen.findByTestId('rows-attachments')
    await waitFor(() => expect(rows.querySelectorAll('tr.dt-row')).toHaveLength(2))
    expect(rows.textContent).toContain('bill.pdf')
    expect(rows.textContent).toContain('20 KB')
    fireEvent.click(screen.getByTestId('btn-attachment-add'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('attachments:add', { entity: 'voucher', entityId: 11 }))
    fireEvent.click(within(rows).getAllByTestId('btn-attachment-open')[1]!)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('attachments:open', { id: 8 }))
    fireEvent.click(within(rows).getAllByTestId('btn-attachment-remove')[0]!)
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('attachments:remove', { id: 7 }))
    // Nothing the renderer sends ever carries a path.
    for (const [, p] of invoke.mock.calls) expect(JSON.stringify(p ?? {})).not.toMatch(/\//)
  })
})

describe('Party notes and tasks', () => {
  it('shows open tasks, adds one with a due date, marks done, and Show done reloads', async () => {
    const onShowDone = vi.fn()
    wrap(<PartyNotesPanel ledgerId={31} showDone={false} onShowDone={onShowDone} testId="ln" />)
    const rows = await screen.findByTestId('rows-ln')
    await waitFor(() => expect(rows.textContent).toContain('Call about March'))
    expect(rows.textContent).toContain('Overdue')
    fireEvent.change(screen.getByTestId('ln-kind'), { target: { value: 'task' } })
    fireEvent.change(screen.getByTestId('ln-text'), { target: { value: 'Collect cheque' } })
    fireEvent.click(screen.getByTestId('ln-add'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('partyNotes:add', { ledgerId: 31, kind: 'task', text: 'Collect cheque', dueDate: null }))
    fireEvent.click(within(rows).getByTestId('btn-note-done'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('partyNotes:update', { id: 1, done: true }))
    fireEvent.click(screen.getByTestId('ln-show-done'))
    expect(onShowDone).toHaveBeenCalledWith(true)
  })
})
