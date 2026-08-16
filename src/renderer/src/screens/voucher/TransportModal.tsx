import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { VoucherTransportInput } from '@shared/schemas'
import { GST_STATES } from '@shared/gst/states'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Button, DateInput, Field, Modal, Select, Spinner, TextInput } from '../../components/ui'

/**
 * Per-voucher transport + ship-to details (voucher_transport, migration 013) — feeds the
 * e-way-bill / e-invoice builders. Self-contained: loads via edoc:transportGet, saves via
 * edoc:transportSet. Launched from a saved sales voucher (AccountingEntry alteration) and
 * from the Edocs screen (lane S3 imports this component).
 */
export function TransportModal({
  voucherId,
  voucherNumber,
  onClose
}: {
  voucherId: number
  /** For the modal title only. */
  voucherNumber?: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [form, setForm] = useState<VoucherTransportInput>({
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
  })

  useEffect(() => {
    let cancelled = false
    api.edoc
      .transportGet(voucherId)
      .then((t) => {
        if (cancelled) return
        if (t) {
          setForm({
            transMode: (t.transMode as VoucherTransportInput['transMode']) ?? null,
            transDistanceKm: t.transDistanceKm,
            transporterId: t.transporterId,
            transporterName: t.transporterName,
            transDocNo: t.transDocNo,
            transDocDate: t.transDocDate,
            vehicleNo: t.vehicleNo,
            vehicleType: (t.vehicleType as VoucherTransportInput['vehicleType']) ?? null,
            shipToName: t.shipToName,
            shipToGstin: t.shipToGstin,
            shipToAddr1: t.shipToAddr1,
            shipToAddr2: t.shipToAddr2,
            shipToPlace: t.shipToPlace,
            shipToPincode: t.shipToPincode,
            shipToState: t.shipToState
          })
        }
        setLoaded(true)
      })
      .catch((err) => {
        if (!cancelled) {
          toast.push('error', (err as Error).message)
          setLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherId])

  const set = (patch: Partial<VoucherTransportInput>): void => {
    setForm((f) => ({ ...f, ...patch }))
    setDirty(true)
  }
  /** '' ⇄ null for optional text fields. */
  const text = (v: string): string | null => (v.trim() === '' ? null : v)

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await api.edoc.transportSet(voucherId, form)
      await queryClient.invalidateQueries({ queryKey: ['edocs'] })
      toast.push('success', 'Transport details saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Transport details${voucherNumber ? ` — ${voucherNumber}` : ''}`} onClose={onClose} wide dirty={dirty}>
      {!loaded ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Transport</p>
            <div className="grid grid-cols-4 gap-3">
              <Field label="Mode">
                <Select
                  data-testid="input-trans-mode"
                  value={form.transMode ?? ''}
                  onChange={(e) => set({ transMode: (e.target.value || null) as VoucherTransportInput['transMode'] })}
                >
                  <option value="">—</option>
                  <option value="1">Road</option>
                  <option value="2">Rail</option>
                  <option value="3">Air</option>
                  <option value="4">Ship</option>
                </Select>
              </Field>
              <Field label="Distance km">
                <TextInput
                  data-testid="input-trans-distance"
                  value={form.transDistanceKm ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    set({ transDistanceKm: e.target.value.trim() === '' || !Number.isFinite(n) ? null : Math.round(n) })
                  }}
                  placeholder="0"
                  className="num text-right"
                />
              </Field>
              <Field label="Vehicle no.">
                <TextInput
                  data-testid="input-vehicle-no"
                  value={form.vehicleNo ?? ''}
                  onChange={(e) => set({ vehicleNo: text(e.target.value.toUpperCase()) })}
                  placeholder="MH01AB1234"
                  className="num"
                />
              </Field>
              <Field label="Vehicle type">
                <Select
                  data-testid="input-vehicle-type"
                  value={form.vehicleType ?? ''}
                  onChange={(e) => set({ vehicleType: (e.target.value || null) as VoucherTransportInput['vehicleType'] })}
                >
                  <option value="">—</option>
                  <option value="R">Regular</option>
                  <option value="O">Over-dimensional</option>
                </Select>
              </Field>
              <Field label="Transporter ID">
                <TextInput
                  data-testid="input-transporter-id"
                  value={form.transporterId ?? ''}
                  onChange={(e) => set({ transporterId: text(e.target.value.toUpperCase()) })}
                  placeholder="15-char GSTIN/TRANSIN"
                  className="num"
                />
              </Field>
              <Field label="Transporter name">
                <TextInput
                  value={form.transporterName ?? ''}
                  onChange={(e) => set({ transporterName: text(e.target.value) })}
                />
              </Field>
              <Field label="Transport doc no." hint="LR/RR/airway bill; shipping bill for exports">
                <TextInput
                  data-testid="input-trans-doc-no"
                  value={form.transDocNo ?? ''}
                  onChange={(e) => set({ transDocNo: text(e.target.value) })}
                  className="num"
                />
              </Field>
              <Field label="Doc date">
                <DateInput
                  testId="input-trans-doc-date"
                  value={form.transDocDate ?? ''}
                  context={form.transDocDate ?? new Date().toISOString().slice(0, 10)}
                  onChange={(d) => set({ transDocDate: d })}
                />
              </Field>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Ship to (when different from buyer)</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Name">
                <TextInput
                  data-testid="input-ship-to-name"
                  value={form.shipToName ?? ''}
                  onChange={(e) => set({ shipToName: text(e.target.value) })}
                />
              </Field>
              <Field label="GSTIN">
                <TextInput
                  data-testid="input-ship-to-gstin"
                  value={form.shipToGstin ?? ''}
                  onChange={(e) => set({ shipToGstin: text(e.target.value.toUpperCase()) })}
                  className="num"
                />
              </Field>
              <Field label="Place">
                <TextInput value={form.shipToPlace ?? ''} onChange={(e) => set({ shipToPlace: text(e.target.value) })} />
              </Field>
              <Field label="Address line 1">
                <TextInput value={form.shipToAddr1 ?? ''} onChange={(e) => set({ shipToAddr1: text(e.target.value) })} />
              </Field>
              <Field label="Address line 2">
                <TextInput value={form.shipToAddr2 ?? ''} onChange={(e) => set({ shipToAddr2: text(e.target.value) })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="PIN">
                  <TextInput
                    data-testid="input-ship-to-pincode"
                    value={form.shipToPincode ?? ''}
                    onChange={(e) => set({ shipToPincode: text(e.target.value) })}
                    placeholder="6 digits"
                    className="num"
                  />
                </Field>
                <Field label="State">
                  <Select
                    data-testid="input-ship-to-state"
                    value={form.shipToState ?? ''}
                    onChange={(e) => set({ shipToState: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {Object.entries(GST_STATES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {code} — {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-transport-save" disabled={saving} onClick={() => void save()}>
              Save transport details
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
