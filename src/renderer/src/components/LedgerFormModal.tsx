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
import { confirmDialog } from '../lib/dialogs'

const EXPORT_TYPES: { value: NonNullable<Ledger['exportType']> | ''; label: string }[] = [
  { value: '', label: 'None (domestic)' },
  { value: 'sez_wp', label: 'SEZ with payment of tax' },
  { value: 'sez_wop', label: 'SEZ without payment of tax' },
  { value: 'exp_wp', label: 'Export with payment of tax' },
  { value: 'exp_wop', label: 'Export without payment of tax' }
]

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/

export const PARTY_GROUPS = ['Sundry Debtors', 'Sundry Creditors']
export const TAX_GROUPS = ['Duties & Taxes']
export const TRADING_GROUPS = [
  'Sales Accounts', 'Purchase Accounts', 'Direct Incomes', 'Direct Expenses', 'Indirect Incomes', 'Indirect Expenses'
]

/** This group's own name plus every ancestor's name, walking parent_id up to the root. */
export function groupAncestryNames(groupId: number, groups: Group[]): string[] {
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
  const [creditLimit, setCreditLimit] = useState<number | null>(ledger?.creditLimit ?? null)
  // Shown as a percentage because that is how a rate is agreed and argued about; stored as basis
  // points so 18% never becomes 17.999999 on a customer's statement.
  const [interestPct, setInterestPct] = useState(
    ledger?.interestRateBp != null ? (ledger.interestRateBp / 100).toString() : ''
  )
  const [interestGrace, setInterestGrace] = useState(ledger?.interestGraceDays?.toString() ?? '')
  const [salesperson, setSalesperson] = useState(ledger?.salesperson ?? '')
  const [territory, setTerritory] = useState(ledger?.territory ?? '')
  const [msmeStatus, setMsmeStatus] = useState<'' | 'micro' | 'small' | 'medium' | 'not_registered'>(
    ledger?.msmeStatus ?? ''
  )
  const [udyamNumber, setUdyamNumber] = useState(ledger?.udyamNumber ?? '')
  const [phone, setPhone] = useState(ledger?.phone ?? '')
  const [email, setEmail] = useState(ledger?.email ?? '')
  const [exportType, setExportType] = useState<NonNullable<Ledger['exportType']> | ''>(ledger?.exportType ?? '')
  const [bankAccount, setBankAccount] = useState(ledger?.bankAccount ?? '')
  const [bankIfsc, setBankIfsc] = useState(ledger?.bankIfsc ?? '')
  const [bankHolder, setBankHolder] = useState(ledger?.bankHolder ?? '')
  const [bankSharedOk, setBankSharedOk] = useState(ledger?.bankSharedOk ?? false)

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
        creditLimit,
        interestRateBp: interestPct.trim() ? Math.round(Number(interestPct) * 100) : null,
        interestGraceDays: interestGrace.trim() ? Number(interestGrace) : null,
        // '' is stored as NULL, which means "nobody has asked" — deliberately not the same as
        // 'not_registered', because silence is not an exemption from section 43B(h).
        msmeStatus: msmeStatus === '' ? null : msmeStatus,
        udyamNumber: udyamNumber.trim() || null,
        salesperson: salesperson.trim() || null,
        territory: territory.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        exportType: exportType || null,
        // Sent only when they were typed. On an existing party the two-person rule (#388) reads
        // these, so passing them unchanged on every save would fill the queue with requests for
        // changes nobody made — and `undefined` is what tells the service to leave them alone.
        ...(isParty
          ? {
              bankAccount: bankAccount.trim() || null,
              bankIfsc: bankIfsc.trim() ? bankIfsc.trim().toUpperCase() : null,
              bankHolder: bankHolder.trim() || null,
              bankSharedOk
            }
          : {})
      }
      if (ledger) {
        const saved = await api.ledgers.update(ledger.id, data)
        await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
        await queryClient.invalidateQueries({ queryKey: ['bankChanges'] })
        // A change that silently did not take effect would be worse than no rule at all, so the
        // toast says which of the two things happened.
        if (saved.bankChange) {
          toast.push(
            'success',
            'Saved. The bank details are waiting for a second person to confirm — Settings → Approvals.'
          )
          onClose()
          return
        }
      } else {
        await api.ledgers.create(data)
        await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      }
      toast.push('success', `Ledger ${ledger ? 'updated' : 'created'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!ledger) return
    const proceed = await confirmDialog({
      title: 'Delete ledger',
      message: `Delete ledger “${ledger.name}”?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
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
                className={`num w-12 rounded-md border border-line text-body-sm font-medium ${openingSide === 'dr' ? 'text-dr' : 'text-cr'}`}
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
              <Field label="Phone" hint="Used to send payment reminders on WhatsApp">
                <TextInput
                  data-testid="input-ledger-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="num"
                  placeholder="98765 43210"
                  inputMode="tel"
                />
              </Field>
              <Field label="Email" hint="Falls back to an email draft when there is no phone">
                <TextInput
                  data-testid="input-ledger-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="accounts@example.com"
                  inputMode="email"
                />
              </Field>
              <Field label="Credit limit" hint="Warns at entry; blocks under F11 enforcement. Blank = no limit">
                <AmountInput testId="input-ledger-credit-limit" paise={creditLimit} onPaise={setCreditLimit} />
              </Field>
              <Field label="Interest % p.a." hint="On overdue bills. Blank = the company default">
                <TextInput
                  data-testid="input-ledger-interest"
                  value={interestPct}
                  onChange={(e) => setInterestPct(e.target.value)}
                  className="num text-right"
                  placeholder="18"
                  inputMode="decimal"
                />
              </Field>
              <Field label="Interest grace days" hint="Days past due before interest starts running">
                <TextInput
                  value={interestGrace}
                  onChange={(e) => setInterestGrace(e.target.value)}
                  className="num text-right"
                  placeholder="0"
                  inputMode="numeric"
                />
              </Field>
              <Field
                label="MSME status"
                hint="From their Udyam certificate. Micro and small bring section 43B(h) into play; blank means nobody has asked."
              >
                <Select
                  data-testid="select-ledger-msme"
                  value={msmeStatus}
                  onChange={(e) => setMsmeStatus(e.target.value as typeof msmeStatus)}
                >
                  <option value="">Not asked</option>
                  <option value="micro">Micro</option>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="not_registered">Not registered</option>
                </Select>
              </Field>
              <Field label="Udyam number" hint="Printed on the certificate they gave you">
                <TextInput
                  data-testid="input-ledger-udyam"
                  value={udyamNumber}
                  onChange={(e) => setUdyamNumber(e.target.value.toUpperCase())}
                  className="num"
                  placeholder="UDYAM-XX-00-0000000"
                />
              </Field>
              <Field label="Salesperson" hint="Groups the ageing report by who owns the relationship">
                <TextInput
                  data-testid="input-ledger-salesperson"
                  value={salesperson}
                  onChange={(e) => setSalesperson(e.target.value)}
                  placeholder="Ravi"
                />
              </Field>
              <Field label="Territory" hint="Groups the ageing report by where they are">
                <TextInput
                  data-testid="input-ledger-territory"
                  value={territory}
                  onChange={(e) => setTerritory(e.target.value)}
                  placeholder="North"
                />
              </Field>
              <Field label="Bank account" hint="Where this party is paid. Changing it needs a second person">
                <TextInput
                  data-testid="input-ledger-bank-account"
                  value={bankAccount}
                  onChange={(e) => setBankAccount(e.target.value)}
                  className="num"
                  placeholder="001234567890"
                />
              </Field>
              <Field label="IFSC">
                <TextInput
                  data-testid="input-ledger-bank-ifsc"
                  value={bankIfsc}
                  onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
                  className="num"
                  placeholder="HDFC0001234"
                />
              </Field>
              <Field label="Account holder" hint="As the bank has it — often not the ledger name">
                <TextInput
                  data-testid="input-ledger-bank-holder"
                  value={bankHolder}
                  onChange={(e) => setBankHolder(e.target.value)}
                  placeholder="Kumar Traders"
                />
              </Field>
              <Field
                label="Shared account"
                hint="A proprietor and their firm, say. Stops the exceptions report flagging this pair"
              >
                <label className="flex items-center gap-2 text-body-sm">
                  <input
                    type="checkbox"
                    data-testid="input-ledger-bank-shared-ok"
                    checked={bankSharedOk}
                    onChange={(e) => setBankSharedOk(e.target.checked)}
                  />
                  This account is knowingly shared with another party
                </label>
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
            <Button variant="primary" data-testid="btn-ledger-save" onClick={() => void save()}>
              Save ledger
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
