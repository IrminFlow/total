// WP 8.5: errors sit under their field (aria-describedby, announced) and go once the field
// changes; a save error is placed by the shared mapping; toasts close with the dialog / screen
// that raised them; the save card shows the figures main computed and undoes as a group.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { Field, Modal, TextInput, useFormErrors, type ErrorShell } from '../components/ui'
import { IpcError } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { SaveCard } from '../simple/SaveCard'
import { translator } from '@shared/i18n'
import type { SaveSummary } from '@shared/simple/saveCard'

const t = translator('en')
const ACCOUNTANT: ErrorShell = { simple: false, t }
const SIMPLE: ErrorShell = { simple: true, t }

function Form({ shell, onGeneral }: { shell: ErrorShell; onGeneral?: (g: string | null) => void }): React.JSX.Element {
  const [party, setParty] = useState('')
  const [date, setDate] = useState('2026-10-13')
  const errors = useFormErrors({ party, date }, shell)
  return (
    <div>
      <Field label="Party" name="party" error={errors.get('party')}>
        <TextInput data-testid="party" value={party} onChange={(e) => setParty(e.target.value)} />
      </Field>
      <Field label="Date" name="date" error={errors.get('date')}>
        <TextInput data-testid="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <button data-testid="missing" onClick={() => errors.set('party', 'Pick the party account first')}>
        missing
      </button>
      <button
        data-testid="server"
        onClick={() =>
          onGeneral?.(
            errors.apply(
              new IpcError({
                error: 'Books are locked up to 2026-06-30',
                code: 'books_locked',
                field: 'date',
                params: { date: '30/06/2026' }
              })
            ).general
          )
        }
      >
        server
      </button>
      <button
        data-testid="unplaced"
        onClick={() => onGeneral?.(errors.apply(new IpcError({ error: 'Voucher not found', code: 'voucher_not_found' })).general)}
      >
        unplaced
      </button>
    </div>
  )
}

