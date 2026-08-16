import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput } from '../components/ui'
import { gstPeriodOf, toDisplayDate, todayISO } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import type { VoucherTransportInput } from '@shared/schemas'

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

/** Per-session "don't ask again" for the live-API confirm gate — module-level so it survives
 *  remounts of this screen but resets on app restart (never persisted to disk). */
let liveApiConfirmed = false

export function EdocsScreen(): React.JSX.Element {
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
    <div className="mx-auto max-w-6xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select
              className="w-40"
              data-testid="input-edocs-doctype"
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value as DocTypeFilter)}
            >
              {DOC_TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </Select>
            <Button onClick={() => nav.go({ name: 'settings', tab: 'nic' })}>
              {live ? 'Live filing ✓ · Configure in Settings →' : 'Configure in Settings →'}
            </Button>
            <Button variant="primary" data-testid="btn-edocs-export-einvoice" onClick={() => void exportEinv()} disabled={!info?.gstin}>
              Export e-invoice JSON
            </Button>
            <Button data-testid="btn-edocs-export-ewb" onClick={() => void exportEwb()} disabled={!info?.gstin}>
              Export e-way bill JSON
            </Button>
          </div>
        }
      >
        e-Invoice &amp; e-Way bill
      </SectionTitle>

      {!info?.gstin && <p className="mb-3 text-[12.5px] text-amber">Add the company GSTIN under Company details to enable exports.</p>}

      <Panel scroll={{ maxH: 'calc(100vh - 15rem)' }}>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title={allRows.length === 0 ? 'No documents in this period' : 'No documents match this filter'} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-20">Date</th>
                <th className="w-20">No.</th>
                <th className="w-16">Type</th>
                <th>Buyer</th>
                <th className="w-36">GSTIN</th>
                <th className="r w-28">Value</th>
                <th className="w-32">IRN / EWB</th>
                <th className="w-44">EWB eligibility</th>
                <th className="r w-52"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-edocs">
              {rows.map((r) => (
                <tr key={r.voucherId} data-row-id={r.voucherId}>
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">
                    {r.number}
                    {!r.hasHsn && (
                      <span className="ml-1 text-amber" title="No stock item on this document carries an HSN code — e-invoice/EWB JSON will be rejected. Set HSN on the items (Masters → Items).">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`inline-block rounded border border-line px-1.5 py-0.5 text-[10.5px] font-medium ${DOC_TYPE_CLASS[r.docType]}`}
                      title={r.docType === 'CRN' ? 'Credit note' : r.docType === 'DBN' ? 'Debit note' : 'Invoice'}
                    >
                      {r.docType}
                    </span>
                    {r.outwardDbn && (
                      <span
                        className="ml-1 inline-block rounded border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber"
                        title="Outward debit note — the NIC bulk docType enum has no DBN, so it exports as 'OTH'."
                      >
                        OTH
                      </span>
                    )}
                  </td>
                  <td>{r.partyName ?? 'Cash sale'}</td>
                  <td className="num text-muted">{r.partyGstin ?? '—'}</td>
                  <td className="r"><Money paise={r.total} /></td>
                  <td className="text-[11.5px]">
                    {r.irn ? <span className="text-dr" title={r.irn}>IRN ✓</span> : <span className="text-muted">no IRN</span>}
                    {' · '}
                    {r.ewbNo ? <span className="num text-dr">{r.ewbNo}</span> : <span className="text-muted">no EWB</span>}
                  </td>
                  <td className="text-[11.5px]">
                    {r.ewbReason == null ? (
                      <span className="text-dr">Eligible</span>
                    ) : (
                      <span className="text-muted" title={r.ewbReason}>{r.ewbReason}</span>
                    )}
                  </td>
                  <td className="r whitespace-nowrap">
                    {live && r.partyGstin && !r.irn && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => requestGenerate('irn', r.voucherId)}
                      >
                        Generate IRN
                      </button>
                    )}
                    {live && r.irn && !r.ewbNo && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => requestGenerate('ewb', r.voucherId)}
                      >
                        Generate EWB
                      </button>
                    )}
                    {r.docType !== 'CRN' && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        data-testid="btn-edocs-ewb-json"
                        disabled={busy === r.voucherId}
                        title="Write this bill's single-bill EWB JSON (overrides the ₹50,000 threshold)"
                        onClick={() => void perRowEwbJson(r.voucherId)}
                      >
                        EWB JSON
                      </button>
                    )}
                    <button
                      className="mr-2 text-[12px] text-blue hover:underline"
                      data-testid="btn-edocs-transport"
                      onClick={() => setTransportFor({ voucherId: r.voucherId, number: r.number })}
                    >
                      Transport
                    </button>
                    <button
                      className="mr-2 text-[12px] text-blue hover:underline"
                      onClick={() => {
                        api.invoice.pdf(r.voucherId).catch((err: Error) => toast.push('error', err.message))
                      }}
                    >
                      PDF
                    </button>
                    <button className="text-[12px] text-muted hover:text-ink" onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        Offline route: export JSON for the government offline tools — the period export writes one combined bulk file plus a per-bill file per consignment. Live route: add your NIC API credentials once, then generate IRNs and e-way bills directly — needs internet and a registered API user (einvoice1.gst.gov.in → API registration) or GSP credentials.
      </p>

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
        <TransportModalLite
          voucherId={transportFor.voucherId}
          voucherNumber={transportFor.number}
          onClose={() => setTransportFor(null)}
          onSaved={() => {
            setTransportFor(null)
            void queryClient.invalidateQueries({ queryKey: ['edocList'] })
          }}
        />
      )}
    </div>
  )
}

