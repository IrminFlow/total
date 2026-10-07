import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Badge, Banner, Button, DrawerSection, Modal, Page, PageHeader, Panel, Select, TabBar } from '../components/ui'
import { SelfInvoiceOptions, SelfInvoicesTab } from './gst/SelfInvoicesTab'
import { OptionsExport, OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import type { EdocListRow } from '@shared/reports'
import { gstPeriodOf, toDisplayDate } from '@shared/dates'
import { TransportModal } from './voucher/TransportModal'
import { LedgerLink } from '../components/links'

type DocTypeFilter = 'all' | 'INV' | 'CRN' | 'DBN'

const DOC_TYPE_FILTERS: { value: DocTypeFilter; label: string }[] = [
  { value: 'all', label: 'All documents' },
  { value: 'INV', label: 'Invoices' },
  { value: 'CRN', label: 'Credit notes' },
  { value: 'DBN', label: 'Debit notes' }
]

const DOC_TYPE_CLASS: Record<'INV' | 'CRN' | 'DBN', string> = {
  INV: 'text-muted',
  CRN: 'text-dr',
  DBN: 'text-cr'
}

const DOC_TYPE_TITLE: Record<EdocListRow['docType'], string> = {
  INV: 'Invoice',
  CRN: 'Credit note',
  DBN: 'Debit note'
}

const irnEwbText = (r: EdocListRow): string => `${r.irn ? 'IRN ✓' : 'no IRN'} · ${r.ewbNo ?? 'no EWB'}`

export const EDOC_COLUMNS = defineColumns<EdocListRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'number',
    header: 'No.',
    kind: 'text',
    value: (r) => r.number,
    hideable: false,
    groupable: false,
    width: 84,
    cell: (r) => (
      <span className="num">
        {r.number}
        {!r.hasHsn && (
          <span className="ml-1 text-amber" title="No stock item on this document carries an HSN code — e-invoice/EWB JSON will be rejected. Set HSN on the items (Masters → Items).">
            ⚠
          </span>
        )}
      </span>
    )
  },
  {
    id: 'type',
    header: 'Type',
    kind: 'enum',
    value: (r) => r.docType,
    options: [
      { value: 'INV', label: 'INV' },
      { value: 'CRN', label: 'CRN' },
      { value: 'DBN', label: 'DBN' }
    ],
    text: (r) => (r.outwardDbn ? `${r.docType} (OTH)` : r.docType),
    width: 76,
    cell: (r) => (
      <>
        <span
          className={`inline-block rounded border border-line px-1.5 py-0.5 text-label font-medium ${DOC_TYPE_CLASS[r.docType]}`}
          title={DOC_TYPE_TITLE[r.docType]}
        >
          {r.docType}
        </span>
        {r.outwardDbn && (
          <span
            className="ml-1 inline-block rounded border border-amber/50 bg-amberbar/10 px-1.5 py-0.5 text-label font-medium text-amber"
            title="Outward debit note — the NIC bulk docType enum has no DBN, so it exports as 'OTH'."
          >
            OTH
          </span>
        )}
      </>
    )
  },
  {
    id: 'buyer',
    header: 'Buyer',
    kind: 'text',
    value: (r) => r.partyName ?? 'Cash sale',
    minWidth: 130,
    // The row opens the voucher; the buyer NAME opens the party ledger's edit window.
    cell: (r) => (r.partyName ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> : 'Cash sale')
  },
  {
    id: 'gstin',
    header: 'GSTIN',
    kind: 'text',
    value: (r) => r.partyGstin,
    text: (r) => r.partyGstin ?? '—',
    className: 'num text-muted',
    width: 146
  },
  { id: 'value', header: 'Value', kind: 'money', value: (r) => r.total, width: 116, aggregate: 'sum' },
  {
    id: 'irnEwb',
    header: 'IRN / EWB',
    kind: 'text',
    value: irnEwbText,
    width: 124,
    cell: (r) => (
      <span className="text-hint">
        {r.irn ? <span className="text-dr" title={r.irn}>IRN ✓</span> : <span className="text-muted">no IRN</span>}
        {' · '}
        {r.ewbNo ? <span className="num text-dr">{r.ewbNo}</span> : <span className="text-muted">no EWB</span>}
      </span>
    )
  },
  {
    id: 'ewbEligibility',
    header: 'EWB eligibility',
    kind: 'text',
    value: (r) => r.ewbReason ?? 'Eligible',
    width: 140,
    cell: (r) =>
      r.ewbReason == null ? (
        <span className="text-hint text-dr">Eligible</span>
      ) : (
        <span className="text-hint text-muted" title={r.ewbReason}>
          {r.ewbReason}
        </span>
      )
  }
])