beforeEach(() => {
  act(() => {
    useToasts.setState({ toasts: [] })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

describe('Field error slot + useFormErrors', () => {
  it('shows the message under its field, wired by aria-describedby, and clears it when the field changes', () => {
    render(<Form shell={ACCOUNTANT} />)
    fireEvent.click(screen.getByTestId('missing'))
    const msg = screen.getByTestId('field-error-party')
    expect(msg.textContent).toBe('Pick the party account first')
    const input = screen.getByTestId('party')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(msg.id)
    fireEvent.change(input, { target: { value: 'Ramesh' } })
    expect(screen.queryByTestId('field-error-party')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('places a structured save error under its field — accountant wording unchanged, simple wording plain', () => {
    const general = vi.fn()
    const { unmount } = render(<Form shell={ACCOUNTANT} onGeneral={general} />)
    fireEvent.click(screen.getByTestId('server'))
    expect(screen.getByTestId('field-error-date').textContent).toBe('Books are locked up to 2026-06-30')
    expect(general).toHaveBeenLastCalledWith(null) // nothing left for a toast
    unmount()
    render(<Form shell={SIMPLE} onGeneral={general} />)
    fireEvent.click(screen.getByTestId('server'))
    expect(screen.getByTestId('field-error-date').textContent).toBe('Entries up to 30/06/2026 are locked. Pick a later date or ask the owner to unlock.')
    fireEvent.change(screen.getByTestId('date'), { target: { value: '2026-07-01' } })
    expect(screen.queryByTestId('field-error-date')).toBeNull()
  })

  it('an error with no field on the form comes back as the form message', () => {
    const general = vi.fn()
    render(<Form shell={ACCOUNTANT} onGeneral={general} />)
    fireEvent.click(screen.getByTestId('unplaced'))
    expect(general).toHaveBeenLastCalledWith('Voucher not found')
    expect(document.querySelector('[data-field-error]')).toBeNull()
  })
})

describe('toast lifetime', () => {
  function Dialog({ onClose }: { onClose: () => void }): React.JSX.Element {
    return (
      <Modal title="New ledger" onClose={onClose}>
        <button data-testid="raise" onClick={() => useToasts.getState().push('error', 'A GSTIN has 15 characters')}>
          raise
        </button>
      </Modal>
    )
  }
  function Host(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return open ? <Dialog onClose={() => setOpen(false)} /> : <p data-testid="closed">closed</p>
  }

  it('an error raised in a dialog closes with the dialog; a confirmation keeps its timer', () => {
    render(<Host />)
    fireEvent.click(screen.getByTestId('raise'))
    act(() => useToasts.getState().push('success', 'Ledger created'))
    expect(useToasts.getState().toasts.map((x) => x.text)).toEqual(['A GSTIN has 15 characters', 'Ledger created'])
    fireEvent.click(screen.getByTestId('modal-close'))
    expect(screen.getByTestId('closed')).toBeTruthy()
    expect(useToasts.getState().toasts.map((x) => x.text)).toEqual(['Ledger created'])
  })

  it('an error raised on a screen closes when the screen changes', () => {
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'daybook' }] }))
    act(() => useToasts.getState().push('error', 'Pick the party account first'))
    expect(useToasts.getState().toasts).toHaveLength(1)
    act(() => useNav.getState().replace({ name: 'trial-balance' }))
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})

describe('SaveCard', () => {
  const summary = (undo: SaveSummary['undo']): SaveSummary => ({
    entries: [
      { voucherId: 11, kind: 'sales', number: 'S/1', date: '2026-10-13', amount: 118000, money: null },
      { voucherId: 12, kind: 'receipt', number: 'R/1', date: '2026-10-13', amount: 50000, money: { name: 'UPI', isCash: false, amount: 50000 } }
    ],
    party: { ledgerId: 5, name: 'Ramesh', side: 'customer', balance: 68000 },
    undo
  })
  const invoke = vi.fn()
  let current: SaveSummary
  beforeEach(() => {
    current = summary({ undoable: true, reason: null })
    invoke.mockReset()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'voucher:saveSummary') return { ok: true, data: current }
      if (channel === 'voucher:undoSave') return { ok: true, data: { groupId: 1, binned: [11, 12] } }
      return { ok: false, error: `unmocked ${channel}` }
    })
    window.total = { platform: 'test', invoke } as unknown as typeof window.total
  })
  const wrap = (ui: React.JSX.Element): React.JSX.Element => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
  )

  it('says what was saved with the figures from main, and Undo bins the group', async () => {
    const onUndone = vi.fn()
    render(wrap(<SaveCard voucherIds={[11, 12]} onNew={vi.fn()} onEdit={vi.fn()} onUndone={onUndone} />))
    await waitFor(() =>
      expect(screen.getByTestId('save-card-text').textContent).toBe('Bill ₹1,180.00 saved. Received ₹500.00 into UPI. Ramesh still owes ₹680.00.')
    )
    expect(invoke).toHaveBeenCalledWith('voucher:saveSummary', { voucherIds: [11, 12] })
    fireEvent.click(screen.getByTestId('btn-save-card-undo'))
    await waitFor(() => expect(screen.getByTestId('save-card-undone')).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith('voucher:undoSave', { voucherIds: [11, 12] })
    expect(onUndone).toHaveBeenCalled()
  })

  it('once edited since the save it offers "Edit instead", not Undo', async () => {
    current = summary({ undoable: false, reason: 'edited' })
    const onEdit = vi.fn()
    render(wrap(<SaveCard voucherIds={[11, 12]} onNew={vi.fn()} onEdit={onEdit} />))
    await waitFor(() => expect(screen.getByTestId('save-card-edited')).toBeTruthy())
    expect(screen.queryByTestId('btn-save-card-undo')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-save-card-edit'))
    expect(onEdit).toHaveBeenCalledWith(11)
  })

  it('a refused undo is told on the card in plain words (Details keeps the technical text)', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'voucher:saveSummary') return { ok: true, data: current }
      return { ok: false, error: 'Books are locked up to 2026-06-30', code: 'books_locked', field: 'date', params: { date: '30/06/2026' } }
    })
    render(wrap(<SaveCard voucherIds={[11, 12]} onNew={vi.fn()} onEdit={vi.fn()} />))
    await waitFor(() => expect((screen.getByTestId('btn-save-card-undo') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('btn-save-card-undo'))
    await waitFor(() => expect(screen.getByTestId('save-card-error')).toBeTruthy())
    expect(screen.getByTestId('save-card-error').textContent).toContain('Entries up to 30/06/2026 are locked.')
    expect(screen.getByTestId('save-card-error').textContent).toContain('Books are locked up to 2026-06-30')
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})
