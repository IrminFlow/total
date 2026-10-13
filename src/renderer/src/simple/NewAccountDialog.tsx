import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import type { MessageKey } from '@shared/i18n'
import { validateGstin } from '@shared/gst/validate'
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_DEFS,
  INCOME_KINDS,
  groupForKind,
  isPhoneNumber,
  kindFromContext,
  type AccountContext,
  type AccountKind,
  type IncomeKind
} from '@shared/simple/accountKinds'
import { NEW_CATEGORY_KINDS, type CategoryKey, type NewCategoryKind } from '@shared/simple/categories'
import { nearDuplicates } from '@shared/simple/nearDuplicate'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useSession, useToasts } from '../state/stores'
import { Button, Field, Modal, Select, TextInput, useFormErrors } from '../components/ui'
import { useGroups, useLedgers } from '../components/pickers'
import { PlainIcon } from './icons'

/** Label + hint keys per kind (WP 8.2 stubs `simple.people.kind.*` where they exist). */
const KIND_TEXT: Record<AccountKind, { label: MessageKey; hint: MessageKey }> = {
  customer: { label: 'simple.people.kind.customer', hint: 'simple.newAccount.kind.customer.hint' },
  supplier: { label: 'simple.people.kind.supplier', hint: 'simple.newAccount.kind.supplier.hint' },
  expense: { label: 'simple.people.kind.expense', hint: 'simple.newAccount.kind.expense.hint' },
  income: { label: 'simple.people.kind.income', hint: 'simple.newAccount.kind.income.hint' },
  bank: { label: 'simple.people.kind.bank', hint: 'simple.newAccount.kind.bank.hint' },
  cash: { label: 'simple.newAccount.kind.cash', hint: 'simple.newAccount.kind.cash.hint' },
  loan: { label: 'simple.newAccount.kind.loan', hint: 'simple.newAccount.kind.loan.hint' },
  other: { label: 'simple.people.kind.other', hint: 'simple.newAccount.kind.other.hint' }
}
const EXPENSE_TEXT: Record<NewCategoryKind, MessageKey> = {
  day_to_day: 'simple.newAccount.expenseKind.dayToDay',
  stock_you_sell: 'simple.newAccount.expenseKind.stockYouSell',
  use_for_years: 'simple.newAccount.expenseKind.useForYears'
}
const INCOME_TEXT: Record<IncomeKind, MessageKey> = {
  sales: 'simple.newAccount.incomeKind.sales',
  other_income: 'simple.newAccount.incomeKind.otherIncome'
}

const F = { name: 'name', kind: 'kind', group: 'group', phone: 'phone', whatsapp: 'whatsapp', gstin: 'gstin' } as const // i18n-technical: form field paths
type FieldName = (typeof F)[keyof typeof F]

/**
 * WP 8.4 — the plain new-account dialog (plan §4.1): "This is a: Customer / Supplier / Expense /
 * Income / Bank / Cash / Loan / Other…", pre-picked from where it was opened (`context`,
 * accountKinds.ts `kindFromContext`); the answer maps to ONE group (`groupForKind`) — the full
 * list only behind "Other…". Customers / suppliers also get phone, WhatsApp and (in a registered
 * company) GSTIN. A name close to an existing one asks "Did you mean …?" first (nearDuplicate.ts).
 * Shown instead of the accountant forms while the company is in simple mode; "Show every field"
 * opens the accountant form (`onFullForm`).
 */