/** Per-session "don't ask again" for the live-API confirm gate — module-level so it survives
 *  remounts of this screen but resets on app restart (never persisted to disk). */
let liveApiConfirmed = false

export type EdocsTab = 'documents' | 'self-invoices'

/** The e-documents tab row (WP 3.4 added RCM self-invoices); the active tab lives in the nav
 *  stack like Masters / Settings. */
function EdocsTabs({ active }: { active: EdocsTab }): React.JSX.Element {
  const nav = useNav()
  return (
    <TabBar
      screen="edocs"
      label="e-Documents views"
      tabs={[
        { id: 'documents', label: 'e-Invoice & e-Way bill' },
        { id: 'self-invoices', label: 'RCM self-invoices' }
      ]}
      active={active}
      onSelect={(t) => {
        if (t !== active) nav.go({ name: 'edocs', tab: t as EdocsTab })
      }}
    />
  )
}

export function EdocsScreen({ tab = 'documents' }: { tab?: EdocsTab }): React.JSX.Element {
  return tab === 'self-invoices' ? <SelfInvoicesPage /> : <EdocsDocuments />
}

function SelfInvoicesPage(): React.JSX.Element {
  const { from, to } = useSession()
  return (
    <Page width="wide">
      <PageHeader
        title="e-Documents · RCM self-invoices"
        period={`${toDisplayDate(from)} → ${toDisplayDate(to)}`}
        tabs={<EdocsTabs active="self-invoices" />}
        options={{
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area="self-invoices" label="Self-invoices table" />
              <SelfInvoiceOptions />
            </>
          )
        }}
      />
      <Panel>
        <SelfInvoicesTab from={from} to={to} />
      </Panel>
    </Page>
  )
}

