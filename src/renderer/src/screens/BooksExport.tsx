import { useState } from 'react'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Banner, Button, DrawerSection, Page, PageHeader, Panel } from '../components/ui'
import { BOOKS_SHEETS } from '@shared/dataImport/books'

/**
 * System → Export (WP 6.3): the whole company as one Excel workbook — a Manifest sheet (format,
 * version, company, books-from) and a sheet per entity, typed (₹ amounts as numbers, real dates,
 * quantities with their decimals). The same file imports back through System → Import.
 */
export function BooksExportScreen(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ path: string; counts: Record<string, number> } | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.dataImport.exportBooks()
      setDone(r)
      toast.push('success', `Saved to exports — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page width="medium">
      <PageHeader
        title="Export"
        subtitle="The whole company as one Excel workbook"
        options={{
          content: (
            <DrawerSection title="What is not in the workbook">
              <p className="text-hint text-muted">
                Links between orders, challans and invoices; cost-centre allocations; serial numbers; manufacture and job-work details;
                attachments. Every amount, quantity and opening balance is. Single reports export from their own table (Excel button).
              </p>
            </DrawerSection>
          )
        }}
      />
      <Panel className="p-6">
        <p className="text-body text-ink">One sheet per kind of record, plus a Manifest. Amounts are numbers in rupees, dates are real dates.</p>
        <ul className="mt-4 grid gap-1.5 text-body-sm sm:grid-cols-3" data-testid="export-sheet-list">
          {['Manifest', ...BOOKS_SHEETS.map((s) => s.sheet), 'GST (info)', 'Stock (info)'].map((s) => (
            <li key={s} className="flex items-center justify-between rounded border border-line px-3 py-1.5">
              <span className="text-ink">{s}</span>
              {done && done.counts[s] !== undefined && <span className="num text-muted">{done.counts[s]}</span>}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-hint text-muted">Sheets marked (info) are computed for reading and are never imported.</p>
          <Button variant="primary" data-testid="btn-export-books" loading={busy} onClick={() => void run()} className="px-6">
            {busy ? 'Exporting…' : 'Export books to Excel'}
          </Button>
        </div>
      </Panel>
      {done && (
        <Banner tone="success" className="mt-4" title="Workbook saved" testId="export-books-done" action={<Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'data-import' })}>Open Import</Button>}>
          <span className="break-all">{done.path}</span>
        </Banner>
      )}
    </Page>
  )
}
