import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { AmountInput, Button, Field, Modal, Select, TextInput } from './ui'
import { useGroups } from './pickers'
import { GST_STATES } from '@shared/gst/states'
import { validateGstin } from '@shared/gst/validate'
import { GST_RATE_PRESETS } from '@shared/seed'

const EXPORT_TYPES: { value: NonNullable<Ledger['exportType']> | ''; label: string }[] = [
  { value: '', label: 'None (domestic)' },
  { value: 'sez_wp', label: 'SEZ with payment of tax' },
  { value: 'sez_wop', label: 'SEZ without payment of tax' },
  { value: 'exp_wp', label: 'Export with payment of tax' },
  { value: 'exp_wop', label: 'Export without payment of tax' }
]

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/

const PARTY_GROUPS = ['Sundry Debtors', 'Sundry Creditors']
const TAX_GROUPS = ['Duties & Taxes']
const TRADING_GROUPS = [
  'Sales Accounts', 'Purchase Accounts', 'Direct Incomes', 'Direct Expenses', 'Indirect Incomes', 'Indirect Expenses'
]

/** This group's own name plus every ancestor's name, walking parent_id up to the root. */
function groupAncestryNames(groupId: number, groups: Group[]): string[] {
  const map = new Map(groups.map((g) => [g.id, g]))
  const names: string[] = []
  let g = map.get(groupId)
  while (g) {
    names.push(g.name)
    g = g.parentId ? map.get(g.parentId) : undefined
  }
  return names
}

/** Ledger create/edit form. Which optional fields show depends on the selected group's ancestry:
 *  - Sundry Debtors/Creditors descendants ("party" ledgers) → GSTIN/state/address/PAN/TDS/credit
 *    days/export-SEZ type. No taxType/gstRate/HSN.
 *  - Duties & Taxes descendants ("tax" ledgers) → taxType only.
 *  - Sales/Purchase/Direct+Indirect Income/Expense descendants ("trading" ledgers) → gstRate + HSN,
 *    no taxType.
 *  - Everything else (cash/bank/capital/…) → none of the above; just name/group/opening.
 *  Fields hidden by the current group choice are NOT cleared — their state simply isn't rendered,
 *  so an existing ledger's stored value in a now-hidden field rides through to save() untouched. */
