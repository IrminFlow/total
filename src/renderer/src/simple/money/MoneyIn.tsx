import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import type { MessageKey } from '@shared/i18n'
import { toPlainDate } from '@shared/dates'
import { categoriesFor, type AccountContext } from '@shared/simple/accountKinds'
import {
  billAllocation, emptyMoneyInForm, linkedBillName, MONEY_IN_WHO, moneyInErrors, moneyInIntentFrom,
  type MoneyInField, type MoneyInForm, type MoneyInWho
} from '@shared/simple/money'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession, type AskOpen } from '../../state/stores'
import { moneyInFromAsk } from '@shared/simple/askPrefill'
import { AmountInput, Button, DateInput, Field, Page, Select, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead, useGroups, useLedgers } from '../../components/pickers'
import { CategoryPicker } from '../CategoryPicker'
import { NewAccountDialog } from '../NewAccountDialog'
import { SaveCard } from '../SaveCard'
import { BillTicks } from './BillTicks'
import { HowPaid } from './HowPaid'
import { Card, Choices, MoneyFooter, MoneyHeader } from './MoneyParts'
import { ensureCategoryAccount } from './ensureAccount'
import { useMoneyFlow } from './useMoneyFlow'
import { BackToBankButton, goBackToBank } from './backToBank'
import { useAccountantView, useKeptForm } from '../../lib/handoff'

const WHO_TEXT: Record<MoneyInWho, MessageKey> = {
  customer: 'simple.money.in.who.customer',
  owner: 'simple.money.in.who.owner',
  loan: 'simple.money.in.who.loan',
  income: 'simple.money.in.who.income',
  refund: 'simple.money.in.who.refund'
}
const INCOME_KEYS = categoriesFor('income') // i18n-technical
const OWNER_CAPITAL = 'owner_capital' as const // i18n-technical: category key
const F = { date: 'date', party: 'party', amount: 'amount', into: 'into', bills: 'bills' } as const // i18n-technical: form field paths
const IN_SIDE = 'in' as const // i18n-technical
const INCOME_SIDE = 'income' as const // i18n-technical
const INCOME_CTX: AccountContext = { field: 'account', side: 'sales' } // i18n-technical

const isDirty = (f: MoneyInForm): boolean => f.amount != null || f.customerId != null || f.sourceId != null || f.supplierId != null || f.note.trim() !== ''

/**
 * WP 9.4 — Money in (plan §3): who paid (a customer — their bills oldest first, ticked up to the
 * amount — or the owner, a loan, other income, a supplier's refund), how much, and into cash or
 * which bank. The answers become a `money_in` intent (shared/simple/money.ts) saved by
 * simple:post (a receipt through the editor's own mapping); the preview says what will be saved
 * and where the customer then stands. "Accountant view" opens the receipt editor.
 */
