import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import {
  billTitleKey, emptySellForm, qtyMilliOf, saleIntentFrom, salePreviewLine, sellFormErrors, sellTotals, shownRate, switchBasisRemembering, switchSellBasis,
  type BasisMemo, type SellContext, type SellField, type SellForm
} from '@shared/simple/sell'
import { api } from '../../lib/client'
import { pricingApi } from '../../lib/pricingClient'
import { useT } from '../../lib/i18n'
import { useFeatures } from '../../lib/useFeatures'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { confirmDialog } from '../../lib/dialogs'
import { useNav, useSession, type AskOpen } from '../../state/stores'
import { sellFromAsk } from '@shared/simple/askPrefill'
import { Button, DateInput, Field, isAnyModalOpen, Page, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead, useGroups, useLedgers, useStockItems } from '../../components/pickers'
import { CATEGORIES } from '@shared/simple/categories'
import { NewAccountDialog } from '../NewAccountDialog'
import { NewProductDialog } from '../NewProductDialog'
import { SaveCard } from '../SaveCard'
import { BillLines, type FormLine } from './BillLines'
import { AmountLine } from './AmountLine'
import { PaidHow } from './PaidHow'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'
import { SaveBar } from '../SaveBar'
import { useCanSave, ViewerNote } from '../ViewerNote'

const INCL_KEY = 'total-sell-incl' // i18n-technical: localStorage key (per company)
const SALES_KIND = 'sales' as const // i18n-technical
const CASH = 'cash' as const // i18n-technical
const CREDIT = 'credit' as const // i18n-technical
const F = { date: 'date', party: 'party', items: 'items', amount: 'amount', gstRate: 'gstRate', payment: 'payment' } as const satisfies Record<SellField, SellField> // i18n-technical: form field paths

let lineSeq = 0
const newLine = (): FormLine => ({ key: ++lineSeq, itemId: null, qtyText: '1', rate: null, discount: null, auto: true })

function readIncl(slug: string | null): boolean {
  try {
    return localStorage.getItem(`${INCL_KEY}:${slug ?? '-'}`) === '1'
  } catch {
    return false
  }
}

/** Has the form anything the user typed (worth asking before throwing it away)? */
const isDirty = (f: SellForm & { lines: FormLine[] }, party?: number): boolean =>
  (f.customerId != null && f.customerId !== party) || f.amount != null || f.note.trim() !== '' || f.lines.some((l) => l.itemId != null)

/**
 * WP 9.2 — Make a bill (plan §3): who it is for (a customer, or the walk-in "Cash customer"), what
 * was sold (products — or "just an amount" when stock is off), "Paid how?" and the live total. The
 * answers become a `sale` intent (shared/simple/sell.ts) that simple:post saves through the
 * editors' own mapping; the total is the editor's calculation, the preview line comes from
 * simple:preview, the save card offers Print / PDF / Share / New / Undo. ⌘↵ saves, ⌘N starts a
 * new bill, Esc asks before discarding. "Accountant view" opens the full sales editor (the saved
 * bill once there is one). WP 9.8: `party` starts the bill for that customer (People → Make a
 * bill), on credit until the user says how it was paid.
 */
