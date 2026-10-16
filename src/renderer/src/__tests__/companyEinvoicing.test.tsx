// Review follow-up — Settings → Company details: the e-invoicing switch (meta `einvoicing`, read
// through gst:einvoicing, saved with the form through the owner-only einvoicing:set). Shown only
// to the owner (or anyone in a company without users) of a REGULAR registration.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { useNav, useSession } from '../state/stores'
import { CompanyInfoScreen } from '../screens/CompanyInfo'

const INFO: CompanyInfo = {
  name: 'Acme', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}
const invoke = vi.fn()
let enabled = true
const calls: { channel: string; payload: unknown }[] = []

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CompanyInfoScreen /></QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  calls.length = 0
  enabled = true
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'gst:einvoicing': return { ok: true, data: { enabled } }
      case 'einvoicing:set': enabled = (payload as { enabled: boolean }).enabled; return { ok: true, data: { enabled } }
      case 'gstProfile:get': return { ok: true, data: { filing: 'monthly' } }
      case 'company:updateInfo': return { ok: true, data: { ...INFO, ...(payload as object) } }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'acme', info: INFO, user: null })
    useNav.setState({ stack: [{ name: 'company-info' }] } as never)
  })
})
afterEach(() => cleanup())

describe('Company details: the e-invoicing switch', () => {
  it('shows the stored setting and saves a change with the form through einvoicing:set', async () => {
    renderScreen()
    const box = (await screen.findByTestId('input-company-einvoicing')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
    expect(calls.some((c) => c.channel === 'einvoicing:set')).toBe(false) // nothing until Save
    fireEvent.click(screen.getByText('Save details'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'einvoicing:set')?.payload).toEqual({ enabled: false }))
  })

  it('an unchanged switch sends nothing on Save', async () => {
    enabled = false
    renderScreen()
    expect(((await screen.findByTestId('input-company-einvoicing')) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByText('Save details'))
    await waitFor(() => expect(calls.some((c) => c.channel === 'company:updateInfo')).toBe(true))
    expect(calls.some((c) => c.channel === 'einvoicing:set')).toBe(false)
  })

  it('is not shown for a composition business or to a non-owner', async () => {
    act(() => useSession.setState({ info: { ...INFO, gstRegistrationType: 'composition' } }))
    renderScreen()
    await screen.findByText('Save details')
    expect(screen.queryByTestId('input-company-einvoicing')).toBeNull()
    cleanup()
    act(() => useSession.setState({ info: INFO, user: { id: 2, name: 'Asha', role: 'accountant' } as never }))
    renderScreen()
    await screen.findByText('Save details')
    expect(screen.queryByTestId('input-company-einvoicing')).toBeNull()
    expect(calls.some((c) => c.channel === 'gst:einvoicing')).toBe(false)
  })
})