export function MoneyIn({ party, amount, bill, billId, date, bankId, reference, note, ask }: {
  party?: number
  amount?: number
  bill?: string
  billId?: number
  /** WP 9.6: opened from a bank statement line — its date, bank account, reference and description. */
  date?: string
  bankId?: number
  reference?: string
  note?: string
  /** WP 10.1: opened from an Ask Total entry request (askPrefill.ts — the same mapping its draft used). */
  ask?: AskOpen<'simple-money-in'>
}): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const ledgers = useLedgers()
  const groups = useGroups()
  const { data: setup } = useQuery({ queryKey: ['simpleMoneySetup'], queryFn: api.simpleMoney.setup }) // i18n-technical
  const blank = (): MoneyInForm => emptyMoneyInForm(workingDate)
  const [form, setForm] = useKeptForm<MoneyInForm>(() => {
    const f = emptyMoneyInForm(date ?? workingDate, { customerId: party ?? null, amount: amount ?? null, bill: bill ?? null, bankId: bankId ?? null, reference: reference ?? null, note: note ?? null })
    return ask ? moneyInFromAsk(f, ask.prefill) : f
  })
  const [creating, setCreating] = useState<{ what: 'customer' | 'loan'; name: string } | null>(null)

  const billsParty = form.who === 'customer' ? form.customerId : null
  const { data: bills } = useQuery({
    queryKey: ['simpleMoneyBills', billsParty, form.date], // i18n-technical
    queryFn: () => api.simpleMoney.bills(billsParty!, form.date),
    enabled: billsParty != null
  })
  const open = useMemo(() => (billsParty != null ? (bills ?? []) : []), [billsParty, bills])
  // Opened for a bill ("Record a payment"): tick that bill by its entry (its open name may carry
  // the FY); one no longer open falls back to oldest first.
  useEffect(() => {
    if (!(bill || billId != null) || !bills || form.ticks?.length !== 1 || form.ticks[0] !== bill) return
    const name = linkedBillName(bills, bill, billId)
    if (name !== bill) setForm((f) => ({ ...f, ticks: name ? [name] : null }))
  }, [bills]) // eslint-disable-line react-hooks/exhaustive-deps
  const sources = { ownerId: setup?.ownerId ?? null }
  const defaults = setup?.defaultsIn ?? { cash: null, upi: null, card: null, bank: null }
  const alloc = useMemo(() => billAllocation(open, form.amount, form.ticks, form.advance), [open, form.amount, form.ticks, form.advance])
  const clientErrors = useMemo(() => (setup ? moneyInErrors(form, open, defaults, sources) : {}), [form, open, setup]) // eslint-disable-line react-hooks/exhaustive-deps
  const intent = useMemo(() => (setup ? moneyInIntentFrom(form, open, defaults, sources) : null), [form, open, setup]) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useFormErrors<MoneyInField>(
    { date: form.date, party: `${form.who}|${form.customerId}|${form.sourceId}|${form.supplierId}`, amount: form.amount, into: `${form.how}|${form.accountId}`, bills: `${form.ticks?.join(',')}|${form.advance}|${form.amount}` },
    { simple: true, t }
  )
  const update = (patch: Partial<MoneyInForm>): void => setForm((f) => ({ ...f, ...patch }))

  const flow = useMoneyFlow<MoneyInField>({
    intent,
    clientErrors,
    errors,
    dirty: isDirty(form),
    // Money the owner put in, with no "Owner's money" account yet: add it on Save.
    prepare: async () => {
      if (form.who !== 'owner' || sources.ownerId != null || form.sourceId != null) return intent
      const id = await ensureCategoryAccount(OWNER_CAPITAL, groups, queryClient)
      return id == null ? null : moneyInIntentFrom({ ...form, sourceId: id }, open, defaults, sources)
    },
    onStartNew: () => setForm(blank()),
    aiDraftId: ask?.draftId ?? null,
    ...(bankId != null ? { leave: () => goBackToBank(bankId) } : {})
  })

  const newLoan = (): void => setCreating({ what: 'loan', name: '' }) // i18n-technical
  const ticked = form.ticks ?? alloc.settled.map((s) => s.name)
  const gets = new Map(alloc.settled.map((s) => [s.name, s.amount]))
  const toggle = (name: string, on: boolean): void => {
    const cur = form.ticks ?? ticked
    update({ ticks: on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name) })
  }
  const showAdvance = form.who === 'customer' && form.customerId != null && (form.amount ?? 0) > 0 && (open.length === 0 || alloc.advance > 0 || alloc.short || form.advance)

  // WP 9.10: the saved entry, or the full receipt editor with these answers filled in.
  const openFull = useAccountantView('simple-money-in') // i18n-technical: screen name
  const accountantView = (always: boolean): void => void openFull({ intent: isDirty(form) ? intent : null, savedId: flow.savedIds?.[0] ?? null, always, keep: { form } })

  const customerOptions = useMemo(() => (setup?.customers ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.phone ? { sub: c.phone } : {}) })), [setup?.customers])
  const supplierOptions = useMemo(() => (setup?.suppliers ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.phone ? { sub: c.phone } : {}) })), [setup?.suppliers])
  const ownerName = ledgers.find((l) => l.id === sources.ownerId)?.name ?? null

  return (
    <Page data-testid="simple-money-in">
      <MoneyHeader title={t('simple.money.in.title')} sub={t('simple.money.in.sub')} onAccountant={accountantView} />
      {flow.savedIds ? (
        <>
          <SaveCard voucherIds={flow.savedIds} onNew={flow.startNew} onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} /> {/* i18n-technical */}
          {bankId != null && <BackToBankButton bankId={bankId} />}
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <Card title={t('simple.money.in.who')} testId="money-in-who">
            <Choices
              label={t('simple.money.in.who')}
              value={form.who}
              options={MONEY_IN_WHO.map((w) => ({ value: w, label: lbl(WHO_TEXT[w]) }))}
              onPick={(who) => update({ who, sourceId: null, ticks: null, advance: false })}
              testId="money-in-who"
            />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
              <div>
                {form.who === 'customer' && (
                  <Field label={t('simple.money.customer')} name={F.party} error={errors.get(F.party)}>
                    <TypeAhead
                      options={customerOptions}
                      value={form.customerId}
                      onPick={(id) => update({ customerId: id, ticks: null, advance: false })}
                      placeholder={t('simple.money.customerPlaceholder')}
                      onCreate={flow.canSave ? (name) => setCreating({ what: 'customer', name }) : undefined} // i18n-technical
                      testId="picker-money-customer"
                      autoFocus
                    />
                  </Field>
                )}
                {form.who === 'refund' && (
                  <Field label={t('simple.money.supplier')} name={F.party} error={errors.get(F.party)}>
                    <TypeAhead options={supplierOptions} value={form.supplierId} onPick={(id) => update({ supplierId: id })} placeholder={t('simple.money.supplierPlaceholder')} testId="picker-money-supplier" />
                  </Field>
                )}
                {form.who === 'owner' && (
                  <div data-testid="money-owner">
                    <p className="text-detail text-ink">{ownerName ? t('simple.money.ownerIn', { name: ownerName }) : t('simple.money.ownerInNew')}</p>
                    {errors.get(F.party) && <p role="alert" className="mt-1 text-hint text-danger" data-testid="field-error-party">{errors.get(F.party)}</p>}
                  </div>
                )}
                {form.who === 'loan' && (
                  <Field label={t('simple.money.loan')} name={F.party} error={errors.get(F.party)}>
                    <div className="flex items-center gap-2">
                      <Select value={form.sourceId ?? ''} onChange={(e) => update({ sourceId: e.target.value ? Number(e.target.value) : null })} data-testid="select-money-loan">
                        <option value="">{t('simple.money.loanPick')}</option>
                        {(setup?.loans ?? []).map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </Select>
                      <Button variant="ghost" data-testid="btn-money-new-loan" onClick={newLoan}>
                        {t('simple.money.loanNew')}
                      </Button>
                    </div>
                  </Field>
                )}
                {form.who === 'income' && (
                  <Field label={t('simple.money.income')} name={F.party} error={errors.get(F.party)}>
                    <CategoryPicker value={form.sourceId} onPick={(id) => update({ sourceId: id })} keys={INCOME_KEYS} side={INCOME_SIDE} context={INCOME_CTX} testId="picker-money-income" />
                  </Field>
                )}
              </div>
              <Field label={t('simple.money.date')} name={F.date} error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-money-date" />
              </Field>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[1fr_2fr]">
              <Field label={t('simple.money.amount')} name={F.amount} error={errors.get(F.amount)}>
                <AmountInput paise={form.amount} onPaise={(p) => update({ amount: p })} testId="input-money-amount" />
              </Field>
              <Field label={t('simple.money.note')}>
                <TextInput value={form.note} placeholder={t('simple.money.notePlaceholder')} onChange={(e) => update({ note: e.target.value })} data-testid="input-money-note" />
              </Field>
            </div>
          </Card>

          {form.who === 'customer' && form.customerId != null && (
            <BillTicks
              side={IN_SIDE}
              bills={open}
              ticked={ticked}
              gets={gets}
              leftOver={alloc.short ? 0 : alloc.advance}
              advance={form.advance}
              showAdvance={showAdvance}
              short={alloc.short}
              error={errors.get(F.bills)}
              onToggle={toggle}
              onAdvance={(v) => update({ advance: v })}
            />
          )}

          <HowPaid side={IN_SIDE} how={form.how} accountId={form.accountId} reference={form.reference} setup={setup ?? null} error={errors.get(F.into)} onChange={update} />

          <MoneyFooter
            preview={flow.preview}
            previewing={flow.previewing}
            ready={Object.keys(clientErrors).length === 0}
            general={flow.general}
            saving={flow.saving}
            canSave={!!setup}
            dirty={isDirty(form)}
            onSave={() => void flow.save()}
            onStartAgain={() => void flow.askDiscard().then((ok) => ok && flow.startNew())}
          />
        </div>
      )}

      {creating?.what === 'customer' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'party', side: 'sales' }} // i18n-technical
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleMoneySetup'] }) // i18n-technical
            update({ customerId: l.id, ticks: null })
          }}
        />
      )}
      {creating?.what === 'loan' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'loan' }} // i18n-technical
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleMoneySetup'] }) // i18n-technical
            update({ sourceId: l.id })
          }}
        />
      )}
    </Page>
  )
}
