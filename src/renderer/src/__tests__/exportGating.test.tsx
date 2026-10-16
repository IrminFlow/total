// #148 (PR #144 gap): every export button a canExport-refused sign-in would be refused by main is
// hidden or disabled with the plain reason up front — payroll's PF ECR / ESI / PT files, the
// statement PDF, Form 24Q's CSV, the simple Taxes "prepare the files" step. Owners and unflagged
// users see what they saw before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSession } from '../state/stores'
import type { SessionUser } from '../lib/client'
import { PtSummaryModal, RunActions } from '../screens/Payroll'
import { StatementModal } from '../components/receivables/StatementModal'
import { Form24qPanel } from '../screens/tds/Form24qPanel'

const REASON = 'Your sign-in can’t export — ask the owner'
const user = (role: SessionUser['role'], capabilities: SessionUser['capabilities'] = null): SessionUser => ({ id: 2, name: 'Asha', role, capabilities })
const signIn = (u: SessionUser | null): void =>
  act(() => useSession.setState({ slug: 'sharma', user: u, from: '2026-04-01', to: '2027-03-31' } as never))
const REFUSED = user('accountant', { canExport: false })

const RUN = { id: 7, month: '2026-09', voucherId: 11, createdAt: '2026-09-30', pfAdminTopUp: 0, lines: [] }

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  window.total = {
    platform: 'test',
    invoke: vi.fn(async (channel: string) => {
      switch (channel) {
        case 'payroll:ptSummary': return { ok: true, data: [{ state: 'MH', employees: 2, gross: 50_000_00, pt: 400_00 }] }
        case 'tds:form24q': return { ok: true, data: { deductees: [{ entryId: 1, employeeId: 1, name: 'Asha', challanSerial: 1 }], employees: [] } }
        case 'receivables:statement': return { ok: true, data: null }
        default: return { ok: true, data: null }
      }
    })
  } as never
})
afterEach(() => {
  cleanup()
  act(() => useSession.setState({ slug: null, user: null }))
})

describe('payroll upload files (PF ECR / ESI / PT)', () => {
  it('an owner and an unflagged accountant keep PF ECR and ESI CSV', () => {
    for (const u of [null, user('owner', { canExport: false }), user('accountant')]) {
      signIn(u)
      renderUi(<RunActions run={RUN as never} onPt={() => undefined} />)
      expect(screen.queryByTestId('btn-payroll-ecr'), JSON.stringify(u)).not.toBeNull()
      expect(screen.queryByTestId('btn-payroll-esi')).not.toBeNull()
      expect(screen.queryByTestId('payroll-export-refused')).toBeNull()
      cleanup()
    }
  })

  it('a sign-in refused export gets the plain reason instead (the PT summary still opens)', () => {
    signIn(REFUSED)
    renderUi(<RunActions run={RUN as never} onPt={() => undefined} />)
    expect(screen.queryByTestId('btn-payroll-ecr')).toBeNull()
    expect(screen.queryByTestId('btn-payroll-esi')).toBeNull()
    expect(screen.getByTestId('payroll-export-refused').getAttribute('title')).toBe(REASON)
    expect(screen.queryByTestId('btn-payroll-pt')).not.toBeNull()
  })

  it('the PT summary: state returns hidden and the PT CSV disabled with the reason', async () => {
    signIn(REFUSED)
    renderUi(<PtSummaryModal run={RUN as never} onClose={() => undefined} />)
    const btn = (await screen.findByTestId('btn-payroll-pt-csv')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.parentElement?.getAttribute('title')).toBe(REASON)
    expect(screen.queryByTestId('btn-payroll-pt-state-MH')).toBeNull()
    cleanup()
    signIn(user('accountant'))
    renderUi(<PtSummaryModal run={RUN as never} onClose={() => undefined} />)
    expect(((await screen.findByTestId('btn-payroll-pt-csv')) as HTMLButtonElement).disabled).toBe(false)
    await waitFor(() => expect(screen.queryByTestId('btn-payroll-pt-state-MH')).not.toBeNull())
  })
})

describe('other export buttons', () => {
  it('Form 24Q CSV is disabled with the reason', async () => {
    signIn(REFUSED)
    renderUi(<Form24qPanel fyStartYear={2026} quarter={2} label="Q2" />)
    const btn = (await screen.findByTestId('btn-tds-24q-export')) as HTMLButtonElement
    await waitFor(() => expect(btn.parentElement?.getAttribute('title')).toBe(REASON))
    expect(btn.disabled).toBe(true)
  })

  it('the statement of account: Save PDF and Email are disabled with the reason', () => {
    signIn(REFUSED)
    renderUi(<StatementModal ledgerId={3} name="Ramesh" onClose={() => undefined} />)
    for (const id of ['btn-statement-pdf', 'btn-statement-email']) {
      const btn = screen.getByTestId(id) as HTMLButtonElement
      expect(btn.disabled, id).toBe(true)
      expect(btn.parentElement?.getAttribute('title'), id).toBe(REASON)
    }
  })
})
