// IMS action list (WP 3.4) — the Invoice Management System decision per GSTR-2B record: Accept /
// Reject / Pending (no action = deemed accepted when 2B is generated). The app is offline: it
// records the decisions next to the reconciliation and exports the list to act on in the
// portal's IMS (or its offline tool). Nothing posts from here; a record missing in the books is
// proposed through "Create purchase" on the reconciliation tab.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IMS_ACTION_LABELS, bulkAcceptKeys, imsRows, type ImsAction, type ImsRow } from '@shared/gst/ims'
import type { Recon2bPair } from '@shared/gst/recon2b'
import { api, type ImsDecisionPayload } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, Select } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { useCanEditMasters } from '../../lib/drill'
import { promptDialog } from '../../lib/dialogs'

const BUCKET_LABEL: Record<ImsRow['bucket'], string> = {
  matched: 'Matched', amountMismatch: 'Amount mismatch', taxMismatch: 'Tax mismatch', missingInBooks: 'Missing in books', missingInPortal: 'Missing in portal'
}
const ACTION_TONE: Record<ImsAction, 'success' | 'danger' | 'warning'> = { accept: 'success', reject: 'danger', pending: 'warning' }
const DOC_LABEL: Record<ImsRow['docType'], string> = { INV: 'Invoice', CN: 'Credit note', DN: 'Debit note' }
const tax = (p: ImsRow['portal']): number => p.igst + p.cgst + p.sgst + p.cess

export const IMS_COLUMNS = defineColumns<ImsRow>([
  { id: 'gstin', header: 'Supplier GSTIN', kind: 'text', value: (r) => r.portal.gstin, width: 150, className: 'num text-muted' },
  { id: 'type', header: 'Type', kind: 'enum', value: (r) => r.docType, width: 92, options: Object.entries(DOC_LABEL).map(([value, label]) => ({ value, label })) },
  { id: 'number', header: 'Document no.', kind: 'text', value: (r) => r.portal.number, width: 130, hideable: false, groupable: false },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.portal.date, className: 'text-muted' },
  { id: 'value', header: 'Value', kind: 'money', value: (r) => r.portal.value, aggregate: 'sum', width: 112 },
  { id: 'tax', header: 'Tax', kind: 'money', value: (r) => tax(r.portal), aggregate: 'sum', width: 100 },
  { id: 'bucket', header: 'Reconciliation', kind: 'enum', value: (r) => r.bucket, width: 132, options: Object.entries(BUCKET_LABEL).map(([value, label]) => ({ value, label })) },
  { id: 'voucher', header: 'Purchase', kind: 'text', value: (r) => r.voucherNumber, width: 96,
    cell: (r) => (r.voucherId != null ? <VoucherLink voucherId={r.voucherId} label={r.voucherNumber ?? `#${r.voucherId}`} /> : <span className="text-muted">—</span>) },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 150, defaultHidden: true,
    cell: (r) => (r.partyName ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> : <span className="text-muted">—</span>) },
  { id: 'suggested', header: 'Suggested', kind: 'enum', value: (r) => r.suggested, width: 104, defaultHidden: true, options: Object.entries(IMS_ACTION_LABELS).map(([value, label]) => ({ value, label })) },
  { id: 'action', header: 'Action', kind: 'enum', value: (r) => r.action ?? 'none', width: 120,
    options: [...Object.entries(IMS_ACTION_LABELS).map(([value, label]) => ({ value, label })), { value: 'none', label: 'No action' }],
    cell: (r) => (r.action ? <Badge tone={ACTION_TONE[r.action]}>{IMS_ACTION_LABELS[r.action]}</Badge> : <span className="text-muted">No action</span>) },
  { id: 'note', header: 'Note', kind: 'text', value: (r) => r.note, minWidth: 140, defaultHidden: true }
])

const decision = (r: ImsRow, action: ImsAction | null, note: string | null = r.note): ImsDecisionPayload => ({
  supplierGstin: r.portal.gstin, docType: r.docType, docNo: r.portal.number, docDate: r.portal.date, action, note, voucherId: r.voucherId,
  value: r.portal.value, taxable: r.portal.taxable, igst: r.portal.igst, cgst: r.portal.cgst, sgst: r.portal.sgst, cess: r.portal.cess
})

