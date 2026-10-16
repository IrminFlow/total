import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { slabsOn } from '@shared/gst/rateTable'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import {
  emptyReturnForm, returnAsks, returnFormErrors, returnIntentFrom, returnPreviewLines, returnSplit, returnTotals,
  type ReturnBill, type ReturnContext, type ReturnField, type ReturnForm, type ReturnSide
} from '@shared/simple/returns'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { useNav, useSession } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, FieldError, isAnyModalOpen, Page, TextInput, useFormErrors } from '../../components/ui'
import { useLedgers, useStockItems } from '../../components/pickers'
import { NewAccountDialog } from '../NewAccountDialog'
import { SaveCard } from '../SaveCard'
import { BillPicker } from './BillPicker'
import { ReturnLines } from './ReturnLines'
import { RefundHow } from './RefundHow'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'
import { SaveBar } from '../SaveBar'
import { useCanSave, ViewerNote } from '../ViewerNote'

const F = { date: 'date', items: 'items', amount: 'amount', gstRate: 'gstRate', refund: 'refund' } as const satisfies Record<ReturnField, ReturnField> // i18n-technical: form field paths
const INVALIDATE = ['simpleReturnBills', 'simpleReturnBill', 'simpleSales', 'simpleSale', 'simplePurchases', 'simplePurchase', 'stockItems', 'dashboard'] // i18n-technical: query keys

const isDirty = (f: ReturnForm): boolean => f.amount != null || f.reason.trim() !== '' || Object.values(f.qty).some((q) => q.trim() !== '' && q.trim() !== '0')

/**
 * WP 9.5 — Return a sale / Return a purchase (plan §3): which bill (a plain list of recent bills
 * with what is still returnable, searchable by party and bill number); what came back (the bill's
 * products and how many — or an amount, for a bill without products); a reason (optional); and,
 * for what doesn't simply come off the bill, "Give the money back, or keep it for the next bill?".
 * The answers become a `return_sale` / `return_purchase` intent (shared/simple/returns.ts) that
 * simple:post saves through the editors' own mapping — a return linked to the bill's lines (stock
 * back in for products), its GST from the bill, the refund in the same save. The totals are the
 * editor's calculation; the plain preview comes from simple:preview; the save card's Undo takes the
 * return and its refund back together. "Accountant view" opens the full return editor.
 */