export function MakeBill({ party, ask }: { party?: number; ask?: AskOpen<'simple-sell'> } = {}): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { info, workingDate, slug } = useSession()
  const features = useFeatures()
  const stockOn = features.inventory
  const items = useStockItems()
  const ledgers = useLedgers()
  const groups = useGroups()
  const { data: setup } = useQuery({ queryKey: ['simpleSellSetup'], queryFn: api.simple.sellSetup }) // i18n-technical
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list }) // i18n-technical
  const poster = useSimplePost({ aiDraftId: ask?.draftId ?? null })

  const startMode: SellForm['mode'] = stockOn ? 'items' : 'amount' // i18n-technical
  const blank = useCallback(
    (): SellForm & { lines: FormLine[] } => ({ ...emptySellForm(workingDate, { mode: startMode, ratesIncludeGst: readIncl(slug) }), lines: startMode === 'items' ? [newLine()] : [] }),
    [workingDate, startMode, slug]
  )
  // WP 10.1: an Ask Total entry request opens the bill pre-filled (askPrefill.ts — the draft's own mapping).
  const [form, setForm] = useState<SellForm & { lines: FormLine[] }>(() =>
    ask ? sellFromAsk(blank(), ask.prefill, (l) => ({ ...l, key: ++lineSeq, auto: l.auto ?? true })) : party != null ? { ...blank(), customerId: party, paid: CREDIT } : blank()
  )
  const [savedIds, setSavedIds] = useState<number[] | null>(null)
  const [savedWalkIn, setSavedWalkIn] = useState(false)
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [creating, setCreating] = useState<{ what: 'customer' | 'product' | 'bank'; name: string; lineKey?: number } | null>(null)
  // Plan §3: Paid how defaults to Cash for the walk-in and On credit for a named customer — until
  // the user picks a way themselves.
  const [paidChosen, setPaidChosen] = useState(!!ask?.prefill.how)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [showDiscount, setShowDiscount] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const saving = poster.status === 'posting'

  // Stock switched off while the form is open: amount only (the item picker never shows).
  useEffect(() => {
    if (!stockOn && form.mode === 'items') setForm((f) => ({ ...f, mode: 'amount', lines: [] })) // i18n-technical
  }, [stockOn, form.mode])

  const facts = useMemo(() => (info ? gstRegistrationOf(info) : null), [info])
  const ctx: SellContext | null = useMemo(
    () =>
      info && facts
        ? {
            invoice: {
              companyStateCode: info.stateCode,
              ...facts,
              items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
              ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
            },
            salesAccountId: setup?.salesAccountId ?? null
          }
        : null,
    [info, facts, items, ledgers, setup?.salesAccountId]
  )
  const totals = useMemo(() => (ctx ? sellTotals(form, ctx) : null), [form, ctx])
  const charges = totals?.charges ?? false
  // GST questions follow the registration on the BILL's date (WP 8.0), not today's.
  const regular = charges
  const customer = setup?.customers.find((c) => c.id === form.customerId) ?? null
  const clientErrors = useMemo(
    () => (ctx ? sellFormErrors(form, ctx, { onHold: !!customer?.creditHold, regular }) : {}),
    [form, ctx, customer?.creditHold, regular]
  )

  const errors = useFormErrors<SellField>(
    { date: form.date, party: form.customerId, items: form.lines, amount: form.amount, gstRate: form.gstRate, payment: `${form.paid}|${form.partAmount}|${form.partHow}` },
    { simple: true, t }
  )

  const dirty = !savedIds && !leaving && isDirty(form, party)
  useUnsavedGuard(dirty)
  useEffect(() => {
    if (leaving) nav.back()
  }, [leaving, nav])

  const update = (patch: Partial<SellForm & { lines: FormLine[] }>, opts?: { paidChosen?: boolean }): void => {
    setGeneral(null)
    if (opts?.paidChosen) setPaidChosen(true)
    setForm((f) => ({ ...f, ...patch }))
  }
  /** A customer picked (null = the walk-in): the walk-in pays now; a named customer starts on
   *  credit unless the user already said how it was paid. */
  const pickCustomer = (id: number | null): void => {
    if (id == null) update({ customerId: null, ...(form.paid === 'credit' || form.paid === 'part' || !paidChosen ? { paid: CASH } : {}) })
    else update({ customerId: id, ...(!paidChosen ? { paid: CREDIT } : {}) })
  }

  // ---------- prices from the price list (resolvePrice) for lines the user hasn't typed over ----------
  const supplyState = customer?.stateCode ?? info?.stateCode ?? ''
  const priceSig = form.lines.filter((l) => l.auto && l.itemId != null).map((l) => `${l.key}:${l.itemId}:${l.qtyText}`).join(',')
  useEffect(() => {
    if (!ctx || !info) return
    const want = form.lines.filter((l) => l.auto && l.itemId != null)
    if (want.length === 0) return
    let stale = false
    const supply = supplyState === info.stateCode ? 'intra' : 'inter' // i18n-technical
    void pricingApi
      .resolve({
        date: form.date, partyLedgerId: form.customerId ?? setup?.walkInId ?? null, currency: '', supply,
        lines: want.map((l) => ({ key: l.key, itemId: l.itemId!, qtyMilli: qtyMilliOf(l.qtyText) ?? 1000 }))
      })
      .then((res) => {
        if (stale) return
        const byKey = new Map(res.map((r) => [r.key, r.result]))
        setForm((f) => ({
          ...f,
          lines: f.lines.map((l) => {
            const r = byKey.get(l.key)
            if (!r || !l.auto || l.itemId == null || r.ratePaise == null) return l
            const unit = f.ratesIncludeGst && r.inclusive ? r.inclusive.unitPaise : shownRate(r.ratePaise, l.itemId, f, ctx)
            return { ...l, rate: unit }
          })
        }))
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceSig, form.customerId, form.date, form.ratesIncludeGst, supplyState])

  // ---------- the plain preview line (simple:preview, rehearsed — nothing saved) ----------
  const intent = useMemo(() => (ctx && setup ? saleIntentFrom(form, ctx, setup.defaults) : null), [form, ctx, setup])
  const intentKey = intent ? JSON.stringify(intent) : ''
  const ready = !!intent && Object.keys(clientErrors).length === 0
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
          // Never "Checking…" for ever: say what stops the bill (Save puts it under its question).
          setPreview(null)
          const m = mapError(err as CaughtError, { simple: true, t })
          setPreviewProblem([m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('simple.sell.err.problem'))
        }
      )
    }, 350)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, ready, savedIds])

  // ---------- save ----------
  const place = (err: unknown): void => {
    const caught = err as CaughtError
    // A customer on credit hold: no override here — the owner decides.
    if ((caught as { code?: string }).code === 'credit_hold') { // i18n-technical
      errors.set('party', t('simple.sell.err.onHold')) // i18n-technical
      return
    }
    const mapped = errors.apply(err)
    if (mapped.general || Object.keys(mapped.fields).length === 0) {
      setGeneral({ text: mapped.general || t('simple.sell.err.problem'), details: mapError(caught, { simple: true, t }).details })
    }
  }

  const save = async (): Promise<void> => {
    if (!ctx || !setup || saving) return
    setGeneral(null)
    const keys = Object.entries(clientErrors) as [SellField, string][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.sell.err.amount')) // i18n-technical: keys from sellFormErrors
      return
    }
    try {
      const r = await poster.post(saleIntentFrom(form, ctx, setup.defaults))
      setSavedIds(r.voucherIds)
      setSavedWalkIn(r.facts.walkIn)
      for (const k of ['simpleSellSetup', 'simpleSales', 'ledgers', 'stockItems', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    }
  }

  const startNew = (): void => {
    poster.reset()
    setSavedIds(null)
    setPaidChosen(false)
    setPreview(null)
    setPreviewProblem(null)
    setGeneral(null)
    errors.clear()
    setShowDiscount(false)
    setForm(blank())
  }

  const askDiscard = (): Promise<boolean> =>
    confirmDialog({ title: t('simple.sell.discardTitle'), message: t('simple.sell.discardBody'), confirmLabel: t('simple.sell.discard'), cancelLabel: t('simple.sell.keepEditing'), danger: true })

  // ⌘↵ save · ⌘N new · Esc asks before discarding (capture phase, ahead of the app's Esc = back).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen() || creating) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!savedIds && canSave) void save() // WP 10.8 review: a viewer's ⌘↵ saves nothing (the note says why)
      return
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      e.stopPropagation()
      if (savedIds || !dirty) startNew()
      else void askDiscard().then((ok) => ok && startNew())
      return
    }
    if (e.key === 'Escape' && dirty) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      e.stopPropagation()
      void askDiscard().then((ok) => ok && setLeaving(true))
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  // WP 9.10: the saved bill, or the full sales editor with these answers filled in.
  const openFull = useAccountantView('simple-sell') // i18n-technical: screen name
  const accountantView = (always: boolean): void => void openFull({ intent: dirty ? intent : null, savedId: savedIds?.[0] ?? null, always })

  const basisMemo = useRef<BasisMemo | null>(null)
  const setIncl = (on: boolean): void => {
    try {
      localStorage.setItem(`${INCL_KEY}:${slug ?? '-'}`, on ? '1' : '0')
    } catch {
      /* the choice still applies to this bill */
    }
    // Prices already typed are converted so each line's total stays the same (switchSellBasis —
    // the editor's own helpers); price-list ones are fetched again in the new basis.
    if (!ctx) return update({ ratesIncludeGst: on, lines: form.lines.map((l) => (l.auto ? { ...l, rate: null } : l)) })
    const scope = [form.date, form.customerId, form.mode, form.gstRate].join('|') // i18n-technical
    const { form: next, memo } = switchBasisRemembering(form, on, scope, basisMemo.current, (f) => switchSellBasis(f, ctx, on))
    basisMemo.current = memo
    update({ ratesIncludeGst: on, amount: next.amount, lines: next.lines.map((l) => (l.auto ? { ...l, rate: null } : l)) })
  }

  const customerOptions = useMemo(() => (setup?.customers ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.phone ? { sub: c.phone } : {}) })), [setup?.customers])
  const title = t(billTitleKey(info ?? { gstRegistrationType: 'unregistered' }, form.date)) // i18n-technical: the WP 8.0 print title key

  const shortStock = preview?.warnings.negativeStock ?? []

  // A company made with the full form may have no sales account yet: one click adds the plain
  // "Sales" account (its category, as the setup presets do) — never a dead end.
  const noSalesAccount = !!setup && setup.salesAccountId == null
  const [addingSales, setAddingSales] = useState(false)
  const addSalesAccount = async (): Promise<void> => {
    const def = CATEGORIES.sales
    const groupId = groups.find((g) => g.name === def.group)?.id
    if (groupId == null) return
    setAddingSales(true)
    try {
      await api.ledgers.create({
        name: def.name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
        tdsSectionId: null, pan: null, creditDays: null, exportType: null, simpleCategory: SALES_KIND
      })
      for (const k of ['simpleSellSetup', 'ledgers']) await queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    } finally {
      setAddingSales(false)
    }
  }

  return (
    <Page data-testid="simple-sell">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.sell.makeBill')}</h1>
          <p className="mt-1 text-detail text-muted" data-testid="sell-print-title" data-title={billTitleKey(info ?? { gstRegistrationType: 'unregistered' }, form.date)}>
            {t('simple.sell.printsAs', { title })}
          </p>
        </div>
        <AccountantViewButton testId="btn-sell-accountant-view" title={t('simple.sell.accountantHint')} onOpen={accountantView} />
      </div>
      {!canSave && <ViewerNote top />}

      {noSalesAccount && !savedIds && (
        <section role="status" className="mb-4 rounded-lg border border-amber/60 bg-amberbar/10 px-4 py-3" data-testid="sell-no-sales-account">
          <p className="text-body text-ink">{t('simple.sell.noSalesAccount')}</p>
          {canSave && (
            <Button className="mt-2" variant="primary" disabled={addingSales} data-testid="btn-sell-add-sales-account" onClick={() => void addSalesAccount()}>
              {t('simple.sell.addSalesAccount')}
            </Button>
          )}
        </section>
      )}
      {savedIds ? (
        <SaveCard
          voucherIds={savedIds}
          skipParties={savedWalkIn}
          onNew={startNew}
          onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} // i18n-technical
          onUndone={() => void queryClient.invalidateQueries({ queryKey: ['simpleSales'] })} // i18n-technical
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Who is it for? */}
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.sell.who')}>
            <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.sell.who')}</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
              <Field label={t('simple.sell.customer')} name="party" error={errors.get(F.party)}>
                <TypeAhead
                  options={customerOptions}
                  value={form.customerId}
                  onPick={pickCustomer}
                  placeholder={t('simple.sell.customerPlaceholder')}
                  onCreate={canSave ? (name) => setCreating({ what: 'customer', name }) : undefined} // i18n-technical
                  testId="picker-sell-customer"
                  autoFocus
                />
              </Field>
              <Field label={t('simple.sell.date')} name="date" error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-sell-date" />
              </Field>
            </div>
            {form.customerId == null ? (
              <p className="mt-2 text-detail text-ink" data-testid="sell-cash-customer">
                {t('simple.sell.cashCustomer')}
              </p>
            ) : (
              <button type="button" className="mt-2 text-detail text-blue hover:underline" data-testid="btn-sell-cash-customer" onClick={() => pickCustomer(null)}>
                {t('simple.sell.pickCashCustomer')}
              </button>
            )}
          </section>

          {/* What was sold? */}
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.sell.what')}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-subtitle font-semibold text-ink">{t('simple.sell.what')}</h2>
              {charges && (
                <div role="radiogroup" aria-label={t('simple.sell.pricesLabel')} className="inline-flex rounded-md border border-line bg-panel2 p-0.5">
                  {[false, true].map((incl) => (
                    <button
                      key={String(incl)}
                      type="button"
                      role="radio"
                      aria-checked={form.ratesIncludeGst === incl}
                      data-testid={`sell-prices-${incl ? 'incl' : 'excl'}`}
                      onClick={() => setIncl(incl)}
                      className={`rounded px-3 py-1 text-detail ${form.ratesIncludeGst === incl ? 'bg-panel font-medium text-ink shadow-elev-1 ring-1 ring-line' : 'text-muted hover:text-ink'}`}
                    >
                      {incl ? t('simple.sell.pricesInclude') : t('simple.sell.pricesExclude')}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {form.mode === 'items' && ctx ? (
              <BillLines
                lines={form.lines}
                form={form}
                ctx={ctx}
                amounts={totals?.lineAmounts ?? []}
                units={units ?? []}
                showDiscount={showDiscount}
                charges={charges}
                error={errors.get(F.items)}
                onChange={(lines) => update({ lines })}
                onAdd={() => update({ lines: [...form.lines, newLine()] })}
                onCreate={canSave ? (name, lineKey) => setCreating({ what: 'product', name, lineKey }) : undefined} // i18n-technical
              />
            ) : (
              <AmountLine form={form} regular={regular} charges={charges} amountError={errors.get(F.amount)} rateError={errors.get(F.gstRate)} onChange={update} />
            )}
            <div className="mt-3 flex flex-wrap gap-4">
              {form.mode === 'items' && !showDiscount && (
                <button type="button" className="text-detail text-blue hover:underline" data-testid="btn-sell-add-discount" onClick={() => setShowDiscount(true)}>
                  {t('simple.sell.addDiscount')}
                </button>
              )}
              {stockOn && (
                <button
                  type="button"
                  className="text-detail text-blue hover:underline"
                  data-testid="btn-sell-toggle-mode"
                  onClick={() => update(form.mode === 'items' ? { mode: 'amount', lines: [] } : { mode: 'items', lines: [newLine()], amount: null })} // i18n-technical
                >
                  {form.mode === 'items' ? t('simple.sell.justAmount') : t('simple.sell.useProducts')}
                </button>
              )}
            </div>
            {form.mode === 'items' && (
              <div className="mt-3">
                <Field label={t('common.note')}>
                  <TextInput value={form.note} placeholder={t('common.notePlaceholder')} onChange={(e) => update({ note: e.target.value })} data-testid="input-sell-note" />
                </Field>
              </div>
            )}
          </section>

          {/* Paid how? */}
          <PaidHow
            form={form}
            setup={setup ?? null}
            error={errors.get(F.payment)}
            onChange={update}
            onAddBank={() => setCreating({ what: 'bank', name: '' })} // i18n-technical
          />

          {/* Totals + the plain preview line */}
          <section className="rounded-lg border border-line bg-panel2 p-panel" aria-live="polite" data-testid="sell-totals">
            {(charges || !!totals?.rounding) && (
              <dl className="mb-1 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-detail text-muted">
                {charges && (
                  <>
                    <dt>{t('simple.sell.beforeGst')}</dt>
                    <dd className="num text-right" data-testid="sell-taxable" data-paise={totals?.taxable ?? 0}>
                      {formatPaise(totals?.taxable ?? 0, { symbol: true })}
                    </dd>
                    <dt>{t('simple.sell.gst')}</dt>
                    <dd className="num text-right" data-testid="sell-tax" data-paise={totals?.tax ?? 0}>
                      {formatPaise(totals?.tax ?? 0, { symbol: true })}
                    </dd>
                  </>
                )}
                {!!totals?.rounding && (
                  <>
                    <dt>{t('simple.sell.roundOff')}</dt>
                    <dd className="num text-right" data-testid="sell-rounding" data-paise={totals.rounding}>
                      {formatPaise(totals.rounding, { symbol: true })}
                    </dd>
                  </>
                )}
              </dl>
            )}
            <div className="flex items-baseline justify-between gap-6">
              <span className="text-lead font-semibold text-ink">{t('simple.sell.total')}</span>
              <span className="num text-heading font-semibold text-ink" data-testid="sell-total" data-paise={totals?.total ?? 0}>
                {formatPaise(totals?.total ?? 0, { symbol: true })}
              </span>
            </div>
            {previewProblem && (
              <p role="status" className="mt-1 text-detail text-warning" data-testid="sell-preview-problem">
                {t('simple.sell.previewProblem', { reason: previewProblem })}
              </p>
            )}
            {shortStock.map((w) => (
              <p key={w.stockItemId} role="status" className="mt-1 text-detail text-warning" data-testid="sell-short-stock">
                {t('simple.sell.shortStock', { name: w.name, qty: formatQtyMilli(Math.abs(w.closingQtyMilli)), unit: w.unitSymbol })}
              </p>
            ))}
          </section>

          {general && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="sell-error">
              <p>{general.text}</p>
              <details className="mt-1 text-muted">
                <summary className="cursor-pointer">{t('common.details')}</summary>
                <p className="mt-1 font-mono text-small">{general.details}</p>
              </details>
            </div>
          )}

          <SaveBar
            total={formatPaise(totals?.total ?? 0, { symbol: true })}
            totalTestId="sell-total-bar"
            preview={preview ? salePreviewLine(preview.facts, t) : ready && !previewProblem ? t('simple.sell.preview.checking') : ''}
            previewTestId="sell-preview"
            shortcuts={t('simple.sell.shortcuts')}
          >
            <Button data-testid="btn-sell-start-again" disabled={saving} onClick={() => (dirty ? void askDiscard().then((ok) => ok && startNew()) : startNew())}>
              {t('simple.sell.startAgain')}
            </Button>
            <Button variant="primary" data-testid="btn-sell-save" disabled={saving || !setup || noSalesAccount} onClick={() => void save()}>
              {t('simple.sell.save')}
            </Button>
          </SaveBar>
        </div>
      )}

      {creating?.what === 'customer' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'party', side: 'sales' }} // i18n-technical
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleSellSetup'] }) // i18n-technical
            pickCustomer(l.id)
          }}
        />
      )}
      {creating?.what === 'bank' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'line', voucherKind: 'receipt', drCr: 'dr' }} // i18n-technical: money in → where it went = a bank
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleSellSetup'] }) // i18n-technical
            update({ accountId: l.id })
          }}
        />
      )}
      {creating?.what === 'product' && (
        <NewProductDialog
          name={creating.name}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            const key = creating.lineKey
            setCreating(null)
            update({ lines: form.lines.map((l) => (l.key === key ? { ...l, itemId: id, rate: null, auto: true } : l)) })
          }}
        />
      )}
    </Page>
  )
}