export function ImsTab({ period, periodLabel, pairs }: { period: string; periodLabel: string; pairs: Recon2bPair[] }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const canEdit = useCanEditMasters()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { data: stored, isLoading } = useQuery({ queryKey: ['imsActions', period], queryFn: () => api.gst.imsList(period) })
  const rows = useMemo(() => imsRows(period, pairs, stored ?? []), [period, pairs, stored])
  const toAccept = bulkAcceptKeys(rows)
  const chosen = rows.filter((r) => selected.has(r.key))
  const decided = rows.filter((r) => r.action != null).length

  const save = async (ds: ImsDecisionPayload[], ok: string): Promise<void> => {
    if (ds.length === 0) return
    setBusy(true)
    try {
      await api.gst.imsSet(period, ds)
      await qc.invalidateQueries({ queryKey: ['imsActions'] })
      setSelected(new Set())
      toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const setFor = async (list: ImsRow[], action: ImsAction | null): Promise<void> => {
    let note: string | null = null
    if (action === 'reject' || action === 'pending') {
      const n = await promptDialog({ title: `${IMS_ACTION_LABELS[action]} ${list.length} record${list.length > 1 ? 's' : ''}`, message: 'Remark for the portal (optional)', initial: '', confirmLabel: IMS_ACTION_LABELS[action] })
      if (n == null) return
      note = n.trim() || null
    }
    await save(list.map((r) => decision(r, action, action == null ? null : note ?? r.note)), action ? `${list.length} marked ${IMS_ACTION_LABELS[action].toLowerCase()}` : `${list.length} cleared`)
  }
  const doExport = async (): Promise<void> => {
    try {
      const r = await api.gst.imsExport(period)
      toast.push('success', `${r.count} IMS actions saved — ${r.jsonPath.split('/').pop()} and CSV`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <Banner tone="info" className="mb-3" testId="ims-rules">
        On the portal&apos;s IMS: <b>Accept</b> puts the credit in GSTR-2B (ITC available), <b>Reject</b> moves it to ITC rejected, <b>Pending</b> keeps it out
        of 2B and 3B until you act (credit notes: one tax period only, from October 2025); no action = deemed accepted when 2B is generated on the 14th.
        RCM and import records do not pass through IMS. The export is the app&apos;s own JSON / CSV (the IMS offline tool&apos;s schema is unpublished —
        UNVERIFIED): act on it in the IMS dashboard.
      </Banner>
      <DataTable
        viewId="gstr2b-ims"
        testId="ims"
        ariaLabel={`IMS actions — ${periodLabel}`}
        columns={IMS_COLUMNS}
        rows={rows}
        loading={isLoading}
        rowKey={(r) => r.key}
        rowAttrs={(r) => ({ 'data-ims-key': r.key, 'data-action': r.action ?? 'none' })}
        maxHeight="calc(100vh - 340px)"
        empty={{ title: 'No portal records in this 2B' }}
        exportOptions={{ title: 'IMS actions', periodLabel, filename: `ims-${period}` }}
        leadingWidth={44}
        leading={
          canEdit
            ? (r) => (
                <input
                  type="checkbox"
                  aria-label={`Select ${r.portal.number}`}
                  data-testid={`chk-ims-${r.portal.number}`}
                  checked={selected.has(r.key)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s)
                      if (e.target.checked) n.add(r.key)
                      else n.delete(r.key)
                      return n
                    })
                  }
                />
              )
            : undefined
        }
        toolbarStart={
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button size="sm" variant="primary" data-testid="btn-ims-bulk-accept" disabled={busy || toAccept.length === 0}
                onClick={() => void save(rows.filter((r) => toAccept.includes(r.key)).map((r) => decision(r, 'accept')), `${toAccept.length} matched record${toAccept.length > 1 ? 's' : ''} accepted`)}>
                Accept all matched{toAccept.length ? ` (${toAccept.length})` : ''}
              </Button>
            )}
            {canEdit && (
              <Select
                className="!w-44 !min-h-control-sm !py-0.5 !text-detail"
                aria-label="Set the selected records"
                data-testid="input-ims-set-selected"
                value=""
                disabled={chosen.length === 0 || busy}
                onChange={(e) => {
                  const v = e.target.value
                  if (v) void setFor(chosen, v === 'none' ? null : (v as ImsAction))
                }}
              >
                <option value="">{chosen.length ? `Set ${chosen.length} selected…` : 'Select records…'}</option>
                <option value="accept">Accept</option>
                <option value="reject">Reject</option>
                <option value="pending">Pending</option>
                <option value="none">Clear (no action)</option>
              </Select>
            )}
            <span className="text-small text-muted" data-testid="ims-decided">{decided} of {rows.length} decided</span>
          </div>
        }
        toolbarEnd={
          <Button size="sm" data-testid="btn-ims-export" disabled={decided === 0} onClick={() => void doExport()}>
            Export actions
          </Button>
        }
      />
    </>
  )
}