export function ReturnScreen({ side, billId: initialBill }: { side: ReturnSide; billId?: number }): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { info, workingDate } = useSession()
  const items = useStockItems()
  const ledgers = useLedgers()
  const sale = side === 'sale' // i18n-technical
  const [billId, setBillId] = useState<number | null>(initialBill ?? null)
  const [form, setForm] = useState<ReturnForm>(() => emptyReturnForm(workingDate))
  const [savedIds, setSavedIds] = useState<number[] | null>(null)
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [addingBank, setAddingBank] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const poster = useSimplePost()
  const saving = poster.status === 'posting'

  const { data: bill, isLoading: billLoading } = useQuery({
    queryKey: ['simpleReturnBill', side, billId, form.date], // i18n-technical
    queryFn: () => api.simple.returnBill(side, billId!, form.date),
    enabled: billId != null && !savedIds,
    placeholderData: (prev) => (prev && prev.voucherId === billId ? prev : undefined)
  })
  const { data: setup } = useQuery({ queryKey: ['simpleSellSetup'], queryFn: api.simple.sellSetup }) // i18n-technical

  // A walk-in customer gets the money back (the counter's party holds no credit).
  const walkIn = !!bill?.walkIn
  useEffect(() => {
    if (walkIn) setForm((f) => (f.settle === 'refund' ? f : { ...f, settle: 'refund' })) // i18n-technical
  }, [walkIn])

  const ctx: ReturnContext | null = useMemo(
    () =>
      info
        ? {
            invoice: {
              companyStateCode: info.stateCode,
              ...gstRegistrationOf(info),
              items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
              ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
            }
          }
        : null,
    [info, items, ledgers]
  )
  const totals = useMemo(() => (bill && ctx ? returnTotals(form, bill, ctx) : null), [form, bill, ctx])
  const split = bill && totals ? returnSplit(totals.total, bill.pending) : { offBill: 0, credit: 0 }
  const asks = bill && ctx ? returnAsks(form, bill, ctx) : { rate: false, blocked: false }
  const refundAccounts = (setup?.moneyAccounts ?? []).some((a) => (form.how === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const clientErrors = useMemo(
    () => (bill && ctx ? returnFormErrors(form, bill, ctx, { refundAccount: refundAccounts }) : {}),
    [form, bill, ctx, refundAccounts]
  )
  const errors = useFormErrors<ReturnField>(
    { date: form.date, items: JSON.stringify(form.qty), amount: form.amount, gstRate: form.gstRate, refund: `${form.settle}|${form.how}|${form.accountId}` },
    { simple: true, t }
  )

  const nothingLeft = !!bill && (bill.mode === 'items' ? bill.lines.every((l) => l.leftMilli <= 0) : bill.amountLeft != null && bill.amountLeft <= 0)
  const dirty = !savedIds && isDirty(form)
  useUnsavedGuard(dirty)

  const update = (patch: Partial<ReturnForm>): void => {
    setGeneral(null)
    setForm((f) => ({ ...f, ...patch }))
  }
  const pickBill = (id: number): void => {
    poster.reset()
    errors.clear()
    setGeneral(null)
    setPreview(null)
    setRateOpen(false)
    setForm((f) => emptyReturnForm(f.date))
    setBillId(id)
  }
  const startNew = (): void => {
    poster.reset()
    errors.clear()
    setGeneral(null)
    setPreview(null)
    setSavedIds(null)
    setRateOpen(false)
    setForm(emptyReturnForm(workingDate))
    setBillId(null)
  }

  // ---------- the plain preview (simple:preview, rehearsed — nothing saved) ----------
  const intent = useMemo(() => (bill && ctx && setup ? returnIntentFrom(form, bill, ctx, setup.defaults) : null), [form, bill, ctx, setup])
  const intentKey = intent ? JSON.stringify(intent) : ''
  const ready = !!intent && !nothingLeft && Object.keys(clientErrors).length === 0
  const previewRef = useRef(poster.preview)
  previewRef.current = poster.preview
  useEffect(() => {
    setPreview(null)
    setPreviewProblem(null)
    if (!ready || savedIds) return
    const id = window.setTimeout(() => {
      previewRef.current(intent!).then(
        (p) => setPreview(p),
        (err: unknown) => {
          setPreview(null)
          const m = mapError(err as CaughtError, { simple: true, t })
          setPreviewProblem([m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('simple.returns.err.problem'))
        }
      )
    }, 350)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, ready, savedIds])

  // ---------- save ----------
  const save = async (): Promise<void> => {
    if (!bill || !ctx || !setup || saving || nothingLeft) return
    setGeneral(null)
    const keys = Object.entries(clientErrors) as [ReturnField, string][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.returns.err.amount')) // i18n-technical: keys from returnFormErrors
      return
    }
    try {
      const r = await poster.post(returnIntentFrom(form, bill, ctx, setup.defaults))
      setSavedIds(r.voucherIds)
      for (const k of INVALIDATE) void queryClient.invalidateQueries({ queryKey: [k] })
    } catch (err) {
      const caught = err as CaughtError
      const mapped = errors.apply(err)
      if (mapped.general || Object.keys(mapped.fields).length === 0) {
        setGeneral({ text: mapped.general || t('simple.returns.err.problem'), details: mapError(caught, { simple: true, t }).details })
      }
    }
  }

  // ⌘↵ saves (capture phase, ahead of the app's own shortcuts).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen() || addingBank) return
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!savedIds && bill && canSave) void save() // WP 10.8 review: a viewer's ⌘↵ saves nothing (the note says why)
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  // WP 9.10: the saved note, or the full return editor with these answers filled in.
  const openFull = useAccountantView(side === 'sale' ? 'simple-return-sale' : 'simple-return-purchase') // i18n-technical: screen names
  const accountantView = (always: boolean): void => void openFull({ intent: dirty ? intent : null, savedId: savedIds?.[0] ?? null, always })

  const money = (p: number): string => formatPaise(p, { symbol: true })
  const partyLabel = (b: ReturnBill): string => (b.walkIn ? t('simple.sales.cashCustomer') : b.partyName)
  const billNo = (b: ReturnBill): string => (sale ? b.number : (b.billNo ?? b.number))
  const slabs = slabsOn(form.date)
  const rateChoices = bill?.rates && bill.rates.length > 1 ? bill.rates : slabs.filter((s) => s.common || rateOpen).map((s) => s.rate)

  return (
    <Page data-testid={sale ? 'simple-return-sale' : 'simple-return-purchase'}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{sale ? t('simple.returns.titleSale') : t('simple.returns.titlePurchase')}</h1>
          <p className="mt-1 text-detail text-muted">{sale ? t('simple.returns.subtitleSale') : t('simple.returns.subtitlePurchase')}</p>
        </div>
        <AccountantViewButton testId="btn-return-accountant-view" title={t('simple.returns.accountantHint')} onOpen={accountantView} />
      </div>
      {!canSave && <ViewerNote top />}

      {savedIds ? (
        <SaveCard
          voucherIds={savedIds}
          skipParties={walkIn}
          onNew={startNew}
          onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} // i18n-technical
          onUndone={() => {
            for (const k of INVALIDATE) void queryClient.invalidateQueries({ queryKey: [k] })
          }}
        />
      ) : billId == null ? (
        <BillPicker side={side} onPick={pickBill} />
      ) : !bill ? (
        <p className="text-detail text-muted" data-testid="return-bill-loading">
          {billLoading ? t('simple.sell.preview.checking') : t('simple.returns.billMissing')}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* The bill */}
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="return-bill" data-bill={bill.voucherId}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-subtitle font-semibold text-ink" data-testid="return-bill-head">
                  {t('simple.returns.billHead', { number: billNo(bill), name: partyLabel(bill), date: toPlainDate(bill.date, t.lang) })}
                </h2>
                <p className="mt-1 text-detail text-muted" data-testid="return-bill-facts">
                  {t('simple.returns.billTotal', { amount: money(bill.total) })}
                  {' · '}
                  {bill.pending <= 0 ? t('simple.returns.paidUp') : sale ? t('simple.returns.stillDue', { amount: money(bill.pending) }) : t('simple.returns.stillToPay', { amount: money(bill.pending) })}
                </p>
                {bill.narration && (
                  <p className="mt-1 text-detail text-ink" data-testid="return-bill-note">
                    {t('simple.returns.billNote', { note: bill.narration })}
                  </p>
                )}
                {bill.earlier.length > 0 && (
                  <p className="mt-1 text-detail text-muted" data-testid="return-bill-earlier">
                    {t('simple.returns.earlier', { n: bill.earlier.length, amount: money(bill.earlier.reduce((s, r) => s + r.total, 0)) })}
                  </p>
                )}
              </div>
              {initialBill == null && (
                <button type="button" className="text-detail text-blue hover:underline" data-testid="btn-return-change-bill" onClick={startNew}>
                  {t('simple.returns.changeBill')}
                </button>
              )}
            </div>
          </section>

          {nothingLeft ? (
            <section role="status" className="rounded-lg border border-line bg-panel2 px-4 py-3" data-testid="return-nothing-left">
              <p className="text-body text-ink">{t('simple.returns.nothingLeft')}</p>
            </section>
          ) : (
            <>
              {/* What came back */}
              <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.returns.whichItems')}>
                <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
                  <h2 className="self-end text-subtitle font-semibold text-ink">{bill.mode === 'items' ? t('simple.returns.whichItems') : t('simple.returns.howMuch')}</h2>
                  <Field label={t('simple.returns.date')} name="date" error={errors.get(F.date)}>
                    <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-return-date" />
                  </Field>
                </div>
                {bill.mode === 'items' ? (
                  asks.blocked ? (
                    <div role="status" className="rounded-md border border-amber/60 bg-amberbar/10 px-3 py-2" data-testid="return-rates-changed">
                      <p className="text-body text-ink">{t('simple.returns.err.ratesChanged')}</p>
                    </div>
                  ) : (
                    <ReturnLines bill={bill} form={form} amounts={totals?.lineAmounts ?? {}} error={errors.get(F.items)} onChange={(qty) => update({ qty })} />
                  )
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="max-w-xs">
                      <Field
                        label={totals?.charges ? t('simple.returns.amountExcl') : t('simple.returns.amount')}
                        name="amount"
                        error={errors.get(F.amount)}
                        hint={bill.amountLeft != null ? t('simple.returns.upTo', { amount: money(bill.amountLeft) }) : undefined}
                      >
                        <AmountInput paise={form.amount} onPaise={(p) => update({ amount: p })} testId="input-return-amount" autoFocus />
                      </Field>
                    </div>
                    {asks.rate && (
                      <div data-testid="return-gst">
                        <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.sell.gstRate')}</span>
                        <p className="mb-2 text-small text-muted">{t('simple.returns.gstRateWhat')}</p>
                        <div role="radiogroup" aria-label={t('simple.sell.gstRate')} className="flex flex-wrap gap-2">
                          {rateChoices.map((rate) => (
                            <button
                              key={rate}
                              type="button"
                              role="radio"
                              aria-checked={form.gstRate === rate}
                              data-testid={`return-gst-rate-${rate}`}
                              onClick={() => update({ gstRate: rate })}
                              className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${form.gstRate === rate ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'}`}
                            >
                              {rate === 0 ? t('simple.sell.gstNil') : t('simple.sell.gstChip', { rate })}
                            </button>
                          ))}
                          {!(bill.rates && bill.rates.length > 1) && !rateOpen && slabs.some((s) => !s.common) && (
                            <button type="button" data-testid="return-gst-rate-other" onClick={() => setRateOpen(true)} className="rounded-md border border-dashed border-line px-3 py-1.5 text-detail text-muted hover:border-amber/60">
                              {t('simple.sell.otherRates')}
                            </button>
                          )}
                        </div>
                        <FieldError name="gstRate" error={errors.get(F.gstRate)} />
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-3">
                  <Field label={t('simple.returns.reason')}>
                    <TextInput value={form.reason} placeholder={t('simple.returns.reasonPlaceholder')} onChange={(e) => update({ reason: e.target.value })} data-testid="input-return-reason" />
                  </Field>
                </div>
              </section>

              {/* Where the money goes */}
              {totals && totals.total > 0 && (
                <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="return-money">
                  {split.offBill > 0 && (
                    <p className="mb-3 text-body text-ink" data-testid="return-off-bill">
                      {split.credit > 0
                        ? sale
                          ? t('simple.returns.offBillPart', { amount: money(split.offBill), bill: billNo(bill), rest: money(split.credit) })
                          : t('simple.returns.offBillPartBuy', { amount: money(split.offBill), bill: billNo(bill), rest: money(split.credit) })
                        : sale
                          ? t('simple.returns.offBillAll', { bill: billNo(bill) })
                          : t('simple.returns.offBillAllBuy', { bill: billNo(bill) })}
                    </p>
                  )}
                  {split.credit > 0 && (
                    <RefundHow side={side} form={form} setup={setup ?? null} walkIn={walkIn} error={errors.get(F.refund)} onChange={update} onAddBank={() => setAddingBank(true)} />
                  )}
                </section>
              )}

              {/* Totals + the plain preview */}
              <section className="rounded-lg border border-line bg-panel2 p-panel" aria-live="polite" data-testid="return-totals">
                {(!!totals?.tax || !!totals?.rounding) && (
                  <dl className="mb-1 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-detail text-muted">
                    {!!totals?.tax && (
                      <>
                        <dt>{t('simple.sell.beforeGst')}</dt>
                        <dd className="num text-right" data-testid="return-taxable" data-paise={totals.taxable}>
                          {money(totals.taxable)}
                        </dd>
                        <dt>{t('simple.sell.gst')}</dt>
                        <dd className="num text-right" data-testid="return-tax" data-paise={totals.tax}>
                          {money(totals.tax)}
                        </dd>
                      </>
                    )}
                    {!!totals?.rounding && (
                      <>
                        <dt>{t('simple.sell.roundOff')}</dt>
                        <dd className="num text-right" data-testid="return-rounding" data-paise={totals.rounding}>
                          {money(totals.rounding)}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
                <div className="flex items-baseline justify-between gap-6">
                  <span className="text-lead font-semibold text-ink">{t('simple.returns.total')}</span>
                  <span className="num text-heading font-semibold text-ink" data-testid="return-total" data-paise={totals?.total ?? 0}>
                    {money(totals?.total ?? 0)}
                  </span>
                </div>
                {previewProblem && (
                  <p role="status" className="mt-1 text-detail text-warning" data-testid="return-preview-problem">
                    {t('simple.returns.previewProblem', { reason: previewProblem })}
                  </p>
                )}
              </section>

              {general && (
                <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="return-error">
                  <p>{general.text}</p>
                  <details className="mt-1 text-muted">
                    <summary className="cursor-pointer">{t('common.details')}</summary>
                    <p className="mt-1 font-mono text-small">{general.details}</p>
                  </details>
                </div>
              )}

              <SaveBar
                total={money(totals?.total ?? 0)}
                totalTestId="return-total-bar"
                preview={preview ? returnPreviewLines(preview.facts, t, { walkIn }).join(' ') : ready && !previewProblem ? t('simple.sell.preview.checking') : ''}
                previewTestId="return-preview"
                shortcuts={t('simple.returns.shortcuts')}
              >
                <Button variant="primary" data-testid="btn-return-save" disabled={saving || !setup || asks.blocked} onClick={() => void save()}>
                  {t('simple.returns.save')}
                </Button>
              </SaveBar>
            </>
          )}
        </div>
      )}

      {addingBank && (
        <NewAccountDialog
          name=""
          context={{ field: 'line', voucherKind: sale ? 'payment' : 'receipt', drCr: sale ? 'cr' : 'dr' }} // i18n-technical: money out / in through a bank
          onClose={() => setAddingBank(false)}
          onCreated={(l: Ledger) => {
            setAddingBank(false)
            void queryClient.invalidateQueries({ queryKey: ['simpleSellSetup'] }) // i18n-technical
            update({ accountId: l.id })
          }}
        />
      )}
    </Page>
  )
}
