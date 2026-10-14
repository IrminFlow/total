// WP 10.4: the shared kit's own words (DataTable toolbar / empty states, dialog chrome, input
// hints) follow the reader's language inside the simple shell, and stay the literal English of
// the full app outside it — whatever language is picked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataTable, defineColumns } from '../components/table'
import { AmountInput, Modal } from '../components/ui'
import { LANGUAGE_KEY } from '../lib/i18n'
import { SimpleKitLabels } from '../simple/kitLabels'
import { useSession } from '../state/stores'

interface Row {
  id: number
  name: string
  amount: number
}
const COLUMNS = defineColumns<Row>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount }
])
const ROWS: Row[] = [
  { id: 1, name: 'Ramesh', amount: 150000 },
  { id: 2, name: 'Suresh', amount: 2500 }
]

function Screen({ simple }: { simple: boolean }): React.JSX.Element {
  return (
    <SimpleKitLabels on={simple}>
      <DataTable rows={ROWS} columns={COLUMNS} testId="people" />
      <DataTable rows={[] as Row[]} columns={COLUMNS} testId="empty" />
      <AmountInput paise={null} onPaise={() => undefined} testId="input-x" />
      <Modal title="T" onClose={() => undefined}>
        <p>body</p>
      </Modal>
    </SimpleKitLabels>
  )
}

beforeEach(() => {
  localStorage.clear()
  act(() => useSession.setState({ slug: null, user: null }))
})
afterEach(() => cleanup())

describe('kit labels (WP 10.4)', () => {
  it('in the simple shell, Hindi: the table chrome, empty state, input hint and dialog close are Hindi', () => {
    localStorage.setItem(LANGUAGE_KEY, 'hi')
    render(<Screen simple />)
    expect(screen.getByTestId('people-table-count').textContent).toBe('2 पंक्तियाँ')
    expect(screen.getByTestId('people-table-quick').getAttribute('placeholder')).toBe('इसमें खोजें…')
    expect(screen.getByText('दिखाने को कुछ नहीं')).toBeTruthy()
    expect(screen.getByTestId('modal-close').getAttribute('aria-label')).toBe('बंद करें')
    fireEvent.change(screen.getByTestId('input-x'), { target: { value: 'abc' } })
    expect(screen.getByText('यह रकम नहीं है')).toBeTruthy()
    // A filter that hides every row says so in Hindi.
    fireEvent.change(screen.getByTestId('people-table-quick'), { target: { value: 'zzz' } })
    expect(screen.getByText('कोई पंक्ति नहीं मिली')).toBeTruthy()
  })

  it('in the simple shell, Hinglish', () => {
    localStorage.setItem(LANGUAGE_KEY, 'hinglish')
    render(<Screen simple />)
    expect(screen.getByTestId('people-table-count').textContent).toBe('2 rows')
    expect(screen.getByTestId('people-table-quick').getAttribute('placeholder')).toBe('Isme dhoondhein…')
    expect(screen.getByText('Dikhane ko kuch nahi')).toBeTruthy()
  })

  it('in the full app the kit stays English even with Hindi picked', () => {
    localStorage.setItem(LANGUAGE_KEY, 'hi')
    render(<Screen simple={false} />)
    expect(screen.getByTestId('people-table-count').textContent).toBe('2 rows')
    expect(screen.getByTestId('people-table-quick').getAttribute('placeholder')).toBe('Filter rows…')
    expect(screen.getByText('Nothing to show')).toBeTruthy()
    expect(screen.getByTestId('modal-close').getAttribute('aria-label')).toBe('Close')
    fireEvent.change(screen.getByTestId('input-x'), { target: { value: 'abc' } })
    expect(screen.getByText('Not an amount')).toBeTruthy()
  })

  it('English simple shell reads exactly like the full app', () => {
    render(<Screen simple />)
    expect(screen.getByTestId('people-table-count').textContent).toBe('2 rows')
    expect(screen.getByTestId('people-table-quick').getAttribute('placeholder')).toBe('Filter rows…')
    expect(screen.getByText('Nothing to show')).toBeTruthy()
    expect(screen.getByTestId('modal-close').getAttribute('aria-label')).toBe('Close')
  })
})