export function NewAccountDialog({
  name,
  context,
  category,
  onClose,
  onCreated,
  onFullForm
}: {
  name: string
  context: AccountContext
  /** A category key the new account carries (from the category picker's "Something else…" it is
   *  absent — a new name gets no key). */
  category?: CategoryKey
  onClose: () => void
  onCreated: (ledger: Ledger) => void
  onFullForm?: () => void
}): React.JSX.Element {
  const t = useT()
  const lbl = (key: MessageKey): string => t(key) // i18n-technical: keys from the typed label tables above
  const toast = useToasts()
  const queryClient = useQueryClient()
  const ledgers = useLedgers()
  const groups = useGroups()
  const regType = useSession((s) => s.info?.gstRegistrationType ?? 'regular') // i18n-technical
  const manufacturer = useSession((s) => s.ui.setup?.businessType === 'manufacturer')
  const initial = useMemo(() => kindFromContext(context), [context])

  const [accName, setAccName] = useState(name)
  const [kind, setKind] = useState<AccountKind | null>(initial?.kind ?? null)
  const [expenseKind, setExpenseKind] = useState<NewCategoryKind>(initial?.expenseKind ?? 'day_to_day')
  const [incomeKind, setIncomeKind] = useState<IncomeKind>(initial?.incomeKind ?? 'sales') // i18n-technical
  const [groupId, setGroupId] = useState<number | ''>('')
  const [phone, setPhone] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [gstin, setGstin] = useState('')
  const [saving, setSaving] = useState(false)
  // The near-duplicate question is asked once per name: Create shows it, "No, create" answers it.
  const [asked, setAsked] = useState(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  useEffect(() => setAsked(false), [accName])

  const errors = useFormErrors<FieldName>({ name: accName, kind, group: groupId, phone, whatsapp, gstin }, { simple: true, t })
  const party = kind != null && ACCOUNT_KIND_DEFS[kind].party
  const showGstin = party && regType !== 'unregistered'
  const dups = useMemo(() => nearDuplicates(accName, ledgers), [accName, ledgers])
  const sameName = dups.find((d) => d.same)

  const targetGroupId = (): number | null => {
    if (kind == null) return null
    if (kind === 'other') return groupId === '' ? null : groupId
    const g = groupForKind({ kind, expenseKind, incomeKind, makingCost: manufacturer })
    return groups.find((x) => x.name === g)?.id ?? null
  }

  const pickExisting = (id: number): void => {
    const l = ledgers.find((x) => x.id === id)
    if (l) onCreated(l)
  }

  const create = async (): Promise<void> => {
    const trimmed = accName.trim()
    let bad = false
    const fail = (field: FieldName, message: string): void => {
      errors.set(field, message)
      bad = true
    }
    if (!trimmed) fail(F.name, t('simple.newAccount.nameMissing'))
    if (kind == null) fail(F.kind, t('simple.newAccount.kindMissing'))
    if (kind === 'other' && groupId === '') fail(F.group, t('simple.newAccount.kindMissing'))
    if (party && phone.trim() && !isPhoneNumber(phone)) fail(F.phone, t('errors.phoneInvalid'))
    if (party && whatsapp.trim() && !isPhoneNumber(whatsapp)) fail(F.whatsapp, t('errors.phoneInvalid'))
    const gst = showGstin && gstin.trim() ? validateGstin(gstin) : null
    if (gst && !gst.valid) fail(F.gstin, t('errors.gstinInvalid'))
    if (bad) return
    if (dups.length > 0 && (sameName || confirmed !== trimmed)) {
      setAsked(true)
      return
    }
    const gid = targetGroupId()
    if (gid == null) return
    setSaving(true)
    try {
      const l = await api.ledgers.create({
        name: trimmed,
        groupId: gid,
        openingBalance: 0,
        gstin: gst?.valid ? gstin.trim().toUpperCase() : null,
        stateCode: gst?.valid ? (gst.stateCode ?? null) : null,
        address: null,
        taxType: null,
        gstRate: null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: null,
        exportType: null,
        ...(category ? { simpleCategory: category } : {}),
        ...(party ? { phone: phone.trim() || null, whatsapp: whatsapp.trim() || null } : {})
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] }) // i18n-technical
      toast.push('success', t('simple.newAccount.created', { name: l.name }))
      onCreated(l)
    } catch (err) {
      const mapped = errors.apply(err)
      if (mapped.general) toast.push('error', mapped.general)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('simple.newAccount.title')} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="dialog-new-account">
        <Field label={t('simple.newAccount.name')} name={F.name} error={errors.get(F.name)}>
          <TextInput autoFocus value={accName} onChange={(e) => setAccName(e.target.value)} data-testid="input-account-name" />
        </Field>

        {asked && dups.length > 0 && (
          <div role="alert" className="rounded-md border border-amber/60 bg-amberbar/10 px-3 py-2.5" data-testid="account-did-you-mean">
            <p className="text-detail font-semibold text-ink">
              {sameName ? t('simple.newAccount.alreadyThere', { name: sameName.name }) : t('simple.newAccount.didYouMean', { name: dups[0]!.name })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {dups.map((d) => (
                <Button key={d.id} variant="primary" data-testid={`btn-dup-use-${d.id}`} onClick={() => pickExisting(d.id)}>
                  {t('simple.newAccount.useExisting', { name: d.name })}
                </Button>
              ))}
              {!sameName && (
                <Button
                  data-testid="btn-dup-create"
                  onClick={() => {
                    setConfirmed(accName.trim())
                    setAsked(false)
                  }}
                >
                  {t('simple.newAccount.createAnyway', { name: accName.trim() })}
                </Button>
              )}
            </div>
          </div>
        )}

        <div>
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.people.thisIsA')}</span>
          <div role="radiogroup" aria-label={t('simple.people.thisIsA')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ACCOUNT_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                data-testid={`account-kind-${k}`}
                onClick={() => setKind(k)}
                className={`flex flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-amber/70 ${
                  kind === k ? 'border-amber bg-amberbar/15 text-ink' : 'border-line bg-panel text-muted hover:border-amber/60'
                }`}
              >
                <PlainIcon id={ACCOUNT_KIND_DEFS[k].icon} />
                <span className="text-detail font-semibold text-ink">{lbl(KIND_TEXT[k].label)}</span>
                <span className="text-caption text-muted">{lbl(KIND_TEXT[k].hint)}</span>
              </button>
            ))}
          </div>
          {errors.get(F.kind) && (
            <p role="alert" className="mt-1 text-hint text-danger" data-testid="field-error-kind">
              {errors.get(F.kind)}
            </p>
          )}
        </div>

        {kind === 'expense' && (
          <Field label={t('simple.newAccount.expenseKind')}>
            <Select value={expenseKind} onChange={(e) => setExpenseKind(e.target.value as NewCategoryKind)} data-testid="select-expense-kind">
              {NEW_CATEGORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {lbl(EXPENSE_TEXT[k])}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === 'income' && (
          <Field label={t('simple.newAccount.incomeKind')}>
            <Select value={incomeKind} onChange={(e) => setIncomeKind(e.target.value as IncomeKind)} data-testid="select-income-kind">
              {INCOME_KINDS.map((k) => (
                <option key={k} value={k}>
                  {lbl(INCOME_TEXT[k])}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === 'other' && (
          <Field label={t('simple.newAccount.fullList')} name={F.group} error={errors.get(F.group)}>
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : '')} data-testid="select-account-group">
              <option value="">{t('simple.newAccount.fullListPick')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {party && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('simple.newAccount.phone')} name={F.phone} error={errors.get(F.phone)}>
              <TextInput type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="num" data-testid="input-account-phone" />
            </Field>
            <Field label={t('simple.newAccount.whatsapp')} name={F.whatsapp} error={errors.get(F.whatsapp)} hint={t('common.optional')}>
              <TextInput type="tel" inputMode="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className="num" data-testid="input-account-whatsapp" />
            </Field>
            {showGstin && (
              <Field label={t('simple.newAccount.gstin')} name={F.gstin} error={errors.get(F.gstin)} hint={t('simple.newAccount.gstinHint')} className="col-span-2">
                <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" maxLength={15} data-testid="input-account-gstin" />
              </Field>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div>
            {onFullForm && (
              <Button variant="ghost" data-testid="btn-account-full-form" onClick={onFullForm}>
                {t('simple.newAccount.fullForm')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={saving} data-testid="btn-account-create" onClick={() => void create()}>
              {t('simple.newAccount.create')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
