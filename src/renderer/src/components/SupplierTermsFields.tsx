// Supplier MSME facts and payment terms on the ledger form (WP 4.3, migration 034) — shown for
// Sundry Creditors. The MSMED Act s.15 deadline needs: registered on Udyam, category micro / small
// (medium enterprises are not s.2(n) suppliers), and the credit period agreed in writing.
import { useState } from 'react'
import type { Ledger } from '@shared/domain'
import { isValidUdyam, MSME_CATEGORIES, MSME_CATEGORY_LABELS, normalizeUdyam, S15_MAX_AGREED_DAYS, type MsmeCategory } from '@shared/payables/msme'
import { DateInput, Field, Select, TextInput } from './ui'
import { todayISO } from '@shared/dates'

export interface SupplierTermsState {
  msmeRegistered: boolean
  /** ISO date or ''. */
  registeredFrom: string
  udyamNo: string
  msmeCategory: MsmeCategory | ''
  agreedCreditDays: string
  discountPct: string
  discountDays: string
}

export function initialSupplierTerms(l: Ledger | null): SupplierTermsState {
  return {
    msmeRegistered: l?.msmeRegistered ?? false,
    registeredFrom: l?.msmeRegisteredFrom ?? '',
    udyamNo: l?.udyamNo ?? '',
    msmeCategory: l?.msmeCategory ?? '',
    agreedCreditDays: l?.agreedCreditDays?.toString() ?? '',
    discountPct: l?.earlyPaymentDiscountBp ? (l.earlyPaymentDiscountBp / 100).toString() : '',
    discountDays: l?.earlyPaymentDiscountDays?.toString() ?? ''
  }
}

/** Validation message for the state, or null. */
export function supplierTermsError(s: SupplierTermsState): string | null {
  if (s.udyamNo.trim() && !isValidUdyam(s.udyamNo)) return 'Udyam number is UDYAM-XX-00-0000000'
  if (s.agreedCreditDays.trim() && !/^\d+$/.test(s.agreedCreditDays.trim())) return 'Agreed days must be a whole number'
  if (s.discountPct.trim() && !(Number(s.discountPct) >= 0 && Number(s.discountPct) <= 100)) return 'Discount must be a percentage'
  return null
}

/** The ledger payload fields (all sent: the form shows them for creditors only). */
export function supplierTermsPayload(s: SupplierTermsState): Pick<
  Ledger, 'msmeRegistered' | 'msmeRegisteredFrom' | 'udyamNo' | 'msmeCategory' | 'agreedCreditDays' | 'earlyPaymentDiscountBp' | 'earlyPaymentDiscountDays'
> {
  const pct = s.discountPct.trim() ? Math.round(Number(s.discountPct) * 100) : null
  return {
    msmeRegistered: s.msmeRegistered,
    msmeRegisteredFrom: s.msmeRegistered && s.registeredFrom ? s.registeredFrom : null,
    udyamNo: s.udyamNo.trim() ? normalizeUdyam(s.udyamNo) : null,
    msmeCategory: s.msmeCategory || null,
    agreedCreditDays: s.agreedCreditDays.trim() ? Number(s.agreedCreditDays) : null,
    earlyPaymentDiscountBp: pct && pct > 0 ? pct : null,
    earlyPaymentDiscountDays: pct && pct > 0 && s.discountDays.trim() ? Number(s.discountDays) : null
  }
}

export function SupplierTermsFields({ value, onChange }: { value: SupplierTermsState; onChange: (s: SupplierTermsState) => void }): React.JSX.Element {
  const [touched, setTouched] = useState(false)
  const set = (patch: Partial<SupplierTermsState>): void => onChange({ ...value, ...patch })
  const udyamBad = touched && value.udyamNo.trim() !== '' && !isValidUdyam(value.udyamNo)
  const agreed = Number(value.agreedCreditDays)
  const capNote = value.agreedCreditDays.trim() && agreed > S15_MAX_AGREED_DAYS ? `More than ${S15_MAX_AGREED_DAYS}: s.15 caps it at ${S15_MAX_AGREED_DAYS} days` : null
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line px-3 pt-1 pb-3" data-testid="ledger-supplier-terms">
      <legend className="px-1 text-caption text-muted">MSME and payment terms</legend>
      <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.3fr)] gap-3">
        <Field label="MSME (Udyam)" hint="Registered micro / small / medium enterprise">
          <span className="flex h-[34px] items-center gap-2 text-detail">
            <input type="checkbox" data-testid="ledger-msme-registered" checked={value.msmeRegistered} onChange={(e) => set({ msmeRegistered: e.target.checked })} />
            Registered on Udyam
          </span>
        </Field>
        <Field label="Category" hint={value.msmeCategory === 'medium' ? 'Medium: no s.15 deadline (not a s.2(n) supplier)' : 'Micro / small get the s.15 deadline'}>
          <Select data-testid="ledger-msme-category" value={value.msmeCategory} onChange={(e) => set({ msmeCategory: e.target.value as MsmeCategory | '' })}>
            <option value="">—</option>
            {MSME_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MSME_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Udyam number" error={udyamBad ? 'Format UDYAM-XX-00-0000000' : null}>
          <TextInput
            data-testid="ledger-udyam-no"
            value={value.udyamNo}
            onChange={(e) => set({ udyamNo: e.target.value.toUpperCase() })}
            onBlur={() => setTouched(true)}
            className="num"
            placeholder="UDYAM-MH-00-0000000"
            maxLength={19}
          />
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Registered from" hint="Bills before it are not covered">
          <DateInput value={value.registeredFrom} context={value.registeredFrom || todayISO()} onChange={(v) => set({ registeredFrom: v })} allowEmpty testId="ledger-msme-from" />
        </Field>
        <Field label="Agreed days (in writing)" hint={capNote ?? 'Blank = no written agreement: 15 days'}>
          <TextInput data-testid="ledger-agreed-days" value={value.agreedCreditDays} onChange={(e) => set({ agreedCreditDays: e.target.value })} className="num text-right" placeholder="—" />
        </Field>
        <Field label="Early-payment discount %" hint="Offered by the supplier">
          <TextInput data-testid="ledger-discount-pct" value={value.discountPct} onChange={(e) => set({ discountPct: e.target.value })} className="num text-right" placeholder="0" />
        </Field>
        <Field label="…if paid within days">
          <TextInput data-testid="ledger-discount-days" value={value.discountDays} onChange={(e) => set({ discountDays: e.target.value })} className="num text-right" placeholder="10" />
        </Field>
      </div>
    </fieldset>
  )
}
