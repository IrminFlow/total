// WP 1.10c — Settings → Invoice templates. The mocked template:previewHtml channel runs the REAL
// shared renderer on the sample document, so these tests see the same HTML the PDFs would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  BUILT_IN_DEFAULTS,
  PRINT_DOC_KINDS,
  type PrintDocKind,
  type PrintTemplate,
  type TemplateList
} from '@shared/printTemplates'
import { renderDocument } from '@shared/print/render'
import { sampleDocument } from '@shared/print/sample'
import type { CompanyInfo } from '@shared/domain'
import { useSession } from '../state/stores'
import { TemplateDesigner } from '../screens/settings/invoice/TemplateDesigner'
import { moveItem } from '../screens/settings/invoice/ColumnsEditor'

const COMPANY: CompanyInfo = {
  name: 'Designer Co', stateCode: '27', gstin: '27AAAAA0000A1Z5', gstRegistrationType: 'regular', address: 'Pune',
  booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}

const invoke = vi.fn()
let store: Record<string, PrintTemplate>
let defaults: Record<PrintDocKind, string>
const calls: { channel: string; payload: unknown }[] = []

function listing(): TemplateList {
  return {
    templates: Object.values(store).map((t) => ({ id: t.id, name: t.name, builtIn: t.builtIn, style: t.style, kinds: t.kinds, customised: false })),
    defaults
  }
}

const HANDLERS: Record<string, (p: any) => unknown> = {
  'template:list': () => listing(),
  'template:get': (p: { id: string }) => store[p.id],
  'template:save': (p: { template: PrintTemplate }) => (store[p.template.id] = p.template),
  'template:setDefault': (p: { kind: PrintDocKind; id: string }) => {
    defaults = { ...defaults, [p.kind]: p.id }
    return listing()
  },
  'template:previewHtml': (p: { template: PrintTemplate; kind?: PrintDocKind }) => ({
    html: renderDocument(p.template, sampleDocument(COMPANY, p.kind ?? 'sales'))
  })
}

function renderDesigner(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TemplateDesigner />
    </QueryClientProvider>
  )
}

const previewHtml = (): string => screen.getByTestId('settings-tpl-preview').querySelector('iframe')?.getAttribute('srcdoc') ?? ''
/** Column header texts of the preview's line-item table, in order. */
function previewHeaders(): string[] {
  const doc = new DOMParser().parseFromString(previewHtml(), 'text/html')
  return [...doc.querySelectorAll('table.items thead th')].map((th) => th.textContent ?? '')
}
const columnOrder = (): string[] =>
  [...screen.getByTestId('rows-settings-tpl-columns').querySelectorAll('tr')].map((tr) => tr.getAttribute('data-col') ?? '')

beforeEach(() => {
  store = Object.fromEntries(Object.values(BUILT_IN_DEFAULTS).map((t) => [t.id, structuredClone(t)]))
  defaults = Object.fromEntries(PRINT_DOC_KINDS.map((k) => [k, 'classic'])) as Record<PrintDocKind, string>
  calls.length = 0
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    const h = HANDLERS[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'designer-co', user: null })
  })
})
afterEach(() => cleanup())

