import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { VoucherTransportInput } from '@shared/schemas'
import { GST_STATES } from '@shared/gst/states'
import { api, type EwayDistanceOffer } from '../../lib/client'
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
      // The e-docs list (['edocList', from, to]) shows per-voucher transport eligibility —
      // refresh it so a save from any launcher (Edocs screen or AccountingEntry) shows up.
      // Transport details themselves are loaded imperatively (api.edoc.transportGet above),
      // so there is no query family for them to invalidate.
      await queryClient.invalidateQueries({ queryKey: ['edocList'] })
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
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Transport</p>
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
              <Field label="Distance km" hint="Governs how long the e-way bill stays valid">
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
            <DistanceEstimator
              voucherId={voucherId}
              shipToPincode={form.shipToPincode}
              onAccept={(km) => set({ transDistanceKm: km })}
            />
          </div>

          <div>
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Ship to (when different from buyer)</p>
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

/**
 * An approximate PIN-to-PIN distance, offered and never applied on its own (roadmap D-96).
 *
 * The distance on an e-way bill decides how long the bill stays valid, so understating it can
 * expire a consignment while the vehicle is still on the road — a detained truck and a penalty.
 * That is why this asks rather than fills: the figure appears with the disclaimer attached, and
 * only a click on "Use this distance" puts it in the field the bill is built from. An unknown
 * PIN produces no number at all rather than a fallback, because a confident wrong distance is
 * worse here than an empty box.
 *
 * The despatch PIN is typed every time: the company address is one free-text field with no PIN
 * column and the party ledger has none either, so there is no stored despatch point to prefill
 * from, and pulling six digits out of an address line would present a guess as a fact. The
 * delivery PIN comes from the ship-to address on this form when it has one.
 */
function DistanceEstimator({
  voucherId,
  shipToPincode,
  onAccept
}: {
  voucherId: number
  shipToPincode: string | null
  onAccept: (km: number) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [fromPin, setFromPin] = useState('')
  const [toPin, setToPin] = useState('')
  const [offer, setOffer] = useState<EwayDistanceOffer | null>(null)
  const [busy, setBusy] = useState(false)

  const effectiveTo = toPin.trim() || shipToPincode || ''

  const estimate = async (): Promise<void> => {
    setBusy(true)
    try {
      // Sent explicitly rather than left to the stored ship-to PIN: the address on this form may
      // not be saved yet, and the estimate must describe what the user is looking at.
      setOffer(await api.edoc.estimateDistance(voucherId, fromPin.trim() || null, effectiveTo || null))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Despatch PIN" hint="Not stored anywhere — type where the goods leave from">
          <TextInput
            data-testid="input-distance-from-pin"
            value={fromPin}
            onChange={(e) => setFromPin(e.target.value)}
            placeholder="6 digits"
            className="num w-28"
          />
        </Field>
        <Field label="Delivery PIN" hint={shipToPincode ? `Ship-to PIN ${shipToPincode}` : 'From the ship-to address'}>
          <TextInput
            data-testid="input-distance-to-pin"
            value={toPin}
            onChange={(e) => setToPin(e.target.value)}
            placeholder={shipToPincode ?? '6 digits'}
            className="num w-28"
          />
        </Field>
        <Button data-testid="btn-distance-estimate" disabled={busy} onClick={() => void estimate()}>
          {busy ? 'Estimating…' : 'Estimate distance'}
        </Button>
      </div>

      {offer && offer.estimate && (
        <div className="mt-2 flex flex-col gap-1" data-testid="distance-offer">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-body-sm font-medium text-accent">
              ≈ {offer.estimate.km} km
            </span>
            <span className="text-small text-muted">{offer.estimate.basis}</span>
            <Button data-testid="btn-distance-accept" onClick={() => onAccept(offer.estimate!.km)}>
              Use this distance
            </Button>
          </div>
          {/* PIN_DISTANCE_DISCLAIMER, printed verbatim as the engine writes it. */}
          <p className="text-small text-warn" data-testid="distance-disclaimer">{offer.disclaimer}</p>
        </div>
      )}
      {offer && !offer.estimate && (
        <p className="mt-2 text-small text-muted" data-testid="distance-no-offer">{offer.reason}</p>
      )}
    </div>
  )
}