function EdocsDocuments(): React.JSX.Element {
  const { from, to, info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['edocList', from, to], queryFn: () => api.edoc.list(from, to) })
  const { data: nicStatus } = useQuery({ queryKey: ['nicStatus'], queryFn: api.nic.status })
  const [busy, setBusy] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<{ kind: 'irn' | 'ewb'; voucherId: number } | null>(null)
  const [transportFor, setTransportFor] = useState<{ voucherId: number; number: string } | null>(null)
  const [docTypeFilter, setDocTypeFilter] = useState<DocTypeFilter>('all')
  const allRows = data ?? []
  const rows = useMemo(
    () => (docTypeFilter === 'all' ? allRows : allRows.filter((r) => r.docType === docTypeFilter)),
    [allRows, docTypeFilter]
  )
  const period = gstPeriodOf(to)
  const live = nicStatus?.configured ?? false

  const exportEinv = async (): Promise<void> => {
    try {
      const r = await api.edoc.exportEInvoice(from, to, period)
      toast.push(r.count ? 'success' : 'warning', r.count ? `${r.count} B2B invoice${r.count > 1 ? 's' : ''} written for IRN generation` : 'No B2B invoices (parties need GSTINs) in this period')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const exportEwb = async (): Promise<void> => {
    try {
      const r = await api.edoc.exportEwb(from, to, period)
      if (r.count) {
        const skipNote = r.skipped.length ? ` · ${r.skipped.length} skipped` : ''
        toast.push(
          'success',
          `${r.count} e-way bill${r.count > 1 ? 's' : ''} written — combined ${r.path.split('/').pop()} + per-bill files in ${r.dir}${skipNote}`
        )
      } else {
        const why = r.skipped.length
          ? `all ${r.skipped.length} skipped (${r.skipped[0]!.reason}${r.skipped.length > 1 ? ', …' : ''})`
          : 'no invoices in this period'
        toast.push('warning', `No e-way bills written — ${why}`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const perRowEwbJson = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.edoc.ewbJson(voucherId)
      toast.push('success', `EWB JSON written — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const requestGenerate = (kind: 'irn' | 'ewb', voucherId: number): void => {
    if (liveApiConfirmed) {
      void (kind === 'irn' ? generateIrn(voucherId) : generateEwb(voucherId))
    } else {
      setConfirming({ kind, voucherId })
    }
  }

  const generateIrn = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.nic.generateIrn(voucherId)
      toast.push('success', `IRN generated — ack ${r.ackNo}`)
      await queryClient.invalidateQueries({ queryKey: ['edocList'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const generateEwb = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.nic.generateEwb(voucherId)
      toast.push('success', `e-Way bill ${r.ewbNo} generated`)
      await queryClient.invalidateQueries({ queryKey: ['edocList'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="e-Invoice & e-Way bill"
        period={`${toDisplayDate(from)} → ${toDisplayDate(to)}`}
        tabs={<EdocsTabs active="documents" />}
        subtitle={
          <Badge tone={live ? 'success' : 'neutral'} testId="edocs-live-status">
            {live ? 'Live filing on' : 'Offline JSON'}
          </Badge>
        }
        secondary={
          <Button data-testid="btn-edocs-export-ewb" onClick={() => void exportEwb()} disabled={!info?.gstin}>
            Export e-way bill JSON
          </Button>
        }
        actions={
          <Button variant="primary" data-testid="btn-edocs-export-einvoice" onClick={() => void exportEinv()} disabled={!info?.gstin}>
            Export e-invoice JSON
          </Button>
        }
        options={{
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area="edocs" label="Documents table" />
              <OptionsExport>
                <Button size="sm" onClick={() => void exportEinv()} disabled={!info?.gstin}>
                  e-Invoice JSON
                </Button>
                <Button size="sm" onClick={() => void exportEwb()} disabled={!info?.gstin}>
                  e-Way bill JSON
                </Button>
              </OptionsExport>
              <DrawerSection title="Live filing (NIC)">
                <p className="text-hint text-muted">
                  {live ? 'NIC credentials are set — IRN and e-way bills can be generated per document.' : 'Offline mode: export JSON and upload it on the portals.'}
                </p>
                <p className="text-hint text-muted">
                  Offline route: export JSON for the government offline tools — the period export writes one combined bulk file plus a
                  per-bill file per consignment. Live route: add your NIC API credentials once, then generate IRNs and e-way bills
                  directly — needs internet and a registered API user (einvoice1.gst.gov.in → API registration) or GSP credentials.
                </p>

                <div>
                  <Button size="sm" data-testid="btn-edocs-nic-settings" onClick={() => nav.go({ name: 'settings', tab: 'nic' })}>
                    Configure in Settings →
                  </Button>
                </div>
              </DrawerSection>
            </>
          )
        }}
      />

      {!info?.gstin && (
        <Banner tone="warning" className="mb-3">
          Add the company GSTIN under Company details to enable exports.
        </Banner>
      )}

      <Panel>
        <DataTable
          viewId="edocs"
          testId="edocs"
          ariaLabel="e-Invoice and e-way bill documents"
          columns={EDOC_COLUMNS}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          maxHeight="calc(100vh - 15rem)"
          empty={{
            title: allRows.length === 0 ? 'No documents in this period' : 'No documents match this filter',
            action:
              allRows.length > 0 && docTypeFilter !== 'all' ? (
                <button
                  type="button"
                  className="text-small text-blue hover:underline"
                  onClick={() => setDocTypeFilter('all')}
                  data-testid="edocs-clear-doctype"
                >
                  Show all document types
                </button>
              ) : undefined
          }}
          // The document-type picker pre-filters the rows (the table's view applies on top).
          toolbarStart={
            <Select
              className="!w-40 !min-h-control-sm !py-0.5 !text-detail"
              aria-label="Document type"
              data-testid="input-edocs-doctype"
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value as DocTypeFilter)}
            >
              {DOC_TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </Select>
          }
          exportOptions={{
            title: 'e-Invoice & e-way bill documents',
            periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
            filename: 'edocs'
          }}
          trailingWidth={live ? 300 : 210}
          trailing={(r) => (
            <span className="whitespace-nowrap">
              {live && r.partyGstin && !r.irn && (
                <button
                  className="mr-2 text-small text-blue hover:underline disabled:opacity-40"
                  disabled={busy === r.voucherId}
                  onClick={() => requestGenerate('irn', r.voucherId)}
                >
                  Generate IRN
                </button>
              )}
              {live && r.irn && !r.ewbNo && (
                <button
                  className="mr-2 text-small text-blue hover:underline disabled:opacity-40"
                  disabled={busy === r.voucherId}
                  onClick={() => requestGenerate('ewb', r.voucherId)}
                >
                  Generate EWB
                </button>
              )}
              {r.docType !== 'CRN' && (
                <button
                  className="mr-2 text-small text-blue hover:underline disabled:opacity-40"
                  data-testid="btn-edocs-ewb-json"
                  disabled={busy === r.voucherId}
                  title="Write this bill's single-bill EWB JSON (overrides the ₹50,000 threshold)"
                  onClick={() => void perRowEwbJson(r.voucherId)}
                >
                  EWB JSON
                </button>
              )}
              <button
                className="mr-2 text-small text-blue hover:underline"
                data-testid="btn-edocs-transport"
                onClick={() => setTransportFor({ voucherId: r.voucherId, number: r.number })}
              >
                Transport
              </button>
              <button
                className="mr-2 text-small text-blue hover:underline"
                onClick={() => {
                  api.invoice.pdf(r.voucherId).catch((err: Error) => toast.push('error', err.message))
                }}
              >
                PDF
              </button>
              <button className="text-small text-muted hover:text-ink" onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}>
                Open
              </button>
            </span>
          )}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Export JSON for the government offline tools, or file live with NIC credentials · F12 for options.</p>

      {confirming && (
        <LiveApiConfirmModal
          onCancel={() => setConfirming(null)}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) liveApiConfirmed = true
            const { kind, voucherId } = confirming
            setConfirming(null)
            void (kind === 'irn' ? generateIrn(voucherId) : generateEwb(voucherId))
          }}
        />
      )}

      {transportFor && (
        <TransportModal
          voucherId={transportFor.voucherId}
          voucherNumber={transportFor.number}
          onClose={() => {
            setTransportFor(null)
            void queryClient.invalidateQueries({ queryKey: ['edocList'] })
          }}
        />
      )}
    </Page>
  )
}


function LiveApiConfirmModal({
  onCancel,
  onConfirm
}: {
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const [understood, setUnderstood] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  return (
    <Modal title="Live government API call" onClose={onCancel}>
      <p className="text-detail text-ink">
        This calls the live NIC e-invoice/e-way bill API — a real document will be generated with the government. This
        integration has never been tested against the live portal; verify the result there afterwards.
      </p>
      <label className="mt-4 flex items-start gap-2 text-detail">
        <input type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        I understand this calls the live government API
      </label>
      <label className="mt-2 flex items-start gap-2 text-small text-muted">
        <input type="checkbox" className="mt-0.5" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
        Don't ask again this session
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!understood} onClick={() => onConfirm(dontAskAgain)}>
          Continue
        </Button>
      </div>
    </Modal>
  )
}