describe('template designer', () => {
  it('lists the built-ins and previews Classic with the real renderer', async () => {
    renderDesigner()
    const list = await screen.findByTestId('rows-settings-tpl-list')
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(4)) // + Receipt 80mm (WP 2.6)
    await waitFor(() => expect(previewHtml()).toContain('TAX INVOICE'), { timeout: 2000 })
    expect(previewHtml()).toContain('INV-SAMPLE-1')
    expect(list.querySelector('[data-row-id="classic"]')?.getAttribute('aria-current')).toBe('true')
  })

  it('editing a title updates the live preview before saving, then Save persists it', async () => {
    renderDesigner()
    await waitFor(() => expect(previewHtml()).toContain('TAX INVOICE'), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('tab-settings-tpl-header'))
    fireEvent.change(screen.getByTestId('input-settings-tpl-title-sales'), { target: { value: 'BILL OF SUPPLY' } })
    await waitFor(() => expect(previewHtml()).toContain('BILL OF SUPPLY'), { timeout: 2000 })
    expect(calls.some((c) => c.channel === 'template:save')).toBe(false)
    expect(screen.getByTestId('settings-tpl-editing').textContent).toContain('unsaved')

    fireEvent.click(screen.getByTestId('btn-settings-tpl-save'))
    await waitFor(() => expect(store.classic!.header.titles.sales).toBe('BILL OF SUPPLY'))
  })

  it('reorders columns with the arrow buttons and keyboard; the preview follows', async () => {
    renderDesigner()
    await waitFor(() => expect(previewHeaders()).toEqual(['#', 'Description', 'HSN', 'Qty', 'Rate', 'GST', 'Amount']), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('tab-settings-tpl-columns'))
    // Rate up past Qty with the ▲ button.
    fireEvent.click(screen.getByTestId('btn-settings-tpl-col-up-rate'))
    expect(columnOrder().indexOf('rate')).toBeLessThan(columnOrder().indexOf('qty'))
    // Alt+↓ on the GST-rate row moves it below Taxable value.
    const gstRow = screen.getByTestId('rows-settings-tpl-columns').querySelector('tr[data-col="gstRate"]')!
    fireEvent.keyDown(gstRow, { key: 'ArrowDown', altKey: true })
    expect(columnOrder().indexOf('gstRate')).toBe(columnOrder().indexOf('taxable') + 1)
    // Hide HSN.
    fireEvent.click(screen.getByTestId('input-settings-tpl-col-hsn'))
    await waitFor(() => expect(previewHeaders()).toEqual(['#', 'Description', 'Rate', 'Qty', 'Amount', 'GST']), { timeout: 2000 })
  })

  it('sets a template as the default for a document kind', async () => {
    renderDesigner()
    const list = await screen.findByTestId('rows-settings-tpl-list')
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(4)) // + Receipt 80mm (WP 2.6)
    fireEvent.click(list.querySelector('[data-row-id="modern"]')!)
    await waitFor(() => expect(screen.getByTestId('settings-tpl-editing').textContent).toContain('Modern'))
    const btn = await screen.findByTestId('btn-settings-tpl-default-sales')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('btn-settings-tpl-default-sales').getAttribute('aria-pressed')).toBe('true'))
    expect(calls.find((c) => c.channel === 'template:setDefault')?.payload).toEqual({ kind: 'sales', id: 'modern' })
    expect(defaults.sales).toBe('modern')
  })

  it('shows a validation error and blocks Save for a bad accent colour', async () => {
    renderDesigner()
    await waitFor(() => expect(previewHtml()).toContain('TAX INVOICE'), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('tab-settings-tpl-typography'))
    fireEvent.change(screen.getByTestId('input-settings-tpl-accent'), { target: { value: '#zzz' } })
    expect(screen.getByRole('alert').textContent).toMatch(/accent/)
    expect((screen.getByTestId('btn-settings-tpl-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('viewers can preview but not edit', async () => {
    act(() => {
      useSession.setState({ user: { id: 3, name: 'Vik', role: 'viewer' } as never })
    })
    renderDesigner()
    await waitFor(() => expect(previewHtml()).toContain('TAX INVOICE'), { timeout: 2000 })
    expect(screen.queryByTestId('btn-settings-tpl-save')).toBeNull()
    expect(screen.queryByTestId('btn-settings-tpl-duplicate')).toBeNull()
    fireEvent.click(screen.getByTestId('tab-settings-tpl-header'))
    expect((screen.getByTestId('input-settings-tpl-title-sales') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('moveItem', () => {
  it('moves within bounds and ignores out-of-range targets', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 5)).toEqual(['a', 'b', 'c'])
  })
})
