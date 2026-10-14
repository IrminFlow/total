import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import type { MessageKey } from '@shared/i18n'
import { toPlainDate } from '@shared/dates'
import { gstRegistrationOf } from '@shared/gst/registration'
import { slabsOn } from '@shared/gst/rateTable'
import { categoriesFor, type AccountContext } from '@shared/simple/accountKinds'
import type { CategoryKey } from '@shared/simple/categories'
import {
  billAllocation, emptyMoneyOutForm, linkedBillName, expenseGstApplies, MONEY_OUT_WHO, moneyOutErrors, moneyOutFieldOf, moneyOutIntentFrom,
  type MoneyOutField, type MoneyOutForm, type MoneyOutWho
} from '@shared/simple/money'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { AmountInput, DateInput, Field, FieldError, Page, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead, useGroups, useLedgers } from '../../components/pickers'
import { CategoryPicker } from '../CategoryPicker'
import { NewAccountDialog } from '../NewAccountDialog'
import { SaveCard } from '../SaveCard'
import { BillTicks } from './BillTicks'
import { HowPaid } from './HowPaid'
import { Card, Choices, MoneyFooter, MoneyHeader } from './MoneyParts'
import { ensureCategoryAccount } from './ensureAccount'
import { useMoneyFlow } from './useMoneyFlow'

const WHO_TEXT: Record<MoneyOutWho, MessageKey> = {
  supplier: 'simple.money.out.who.supplier',
  expense: 'simple.money.out.who.expense',
  owner: 'simple.money.out.who.owner',
  salary: 'simple.money.out.who.salary'
}
const EXPENSE_KEYS = categoriesFor('expense') // i18n-technical
const SALARY_KEYS: readonly CategoryKey[] = ['salary'] // i18n-technical: category key
const PAYMENT = 'payment' as const // i18n-technical
const DRAWINGS = 'owner_drawings' as const // i18n-technical: category key
const F = { date: 'date', party: 'party', amount: 'amount', from: 'from', bills: 'bills', gstBill: 'gstBill', billSupplier: 'billSupplier', billNo: 'billNo', gstRate: 'gstRate' } as const // i18n-technical: form field paths
const OUT_SIDE = 'out' as const // i18n-technical
const EXPENSE_SIDE = 'expense' as const // i18n-technical
const EXPENSE_CTX: AccountContext = { field: 'line', voucherKind: 'payment', drCr: 'dr' } // i18n-technical

const isDirty = (f: MoneyOutForm): boolean => f.amount != null || f.supplierId != null || f.payeeId != null || f.note.trim() !== '' || f.billNo.trim() !== ''

/**
 * WP 9.4 — Money out (plan §3): paid to a supplier (their bills oldest first), an expense
 * (category picker; with a GST bill under a regular registration → the bill + this payment in one
 * intent, so its GST is recorded as the editor would), the owner (drawings — not a business
 * expense) or salary (Payroll on); how much; from cash or which bank. TDS: when it is on and the
 * existing eligibility rules fire, a read-only hint points at the accountant view (no TDS is
 * added here). "Accountant view" opens the payment editor.
 */
