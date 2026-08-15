import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Field, Modal, Money, Panel, SectionTitle, TextInput } from '../components/ui'
import { gstPeriodOf, toDisplayDate } from '@shared/dates'
import type { NicCredentials } from '@shared/schemas'

export function EdocsScreen(): React.JSX.Element {
  const { from, to, info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['edocList', from, to], queryFn: () => api.edoc.list(from, to) })
  const { data: nicStatus } = useQuery({ queryKey: ['nicStatus'], queryFn: api.nic.status })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const rows = data ?? []
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
      toast.push(r.count ? 'success' : 'warning', r.count ? `${r.count} invoice${r.count > 1 ? 's' : ''} written for e-way bill generation` : 'No invoices in this period')
    } catch (err) {
      toast.push('error', (err as Error).message)
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
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex gap-2">
            <Button onClick={() => setSettingsOpen(true)}>{live ? 'Live filing ✓' : 'Set up live filing'}</Button>
            <Button variant="primary" onClick={() => void exportEinv()} disabled={!info?.gstin}>
              Export e-invoice JSON
            </Button>
            <Button onClick={() => void exportEwb()} disabled={!info?.gstin}>
              Export e-way bill JSON
            </Button>
          </div>
        }
      >
        e-Invoice &amp; e-Way bill
      </SectionTitle>

      {!info?.gstin && <p className="mb-3 text-[12.5px] text-amber">Add the company GSTIN under Company details to enable exports.</p>}

      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No sales invoices in this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-20">Date</th>
                <th className="w-20">No.</th>
                <th>Buyer</th>
                <th className="w-40">GSTIN</th>
                <th className="r w-32">Value</th>
                <th className="w-40">IRN / EWB</th>
                <th className="r w-40"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.voucherId}>
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">{r.number}</td>
                  <td>{r.partyName ?? 'Cash sale'}</td>
                  <td className="num text-muted">{r.partyGstin ?? '—'}</td>
                  <td className="r"><Money paise={r.total} /></td>
                  <td className="text-[11.5px]">
                    {r.irn ? <span className="text-dr" title={r.irn}>IRN ✓</span> : <span className="text-muted">no IRN</span>}
                    {' · '}
                    {r.ewbNo ? <span className="num text-dr">{r.ewbNo}</span> : <span className="text-muted">no EWB</span>}
                  </td>
                  <td className="r whitespace-nowrap">
                    {live && r.partyGstin && !r.irn && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => void generateIrn(r.voucherId)}
                      >
                        Generate IRN
                      </button>
                    )}
                    {live && r.irn && !r.ewbNo && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => void generateEwb(r.voucherId)}
                      >
                        Generate EWB
                      </button>
                    )}
                    <button className="mr-2 text-[12px] text-blue hover:underline" onClick={() => void api.invoice.pdf(r.voucherId)}>
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
        Offline route: export JSON for the government offline tools. Live route: add your NIC API credentials once, then generate IRNs and e-way bills directly — needs internet and a registered API user (einvoice1.gst.gov.in → API registration) or GSP credentials.
      </p>

      {settingsOpen && <NicSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function NicSettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: existing } = useQuery({ queryKey: ['nicCreds'], queryFn: api.nic.get })
  const [creds, setCreds] = useState<NicCredentials | null>(null)
  const value = creds ?? existing ?? null

  if (!value) return <Modal title="Live filing (NIC APIs)" onClose={onClose}><p className="text-muted">Loading…</p></Modal>

  const set = (patch: Partial<NicCredentials>): void => setCreds({ ...value, ...patch })

  const save = async (): Promise<void> => {
    try {
      const r = await api.nic.save(value)
      await queryClient.invalidateQueries({ queryKey: ['nicStatus'] })
      toast.push(r.configured ? 'success' : 'warning', r.configured ? 'Live filing is ready' : 'Saved — some fields are still missing')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Live filing (NIC APIs)" onClose={onClose} wide>
      <p className="mb-4 text-[12.5px] text-muted">
        Credentials from your e-invoice API registration (direct access) or your GSP. Sandbox first is a good idea:
        base URL <span className="num">https://einv-apisandbox.nic.in</span>. Everything stays in this company's local database.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="e-Invoice base URL">
          <TextInput value={value.baseUrlEinvoice} onChange={(e) => set({ baseUrlEinvoice: e.target.value.trim() })} placeholder="https://einv-apisandbox.nic.in" className="num" />
        </Field>
        <Field label="e-Way bill base URL" hint="Optional — EWBs are generated via the e-invoice suite">
          <TextInput value={value.baseUrlEwb} onChange={(e) => set({ baseUrlEwb: e.target.value.trim() })} className="num" />
        </Field>
        <Field label="API username">
          <TextInput value={value.username} onChange={(e) => set({ username: e.target.value })} className="num" />
        </Field>
        <Field label="API password">
          <TextInput type="password" value={value.password} onChange={(e) => set({ password: e.target.value })} className="num" />
        </Field>
        <Field label="Client ID">
          <TextInput value={value.clientId} onChange={(e) => set({ clientId: e.target.value })} className="num" />
        </Field>
        <Field label="Client secret">
          <TextInput type="password" value={value.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} className="num" />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="NIC public key (PEM)" hint="From the portal's API documentation — used to encrypt your password during login">
          <textarea
            value={value.publicKeyPem}
            onChange={(e) => set({ publicKeyPem: e.target.value })}
            rows={5}
            className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[11px]"
            placeholder="-----BEGIN PUBLIC KEY-----"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>
          Save credentials
        </Button>
      </div>
    </Modal>
  )
}