export function LedgerFormModal({ ledger, onClose }: { ledger: Ledger | null; onClose: () => void }): React.JSX.Element {
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: tdsSections } = useQuery({ queryKey: ['tdsSections'], queryFn: api.tds.sections })
  const [name, setName] = useState(ledger?.name ?? '')
  const [groupId, setGroupId] = useState<number>(ledger?.groupId ?? groups.find((g) => g.name === 'Sundry Debtors')?.id ?? groups[0]?.id ?? 1)
  const [opening, setOpening] = useState<number | null>(ledger ? Math.abs(ledger.openingBalance) : null)
  const [openingSide, setOpeningSide] = useState<'dr' | 'cr'>(ledger && ledger.openingBalance < 0 ? 'cr' : 'dr')
  const [gstin, setGstin] = useState(ledger?.gstin ?? '')
  const [stateCode, setStateCode] = useState(ledger?.stateCode ?? '')
  const [address, setAddress] = useState(ledger?.address ?? '')
  const [taxType, setTaxType] = useState(ledger?.taxType ?? '')
  const [gstRate, setGstRate] = useState(ledger?.gstRate?.toString() ?? '')
  const [hsn, setHsn] = useState(ledger?.hsn ?? '')
  const [tdsSectionId, setTdsSectionId] = useState<number | ''>(ledger?.tdsSectionId ?? '')
  const [pan, setPan] = useState(ledger?.pan ?? '')
  const [creditDays, setCreditDays] = useState(ledger?.creditDays?.toString() ?? '')
  const [exportType, setExportType] = useState<NonNullable<Ledger['exportType']> | ''>(ledger?.exportType ?? '')

  const ancestry = useMemo(() => groupAncestryNames(groupId, groups), [groupId, groups])
  const isParty = ancestry.some((n) => PARTY_GROUPS.includes(n))
  const isTaxLedger = !isParty && ancestry.some((n) => TAX_GROUPS.includes(n))
  const isTradingLedger = !isParty && !isTaxLedger && ancestry.some((n) => TRADING_GROUPS.includes(n))

  const panError = isParty && pan.trim() && !PAN_RE.test(pan.trim()) ? 'Invalid PAN — format AAAAA9999A' : null

  const gstinCheck = isParty && gstin.trim() ? validateGstin(gstin) : null
  const gstinError = gstinCheck && !gstinCheck.valid
    ? 'Invalid GSTIN — ' + (gstinCheck.error === 'checksum' ? 'check digit fails, one character is mistyped' : gstinCheck.error)
    : gstinCheck?.valid && stateCode && gstinCheck.stateCode !== stateCode
      ? `GSTIN belongs to ${GST_STATES[gstinCheck.stateCode!]}, but state is set to ${GST_STATES[stateCode]}`
      : null

  const save = async (): Promise<void> => {
    try {
      if (gstinError) return void toast.push('error', gstinError)
      if (panError) return void toast.push('error', panError)
      const effectiveState = stateCode || (gstinCheck?.valid ? gstinCheck.stateCode : null)
      const data = {
        name: name.trim(),
        groupId,
        openingBalance: (opening ?? 0) * (openingSide === 'cr' ? -1 : 1),
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        stateCode: effectiveState || null,
        address: address.trim() || null,
        taxType: (taxType || null) as 'cgst' | 'sgst' | 'igst' | 'cess' | null,
        gstRate: gstRate.trim() ? Number(gstRate) : null,
        hsn: hsn.trim() || null,
        tdsSectionId: tdsSectionId === '' ? null : tdsSectionId,
        pan: pan.trim() ? pan.trim().toUpperCase() : null,
        creditDays: creditDays.trim() ? Number(creditDays) : null,
        exportType: exportType || null
      }
      if (ledger) await api.ledgers.update(ledger.id, data)
      else await api.ledgers.create(data)
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', `Ledger ${ledger ? 'updated' : 'created'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!ledger) return
    if (!window.confirm(`Delete ledger “${ledger.name}”?`)) return
    try {
      await api.ledgers.remove(ledger.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Ledger deleted')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={ledger ? `Edit ${ledger.name}` : 'New ledger'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Under group">
            <Select value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opening balance">
            <div className="flex gap-2">
              <AmountInput paise={opening} onPaise={setOpening} className="flex-1" />
              <button
                className={`num w-12 rounded-md border border-line text-[12.5px] font-medium ${openingSide === 'dr' ? 'text-dr' : 'text-cr'}`}
                onClick={() => setOpeningSide((s) => (s === 'dr' ? 'cr' : 'dr'))}
              >
                {openingSide === 'dr' ? 'Dr' : 'Cr'}
              </button>
            </div>
          </Field>
          {isTaxLedger && (
            <Field label="GST component" hint="Marks this ledger for GST computation and ITC">
              <Select value={taxType ?? ''} onChange={(e) => setTaxType(e.target.value as typeof taxType)}>
                <option value="">Not a GST ledger</option>
                <option value="cgst">CGST</option>
                <option value="sgst">SGST</option>
                <option value="igst">IGST</option>
                <option value="cess">Cess</option>
              </Select>
            </Field>
          )}
        </div>

        {isParty && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="GSTIN" error={gstinError}>
                <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" placeholder="For parties" />
              </Field>
              <Field label="State (place of supply)">
                <Select value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
                  <option value="">Same as company</option>
                  {Object.entries(GST_STATES).map(([code, label]) => (
                    <option key={code} value={code}>
                      {code} — {label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="TDS section" hint="Flags this party for TDS deduction">
                <Select value={tdsSectionId} onChange={(e) => setTdsSectionId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">None</option>
                  {(tdsSections ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.description}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="PAN" error={panError}>
                <TextInput value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} className="num" placeholder="AAAAA9999A" maxLength={10} />
              </Field>
              <Field label="Credit days" hint="Default due date for bills">
                <TextInput value={creditDays} onChange={(e) => setCreditDays(e.target.value)} className="num text-right" placeholder="0" />
              </Field>
            </div>
            <Field label="Export / SEZ type" hint="For e-invoice/e-way classification">
              <Select value={exportType} onChange={(e) => setExportType(e.target.value as typeof exportType)}>
                {EXPORT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Address">
              <TextInput value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
          </>
        )}

        {isTradingLedger && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="GST rate %" hint="For sales/purchase service ledgers">
              <TextInput value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="num" placeholder={GST_RATE_PRESETS.join(' / ')} />
            </Field>
            <Field label="HSN / SAC">
              <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" placeholder="For services" />
            </Field>
          </div>
        )}

        <div className="flex justify-between">
          <div>{ledger && !ledger.isSystem && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()}>
              Save ledger
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