// ---------- Transport details (lite) ----------
//
// NOTE for the integrator: lane S1 creates the canonical TransportModal at
// src/renderer/src/screens/voucher/TransportModal.tsx — it did not exist in this worktree,
// so this is the brief's fallback TransportModalLite. When both land, keep S1's modal and
// point the launcher below at it (the edoc:transportGet/Set contract is identical).

const EMPTY_TRANSPORT: VoucherTransportInput = {
  transMode: null,
  transDistanceKm: null,
  transporterId: null,
  transporterName: null,
  transDocNo: null,
  transDocDate: null,
  vehicleNo: null,
  vehicleType: null,
  shipToName: null,
  shipToGstin: null,
  shipToAddr1: null,
  shipToAddr2: null,
  shipToPlace: null,
  shipToPincode: null,
  shipToState: null
}

function TransportModalLite({
  voucherId,
  voucherNumber,
  onClose,
  onSaved
}: {
  voucherId: number
  voucherNumber: string
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const { data: saved, isLoading } = useQuery({
    queryKey: ['edocTransport', voucherId],
    queryFn: () => api.edoc.transportGet(voucherId)
  })
  const [draft, setDraft] = useState<VoucherTransportInput | null>(null)
  const [initial, setInitial] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (saved !== undefined && draft == null) {
      const { voucherId: _vid, ...rest } = saved ?? { voucherId, ...EMPTY_TRANSPORT }
      // Stored rows type transMode/vehicleType as plain strings; narrow to the input enums.
      const loaded: VoucherTransportInput = {
        ...EMPTY_TRANSPORT,
        ...rest,
        transMode: rest.transMode === '1' || rest.transMode === '2' || rest.transMode === '3' || rest.transMode === '4' ? rest.transMode : null,
        vehicleType: rest.vehicleType === 'R' || rest.vehicleType === 'O' ? rest.vehicleType : null
      }
      setDraft(loaded)
      setInitial(JSON.stringify(loaded))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])
  const value = draft ?? EMPTY_TRANSPORT
  const dirty = draft != null && initial != null && JSON.stringify(draft) !== initial

  const set = <K extends keyof VoucherTransportInput>(k: K, v: VoucherTransportInput[K]): void =>
    setDraft({ ...value, [k]: v })
  const str = (v: string): string | null => (v.trim() === '' ? null : v)

  const doSave = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.edoc.transportSet(voucherId, draft)
      toast.push('success', 'Transport details saved')
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Transport details — ${voucherNumber}`} onClose={onClose} wide dirty={dirty}>
      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
            <Field label="Mode">
              <Select
                data-testid="input-transport-mode"
                value={value.transMode ?? ''}
                onChange={(e) => set('transMode', (e.target.value || null) as VoucherTransportInput['transMode'])}
              >
                <option value="">—</option>
                <option value="1">Road</option>
                <option value="2">Rail</option>
                <option value="3">Air</option>
                <option value="4">Ship</option>
              </Select>
            </Field>
            <Field label="Distance (km)">
              <TextInput
                data-testid="input-transport-distance"
                inputMode="numeric"
                value={value.transDistanceKm ?? ''}
                onChange={(e) => {
                  const n = e.target.value.trim() === '' ? null : Number.parseInt(e.target.value, 10)
                  set('transDistanceKm', n != null && Number.isFinite(n) ? n : null)
                }}
              />
            </Field>
            <Field label="Vehicle no.">
              <TextInput data-testid="input-transport-vehicle" value={value.vehicleNo ?? ''} onChange={(e) => set('vehicleNo', str(e.target.value))} />
            </Field>
            <Field label="Vehicle type">
              <Select
                data-testid="input-transport-vehicle-type"
                value={value.vehicleType ?? ''}
                onChange={(e) => set('vehicleType', (e.target.value || null) as VoucherTransportInput['vehicleType'])}
              >
                <option value="">—</option>
                <option value="R">Regular</option>
                <option value="O">Over-dimensional cargo</option>
              </Select>
            </Field>
            <Field label="Transporter ID (GSTIN/TRANSIN)">
              <TextInput data-testid="input-transport-id" value={value.transporterId ?? ''} onChange={(e) => set('transporterId', str(e.target.value))} />
            </Field>
            <Field label="Transporter name">
              <TextInput data-testid="input-transport-name" value={value.transporterName ?? ''} onChange={(e) => set('transporterName', str(e.target.value))} />
            </Field>
            <Field label="Transport doc no. (LR/RR/AWB)">
              <TextInput data-testid="input-transport-doc-no" value={value.transDocNo ?? ''} onChange={(e) => set('transDocNo', str(e.target.value))} />
            </Field>
            <Field label="Transport doc date">
              <DateInput
                testId="input-transport-doc-date"
                value={value.transDocDate ?? todayISO()}
                context={todayISO()}
                onChange={(iso) => set('transDocDate', iso)}
              />
            </Field>
          </div>
          <p className="mb-1 mt-4 text-[12px] font-medium text-muted">Ship-to (when different from the buyer's billing address)</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
            <Field label="Name">
              <TextInput data-testid="input-transport-shipto-name" value={value.shipToName ?? ''} onChange={(e) => set('shipToName', str(e.target.value))} />
            </Field>
            <Field label="GSTIN">
              <TextInput data-testid="input-transport-shipto-gstin" value={value.shipToGstin ?? ''} onChange={(e) => set('shipToGstin', str(e.target.value.toUpperCase()))} />
            </Field>
            <Field label="Address line 1">
              <TextInput data-testid="input-transport-shipto-addr1" value={value.shipToAddr1 ?? ''} onChange={(e) => set('shipToAddr1', str(e.target.value))} />
            </Field>
            <Field label="Address line 2">
              <TextInput data-testid="input-transport-shipto-addr2" value={value.shipToAddr2 ?? ''} onChange={(e) => set('shipToAddr2', str(e.target.value))} />
            </Field>
            <Field label="Place (city)">
              <TextInput data-testid="input-transport-shipto-place" value={value.shipToPlace ?? ''} onChange={(e) => set('shipToPlace', str(e.target.value))} />
            </Field>
            <Field label="PIN code">
              <TextInput data-testid="input-transport-shipto-pincode" inputMode="numeric" value={value.shipToPincode ?? ''} onChange={(e) => set('shipToPincode', str(e.target.value))} />
            </Field>
            <Field label="State">
              <Select
                data-testid="input-transport-shipto-state"
                value={value.shipToState ?? ''}
                onChange={(e) => set('shipToState', str(e.target.value))}
              >
                <option value="">—</option>
                {Object.entries(GST_STATES).map(([code, name]) => (
                  <option key={code} value={code}>{code} — {name}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-edocs-save-transport" disabled={saving || draft == null} onClick={() => void doSave()}>
              {saving ? 'Saving…' : 'Save transport details'}
            </Button>
          </div>
        </>
      )}
    </Modal>
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
      <p className="text-[13px] text-ink">
        This calls the live NIC e-invoice/e-way bill API — a real document will be generated with the government. This
        integration has never been tested against the live portal; verify the result there afterwards.
      </p>
      <label className="mt-4 flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        I understand this calls the live government API
      </label>
      <label className="mt-2 flex items-start gap-2 text-[12px] text-muted">
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