export function MoneyOut({ party, amount, bill, billId }: { party?: number; amount?: number; bill?: string; billId?: number }): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const queryClient = useQueryClient()
  const { info, workingDate } = useSession()
  const ledgers = useLedgers()
  const groups = useGroups()
  const { data: setup } = useQuery({ queryKey: ['simpleMoneySetup'], queryFn: api.simpleMoney.setup }) // i18n-technical
  const blank = (): MoneyOutForm => emptyMoneyOutForm(workingDate)
  const [form, setForm] = useState<MoneyOutForm>(() => emptyMoneyOutForm(workingDate, { supplierId: party ?? null, amount: amount ?? null, bill: bill ?? null }))
  const [creating, setCreating] = useState<{ what: 'supplier' | 'billSupplier'; name: string } | null>(null)

  const facts = useMemo(() => (info ? gstRegistrationOf(info) : null), [info])
  const gstAsk = !!facts && expenseGstApplies(facts, form)
  const purchase = gstAsk && form.gstBill === true
  const billsParty = form.who === 'supplier' ? form.supplierId : null
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
  const defaults = setup?.defaultsOut ?? { cash: null, upi: null, card: null, bank: null }
  const ctx = useMemo(
    () =>
      facts && info
        ? {
            facts,
            companyStateCode: info.stateCode,
            supplierState: (id: number) => setup?.suppliers.find((s) => s.id === id)?.stateCode ?? null,
            drawingsId: setup?.drawingsId ?? null
          }
        : null,
    [facts, info, setup]
  )
  const alloc = useMemo(() => billAllocation(open, form.amount, form.ticks, form.advance), [open, form.amount, form.ticks, form.advance])
  const clientErrors = useMemo(() => (setup && ctx ? moneyOutErrors(form, open, defaults, ctx) : {}), [form, open, setup, ctx]) // eslint-disable-line react-hooks/exhaustive-deps
  const intent = useMemo(() => (setup && ctx ? moneyOutIntentFrom(form, open, defaults, ctx) : null), [form, open, setup, ctx]) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useFormErrors<MoneyOutField>(
    {
      date: form.date, party: `${form.who}|${form.supplierId}|${form.payeeId}`, amount: form.amount, from: `${form.how}|${form.accountId}`,
      bills: `${form.ticks?.join(',')}|${form.advance}|${form.amount}`, gstBill: form.gstBill, billSupplier: form.billSupplierId, billNo: form.billNo, gstRate: form.gstRate
    },
    { simple: true, t }
  )
  const update = (patch: Partial<MoneyOutForm>): void => setForm((f) => ({ ...f, ...patch }))

  const flow = useMoneyFlow<MoneyOutField>({
    intent,
    clientErrors,
    errors,
    dirty: isDirty(form),
    mapField: (f) => moneyOutFieldOf(f, purchase),
    // Money the owner took, with no "Owner's drawings" account yet: add it on Save.
    prepare: async () => {
      if (form.who !== 'owner' || setup?.drawingsId != null) return intent
      const id = await ensureCategoryAccount(DRAWINGS, groups, queryClient)
      return id == null ? null : intent
    },
    onStartNew: () => setForm(blank())
  })

  const ticked = form.ticks ?? alloc.settled.map((s) => s.name)
  const gets = new Map(alloc.settled.map((s) => [s.name, s.amount]))
  const toggle = (name: string, on: boolean): void => {
    const cur = form.ticks ?? ticked
    update({ ticks: on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name) })
  }
  const showAdvance = form.who === 'supplier' && form.supplierId != null && (form.amount ?? 0) > 0 && (open.length === 0 || alloc.advance > 0 || alloc.short || form.advance)

  const accountantView = (): void => {
    if (flow.savedIds) nav.go({ name: 'voucher-entry', voucherId: flow.savedIds[flow.savedIds.length - 1]! }) // i18n-technical
    else nav.go({ name: 'voucher-entry', kindHint: PAYMENT }) // i18n-technical
  }

  const supplierOptions = useMemo(() => (setup?.suppliers ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.phone ? { sub: c.phone } : {}) })), [setup?.suppliers])
  const drawingsName = ledgers.find((l) => l.id === setup?.drawingsId)?.name ?? null
  const whoChoices = MONEY_OUT_WHO.filter((w) => w !== 'salary' || setup?.payroll)
  const slabs = useMemo(() => slabsOn(form.date), [form.date])

  return (
    <Page data-testid="simple-money-out">
      <MoneyHeader title={t('simple.money.out.title')} sub={t('simple.money.out.sub')} onAccountant={accountantView} />
      {flow.savedIds ? (
        <SaveCard voucherIds={flow.savedIds} onNew={flow.startNew} onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} /> // i18n-technical
      ) : (
        <div className="flex flex-col gap-4">
          <Card title={t('simple.money.out.who')} testId="money-out-who">
            <Choices
              label={t('simple.money.out.who')}
              value={form.who}
              options={whoChoices.map((w) => ({ value: w, label: lbl(WHO_TEXT[w]) }))}
              onPick={(who) => update({ who, payeeId: null, ticks: null, advance: false, gstBill: null })}
              testId="money-out-who"
            />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
              <div>
                {form.who === 'supplier' && (
                  <Field label={t('simple.money.supplier')} name={F.party} error={errors.get(F.party)}>
                    <TypeAhead
                      options={supplierOptions}
                      value={form.supplierId}
                      onPick={(id) => update({ supplierId: id, ticks: null, advance: false })}
                      placeholder={t('simple.money.supplierPlaceholder')}
                      onCreate={(name) => setCreating({ what: 'supplier', name })} // i18n-technical
                      testId="picker-money-supplier"
                      autoFocus
                    />
                  </Field>
                )}
                {form.who === 'expense' && (
                  <Field label={t('simple.money.expense')} name={F.party} error={errors.get(F.party)}>
                    <CategoryPicker value={form.payeeId} onPick={(id) => update({ payeeId: id })} keys={EXPENSE_KEYS} side={EXPENSE_SIDE} context={EXPENSE_CTX} testId="picker-money-expense" />
                  </Field>
                )}
                {form.who === 'salary' && (
                  <Field label={t('simple.money.salary')} name={F.party} error={errors.get(F.party)}>
                    <CategoryPicker value={form.payeeId} onPick={(id) => update({ payeeId: id })} keys={SALARY_KEYS} side={EXPENSE_SIDE} context={EXPENSE_CTX} testId="picker-money-salary" />
                  </Field>
                )}
                {form.who === 'owner' && (
                  <div data-testid="money-owner">
                    <p className="text-detail text-ink">{drawingsName ? t('simple.money.ownerOut', { name: drawingsName }) : t('simple.money.ownerOutNew')}</p>
                    <FieldError name={F.party} error={errors.get(F.party)} />
                  </div>
                )}
              </div>
              <Field label={t('simple.money.date')} name={F.date} error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={toPlainDate} testId="input-money-date" />
              </Field>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[1fr_2fr]">
              <Field label={purchase ? t('simple.money.amountBill') : t('simple.money.amount')} name={F.amount} error={errors.get(F.amount)}>
                <AmountInput paise={form.amount} onPaise={(p) => update({ amount: p })} testId="input-money-amount" />
              </Field>
              <Field label={t('simple.money.note')}>
                <TextInput value={form.note} placeholder={t('simple.money.notePlaceholder')} onChange={(e) => update({ note: e.target.value })} data-testid="input-money-note" />
              </Field>
            </div>
          </Card>

          {gstAsk && (
            <Card title={t('simple.money.gstBill')} testId="money-gst-bill">
              <Choices
                label={t('simple.money.gstBill')}
                value={form.gstBill == null ? null : form.gstBill ? 'yes' : 'no'} // i18n-technical
                options={[
                  { value: 'yes', label: t('simple.money.gstBillYes') }, // i18n-technical
                  { value: 'no', label: t('simple.money.gstBillNo') } // i18n-technical
                ]}
                onPick={(v) => update({ gstBill: v === 'yes' })} // i18n-technical
                testId="money-gst-bill"
              />
              <FieldError name={F.gstBill} error={errors.get(F.gstBill)} />
              {form.gstBill && (
                <>
                  <p className="mt-2 text-small text-muted">{t('simple.money.gstBillHint')}</p>
                  <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
                    <Field label={t('simple.money.billSupplier')} name={F.billSupplier} error={errors.get(F.billSupplier)}>
                      <TypeAhead
                        options={supplierOptions}
                        value={form.billSupplierId}
                        onPick={(id) => update({ billSupplierId: id })}
                        placeholder={t('simple.money.supplierPlaceholder')}
                        onCreate={(name) => setCreating({ what: 'billSupplier', name })} // i18n-technical
                        testId="picker-money-bill-supplier"
                      />
                    </Field>
                    <Field label={t('simple.money.billNo')} name={F.billNo} error={errors.get(F.billNo)}>
                      <TextInput value={form.billNo} onChange={(e) => update({ billNo: e.target.value })} data-testid="input-money-bill-no" />
                    </Field>
                  </div>
                  <div className="mt-3">
                    <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.money.gstRate')}</span>
                    <Choices
                      label={t('simple.money.gstRate')}
                      value={form.gstRate == null ? null : String(form.gstRate)}
                      options={slabs.map((s) => ({ value: String(s.rate), label: s.rate === 0 ? t('simple.money.gstNil') : `${s.rate}%` }))}
                      onPick={(v) => update({ gstRate: Number(v) })}
                      testId="money-gst-rate"
                    />
                    <FieldError name={F.gstRate} error={errors.get(F.gstRate)} />
                  </div>
                </>
              )}
            </Card>
          )}

          {form.who === 'supplier' && form.supplierId != null && (
            <BillTicks
              side={OUT_SIDE}
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

          <HowPaid side={OUT_SIDE} how={form.how} accountId={form.accountId} reference={form.reference} setup={setup ?? null} error={errors.get(F.from)} onChange={update} />

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

      {creating && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'party', side: 'purchase' }} // i18n-technical
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            const what = creating.what
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleMoneySetup'] }) // i18n-technical
            update(what === 'supplier' ? { supplierId: l.id, ticks: null } : { billSupplierId: l.id }) // i18n-technical
          }}
        />
      )}
    </Page>
  )
}
