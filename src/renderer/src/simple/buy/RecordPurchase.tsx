import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import { CATEGORIES } from '@shared/simple/categories'
import { categoriesFor } from '@shared/simple/accountKinds'
import {
  asksAmountRate, BUY_MODES, buyFormErrors, buyGst, buyTotals, emptyBuyForm, productsNeedGst, purchaseIntentFrom, purchasePreviewLine, showsPriceBasis, switchBuyBasis,
  type BuyContext, type BuyField, type BuyForm, type BuyLine, type BuyMode
} from '@shared/simple/buy'
import type { MessageKey } from '@shared/i18n'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useFeatures } from '../../lib/useFeatures'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { useAiAffordances } from '../../lib/explain'
import { confirmDialog } from '../../lib/dialogs'
import { useNav, useSession, type AskOpen } from '../../state/stores'
import { buyFromAsk } from '@shared/simple/askPrefill'
import { Button, DateInput, Field, FieldError, isAnyModalOpen, Page, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead, useGroups, useLedgers, useStockItems } from '../../components/pickers'
import { CategoryPicker } from '../CategoryPicker'
import { NewAccountDialog } from '../NewAccountDialog'
import { NewProductDialog } from '../NewProductDialog'
import { SaveCard } from '../SaveCard'
import { BuyLines } from './BuyLines'
import { BuyAmount } from './BuyAmount'
import { PaidNow } from './PaidNow'
import { useAccountantView, useCarriedBack, useKeptForm } from '../../lib/handoff'
import { CarriedBackNote } from '../CarriedBackNote'
import { AccountantViewButton } from '../AccountantViewButton'
import { SaveBar } from '../SaveBar'
import { useCanSave, ViewerNote } from '../ViewerNote'
import { switchBasisRemembering, type BasisMemo } from '@shared/simple/sell'

const INCL_KEY = 'total-buy-incl' // i18n-technical: localStorage key (per company)
const PURCHASES_CATEGORY = 'purchases' as const // i18n-technical
const AMOUNT_MODE = 'amount' as const // i18n-technical
const DUPLICATE = 'simple_duplicate_bill' // i18n-technical: error code
// prettier-ignore
const F = { date: 'date', party: 'party', billNo: 'billNo', items: 'items', account: 'account', amount: 'amount', gstRate: 'gstRate', gstOnBill: 'gstOnBill', payment: 'payment' } as const satisfies Record<BuyField, BuyField> // i18n-technical: form field paths
const EXPENSE_KEYS = categoriesFor('expense') // i18n-technical
const MODE_TEXT: Record<BuyMode, MessageKey> = { items: 'simple.buy.mode.items', expense: 'simple.buy.mode.expense', amount: 'simple.buy.mode.amount' }
const CAPTURE_SCREEN = { name: 'capture' } as const // i18n-technical: registry screen
const billScreen = (billId: number): { name: 'simple-purchases'; billId: number } => ({ name: 'simple-purchases', billId }) // i18n-technical
const PAYMENT_LINE = { field: 'line', voucherKind: 'payment', drCr: 'dr' } as const // i18n-technical: where "Something else…" starts (an expense)

let lineSeq = 0
const newLine = (): BuyLine => ({ key: ++lineSeq, itemId: null, qtyText: '1', rate: null, discount: null })

/** The remembered "prices with GST" choice (null = never chosen — the form's default applies). */
function readIncl(slug: string | null): boolean | null {
  try {
    const v = localStorage.getItem(`${INCL_KEY}:${slug ?? '-'}`)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** Has the form anything the user typed (worth asking before throwing it away)? */
const isDirty = (f: BuyForm, party?: number): boolean =>
  (f.supplierId != null && f.supplierId !== party) || f.billNo.trim() !== '' || f.amount != null || f.categoryId != null || f.note.trim() !== '' || f.lines.some((l) => l.itemId != null)

/**
 * WP 9.3 — Record a purchase (plan §3): whose bill it is (a supplier, their bill number and the
 * bill's date), what was bought (products with stock on, an expense by category, or just an
 * amount), "Does the bill show GST?" (a regular registration on the bill's date only — a business
 * that can't claim GST has it folded into the cost), "Paid now?" and the live total. The answers
 * become a `purchase` intent (shared/simple/buy.ts) that simple:post saves through the editors'
 * own mapping; the total is the editor's calculation, the preview line comes from simple:preview,
 * the save card offers New / Undo. ⌘↵ saves, ⌘N starts a new bill, Esc asks before discarding.
 * "Accountant view" opens the full purchase editor (the saved bill once there is one).
 */
export function RecordPurchase({ party, ask }: { party?: number; ask?: AskOpen<'simple-buy'> } = {}): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const queryClient = useQueryClient()
  const { info, workingDate, slug } = useSession()
  const features = useFeatures()
  const stockOn = features.inventory
  const aiReady = useAiAffordances()
  const items = useStockItems()
  const ledgers = useLedgers()
  const groups = useGroups()
  const { data: setup } = useQuery({ queryKey: ['simpleBuySetup'], queryFn: api.buy.setup }) // i18n-technical
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list }) // i18n-technical
  const poster = useSimplePost({ aiDraftId: ask?.draftId ?? null })

  const facts = useMemo(() => (info ? gstRegistrationOf(info) : null), [info])
  const startMode: BuyMode = stockOn ? 'items' : 'amount' // i18n-technical
  const blank = useCallback((): BuyForm => {
    const remembered = readIncl(slug)
    const f = emptyBuyForm(workingDate, { mode: startMode, ratesIncludeGst: false })
    // Regular: bills print prices before GST; a business that can't claim types what it paid.
    const regular = info?.gstRegistrationType === 'regular' // i18n-technical
    return { ...f, ratesIncludeGst: remembered ?? !regular, lines: startMode === 'items' ? [newLine()] : [] }
  }, [workingDate, startMode, slug, info?.gstRegistrationType])
  // WP 9.8: `party` starts the purchase for that supplier (People → Record a purchase).
  // WP 10.1: an Ask Total entry request opens the purchase pre-filled (askPrefill.ts — the draft's own mapping).
  const carriedBack = useCarriedBack()
  const [form, setForm] = useKeptForm<BuyForm>(() => (ask ? buyFromAsk(blank(), ask.prefill, (l) => ({ ...newLine(), ...l })) : party != null ? { ...blank(), supplierId: party } : blank()))
  const [savedIds, setSavedIds] = useState<number[] | null>(null)
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  /** The last preview was refused (its reason is in previewProblem, or under its question). */
  const [previewFailed, setPreviewFailed] = useState(false)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [dupId, setDupId] = useState<number | null>(null)
  const [creating, setCreating] = useState<{ what: 'supplier' | 'product' | 'bank'; name: string; lineKey?: number } | null>(null)
  const [showDiscount, setShowDiscount] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const saving = poster.status === 'posting'

  // Stock switched off while the form is open: no products (the item picker never shows).
  useEffect(() => {
    if (!stockOn && form.mode === 'items') setForm((f) => ({ ...f, mode: 'amount', lines: [] })) // i18n-technical
  }, [stockOn, form.mode])

  const ctx: BuyContext | null = useMemo(
    () =>
      info && facts
        ? {
            invoice: {
              companyStateCode: info.stateCode,
              ...facts,
              items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
              ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
            },
            purchaseAccountId: setup?.purchaseAccountId ?? null
          }
        : null,
    [info, facts, items, ledgers, setup?.purchaseAccountId]
  )
  const totals = useMemo(() => (ctx ? buyTotals(form, ctx) : null), [form, ctx])
  const gst = ctx ? buyGst(form, ctx) : 'paid' // i18n-technical
  const asksGst = gst === 'claim' || gst === 'none'
  const clientErrors = useMemo(() => (ctx ? buyFormErrors(form, ctx) : {}), [form, ctx])
  const asksRate = ctx ? asksAmountRate(form, ctx) : false
  const amountAccount = form.mode === 'expense' ? form.categoryId : (setup?.purchaseAccountId ?? null)
  const shownRate = form.gstRate ?? ledgers.find((l) => l.id === amountAccount)?.gstRate ?? null

  const errors = useFormErrors<BuyField>(
    {
      date: form.date, party: form.supplierId, billNo: form.billNo, items: form.lines, account: form.categoryId, amount: form.amount, gstRate: form.gstRate,
      gstOnBill: `${form.gstOnBill}|${form.mode}|${ctx ? productsNeedGst(form, ctx) : false}`, payment: `${form.paid}|${form.partAmount}|${form.partHow}`
    },
    { simple: true, t }
  )

  const dirty = !savedIds && !leaving && isDirty(form, party)
  useUnsavedGuard(dirty)
  useEffect(() => {
    if (leaving) nav.back()
  }, [leaving, nav])

  const update = (patch: Partial<BuyForm>): void => {
    setGeneral(null)
    setForm((f) => ({ ...f, ...patch }))
  }

  // ---------- the plain preview line (simple:preview, rehearsed — nothing saved) ----------
  const ready = !!ctx && !!setup && Object.keys(clientErrors).length === 0
  const intent = useMemo(() => (ready ? purchaseIntentFrom(form, ctx!, setup!.defaults) : null), [ready, form, ctx, setup])
  const intentKey = intent ? JSON.stringify(intent) : ''
  const previewRef = useRef(poster.preview)
  previewRef.current = poster.preview
  useEffect(() => {
    setPreview(null)
    setPreviewProblem(null)
    setPreviewFailed(false)
    if (!intent || savedIds) return
    const id = window.setTimeout(() => {
      previewRef.current(intent).then(
        (p) => setPreview(p),
        (err: unknown) => {
          // Never "Checking…" for ever: say what stops the bill (Save puts it under its question).
          setPreview(null)
          setPreviewFailed(true)
          const caught = err as CaughtError & { code?: string }
          // The same supplier's bill again: said under the bill number at once, with its link.
          if (caught.code === DUPLICATE) return placeRef.current(caught)
          const m = mapError(caught, { simple: true, t })
          setPreviewProblem([m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('simple.buy.err.problem'))
        }
      )
    }, 350)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, savedIds])

  // ---------- save ----------
  const place = (err: unknown): void => {
    const caught = err as CaughtError & { code?: string; params?: Record<string, unknown> }
    // The same supplier's bill number again in the year: said under the bill number in the form's
    // own words (the entry's number means nothing here), with a link to the bill already recorded.
    if (caught.code === DUPLICATE) {
      errors.set('billNo', t('simple.buy.err.duplicate')) // i18n-technical
      if (typeof caught.params?.voucherId === 'number') setDupId(caught.params.voucherId)
      return
    }
    const mapped = errors.apply(err)
    if (mapped.general || Object.keys(mapped.fields).length === 0) {
      setGeneral({ text: mapped.general || t('simple.buy.err.problem'), details: mapError(caught, { simple: true, t }).details })
    }
  }

  const placeRef = useRef(place)
  placeRef.current = place

  const save = async (): Promise<void> => {
    if (!ctx || !setup || saving) return
    setGeneral(null)
    setDupId(null)
    const keys = Object.entries(clientErrors) as [BuyField, string][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.buy.err.amount')) // i18n-technical: keys from buyFormErrors
      return
    }
    try {
      const r = await poster.post(purchaseIntentFrom(form, ctx, setup.defaults))
      setSavedIds(r.voucherIds)
      for (const k of ['simpleBuySetup', 'simplePurchases', 'ledgers', 'stockItems', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    }
  }

  const startNew = (): void => {
    poster.reset()
    setSavedIds(null)
    setPreview(null)
    setPreviewProblem(null)
    setGeneral(null)
    setDupId(null)
    errors.clear()
    setShowDiscount(false)
    setForm(blank())
  }

  const askDiscard = (): Promise<boolean> =>
    confirmDialog({ title: t('simple.buy.discardTitle'), message: t('simple.buy.discardBody'), confirmLabel: t('simple.buy.discard'), cancelLabel: t('simple.buy.keepEditing'), danger: true })

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

  // WP 9.10: the saved bill, or the full purchase editor with these answers filled in.
  const openFull = useAccountantView('simple-buy') // i18n-technical: screen name
  const accountantView = (always: boolean): void => void openFull({ intent: dirty ? intent : null, savedId: savedIds?.[0] ?? null, always, keep: { form } })

  const basisMemo = useRef<BasisMemo | null>(null)
  const setIncl = (on: boolean): void => {
    try {
      localStorage.setItem(`${INCL_KEY}:${slug ?? '-'}`, on ? '1' : '0')
    } catch {
      /* the choice still applies to this bill */
    }
    // Prices already typed are converted so each line's total stays the same (switchBuyBasis —
    // the editor's own helpers).
    if (!ctx) return update({ ratesIncludeGst: on })
    const scope = [form.date, form.supplierId, form.mode, form.gstRate, form.gstOnBill, form.categoryId].join('|') // i18n-technical
    const { form: next, memo } = switchBasisRemembering(form, on, scope, basisMemo.current, (f) => switchBuyBasis(f, ctx, on))
    basisMemo.current = memo
    update(next)
  }

  const setMode = (mode: BuyMode): void => {
    if (mode === form.mode) return
    update(mode === 'items' ? { mode, lines: [newLine()], amount: null } : { mode, lines: [] }) // i18n-technical
  }

  const supplierOptions = useMemo(
    () => (setup?.suppliers ?? []).map((s) => ({ id: s.id, label: s.name, ...(s.gstin ? { sub: s.gstin } : s.phone ? { sub: s.phone } : {}) })),
    [setup?.suppliers]
  )

  // A company made with the full form may have no purchase account yet: one click adds the plain
  // "Purchases" account (its category, as the setup presets do) — never a dead end.
  const noPurchaseAccount = !!setup && setup.purchaseAccountId == null && form.mode !== 'expense'
  const [addingAccount, setAddingAccount] = useState(false)
  const addPurchaseAccount = async (): Promise<void> => {
    const def = CATEGORIES.purchases
    const groupId = groups.find((g) => g.name === def.group)?.id
    if (groupId == null) return
    setAddingAccount(true)
    try {
      await api.ledgers.create({
        name: def.name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
        tdsSectionId: null, pan: null, creditDays: null, exportType: null, simpleCategory: PURCHASES_CATEGORY
      })
      for (const k of ['simpleBuySetup', 'ledgers']) await queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    } finally {
      setAddingAccount(false)
    }
  }

  const modes = BUY_MODES.filter((m) => m !== 'items' || stockOn)
  const choice = (selected: boolean): string =>
    `rounded-md border px-3 py-1.5 text-detail transition-colors ${selected ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'}`

  return (
    <Page data-testid="simple-buy">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.buy.record')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.buy.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {aiReady && (
            <Button variant="ghost" data-testid="btn-buy-snap" title={t('simple.buy.snapHint')} onClick={() => nav.go(CAPTURE_SCREEN)}>
              {t('simple.buy.snap')}
            </Button>
          )}
          <AccountantViewButton testId="btn-buy-accountant-view" title={t('simple.buy.accountantHint')} onOpen={accountantView} />
        </div>
      </div>
      {!canSave && <ViewerNote top />}
      <CarriedBackNote dropped={carriedBack} />

      {noPurchaseAccount && !savedIds && (
        <section role="status" className="mb-4 rounded-lg border border-amber/60 bg-amberbar/10 px-4 py-3" data-testid="buy-no-purchase-account">
          <p className="text-body text-ink">{t('simple.buy.noPurchaseAccount')}</p>
          {canSave && (
            <Button className="mt-2" variant="primary" disabled={addingAccount} data-testid="btn-buy-add-purchase-account" onClick={() => void addPurchaseAccount()}>
              {t('simple.buy.addPurchaseAccount')}
            </Button>
          )}
        </section>
      )}
      {savedIds ? (
        <SaveCard
          voucherIds={savedIds}
          onNew={startNew}
          onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} // i18n-technical
          onUndone={() => void queryClient.invalidateQueries({ queryKey: ['simplePurchases'] })} // i18n-technical
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Whose bill is it? */}
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.buy.who')}>
            <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.buy.who')}</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr_1fr]">
              <Field label={t('simple.buy.supplier')} name="party" error={errors.get(F.party)}>
                <TypeAhead
                  options={supplierOptions}
                  value={form.supplierId}
                  onPick={(id) => update({ supplierId: id })}
                  placeholder={t('simple.buy.supplierPlaceholder')}
                  onCreate={canSave ? (name) => setCreating({ what: 'supplier', name }) : undefined} // i18n-technical
                  testId="picker-buy-supplier"
                  autoFocus
                />
              </Field>
              <div>
                <Field label={t('simple.buy.theirBillNo')} name="billNo" error={errors.get(F.billNo)} hint={t('simple.buy.billNoHint')}>
                  <TextInput value={form.billNo} onChange={(e) => update({ billNo: e.target.value })} placeholder={t('simple.buy.billNoPlaceholder')} data-testid="input-buy-bill-no" />
                </Field>
                {errors.get(F.billNo) && dupId != null && (
                  <button type="button" className="mt-1 text-detail text-blue hover:underline" data-testid="btn-buy-open-duplicate" onClick={() => nav.go(billScreen(dupId))}>
                    {t('simple.buy.openDuplicate')}
                  </button>
                )}
              </div>
              <Field label={t('simple.buy.theirBillDate')} name="date" error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-buy-date" />
              </Field>
            </div>
          </section>

          {/* What did you buy? */}
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.buy.whatBought')}>
            <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.buy.whatBought')}</h2>
            <div role="radiogroup" aria-label={t('simple.buy.whatBought')} className="mb-4 flex flex-wrap gap-2">
              {modes.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={form.mode === m} data-testid={`buy-mode-${m}`} onClick={() => setMode(m)} className={choice(form.mode === m)}>
                  {lbl(MODE_TEXT[m])}
                </button>
              ))}
            </div>

            {asksGst && (
              <div className="mb-4" data-testid="buy-gst-question">
                <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.buy.billShowsGst')}</span>
                <p className="mb-2 text-small text-muted">{t('simple.buy.gstQuestionWhat')}</p>
                <div role="radiogroup" aria-label={t('simple.buy.billShowsGst')} className="flex flex-wrap gap-2">
                  {[true, false].map((yes) => (
                    <button
                      key={String(yes)}
                      type="button"
                      role="radio"
                      aria-checked={form.gstOnBill === yes}
                      data-testid={`buy-gst-${yes ? 'yes' : 'no'}`}
                      onClick={() => update({ gstOnBill: yes })}
                      className={choice(form.gstOnBill === yes)}
                    >
                      {yes ? t('simple.buy.gstYes') : t('simple.buy.gstNo')}
                    </button>
                  ))}
                </div>
                <FieldError name="gstOnBill" error={errors.get(F.gstOnBill)} />
                {form.mode === 'items' && !form.gstOnBill && ctx && productsNeedGst(form, ctx) && (
                  <button type="button" className="mt-1 text-detail text-blue hover:underline" data-testid="btn-buy-as-amount" onClick={() => setMode(AMOUNT_MODE)}>
                    {t('simple.buy.recordAsAmount')}
                  </button>
                )}
              </div>
            )}
            {!asksGst && <p className="mb-3 text-small text-muted" data-testid="buy-cant-claim">{t('simple.buy.cantClaim')}</p>}

            {showsPriceBasis(gst) && (
              <div role="radiogroup" aria-label={t('simple.buy.pricesLabel')} className="mb-3 inline-flex rounded-md border border-line bg-panel2 p-0.5">
                {[false, true].map((incl) => (
                  <button
                    key={String(incl)}
                    type="button"
                    role="radio"
                    aria-checked={form.ratesIncludeGst === incl}
                    data-testid={`buy-prices-${incl ? 'incl' : 'excl'}`}
                    onClick={() => setIncl(incl)}
                    className={`rounded px-3 py-1 text-detail ${form.ratesIncludeGst === incl ? 'bg-panel font-medium text-ink shadow-elev-1 ring-1 ring-line' : 'text-muted hover:text-ink'}`}
                  >
                    {incl ? t('simple.buy.pricesInclude') : t('simple.buy.pricesExclude')}
                  </button>
                ))}
              </div>
            )}

            {form.mode === 'items' && ctx ? (
              <>
                <BuyLines
                  form={form}
                  ctx={ctx}
                  gst={gst}
                  amounts={totals?.lineAmounts ?? []}
                  units={units ?? []}
                  showDiscount={showDiscount}
                  error={errors.get(F.items)}
                  onChange={(lines) => update({ lines })}
                  onAdd={() => update({ lines: [...form.lines, newLine()] })}
                  onCreate={canSave ? (name, lineKey) => setCreating({ what: 'product', name, lineKey }) : undefined} // i18n-technical
                />
                {!showDiscount && (
                  <button type="button" className="mt-3 text-detail text-blue hover:underline" data-testid="btn-buy-add-discount" onClick={() => setShowDiscount(true)}>
                    {t('simple.buy.addDiscount')}
                  </button>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-3">
                {form.mode === 'expense' && (
                  <Field label={t('simple.buy.category')} name="account" error={errors.get(F.account)}>
                    <CategoryPicker
                      value={form.categoryId}
                      onPick={(id) => update({ categoryId: id, gstRate: null })}
                      keys={EXPENSE_KEYS}
                      context={PAYMENT_LINE}
                      side="expense" // i18n-technical
                      testId="picker-buy-category"
                    />
                  </Field>
                )}
                <BuyAmount
                  form={form}
                  gst={gst}
                  asksRate={asksRate}
                  shownRate={shownRate}
                  amountError={errors.get(F.amount)} // i18n-technical
                  rateError={errors.get(F.gstRate)}
                  onChange={update}
                />
              </div>
            )}
            <div className="mt-3">
              <Field label={t('common.note')}>
                <TextInput value={form.note} placeholder={t('simple.buy.notePlaceholder')} onChange={(e) => update({ note: e.target.value })} data-testid="input-buy-note" />
              </Field>
            </div>
          </section>

          {/* Paid now? */}
          <PaidNow
            form={form}
            setup={setup ?? null}
            error={errors.get(F.payment)}
            onChange={update}
            onAddBank={() => setCreating({ what: 'bank', name: '' })} // i18n-technical
          />

          {/* Totals + the plain preview line */}
          <section className="rounded-lg border border-line bg-panel2 p-panel" aria-live="polite" data-testid="buy-totals">
            {(gst === 'claim' || (totals?.folded ?? 0) > 0 || !!totals?.rounding) && (
              <dl className="mb-1 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-detail text-muted">
                {gst === 'claim' ? (
                  <>
                    <dt>{t('simple.buy.beforeGst')}</dt>
                    <dd className="num text-right" data-testid="buy-taxable" data-paise={totals?.taxable ?? 0}>
                      {formatPaise(totals?.taxable ?? 0, { symbol: true })}
                    </dd>
                    <dt>{t('simple.buy.gstClaim')}</dt>
                    <dd className="num text-right" data-testid="buy-tax" data-paise={totals?.tax ?? 0}>
                      {formatPaise(totals?.tax ?? 0, { symbol: true })}
                    </dd>
                  </>
                ) : (totals?.folded ?? 0) > 0 ? (
                  <>
                    <dt>{t('simple.buy.gstInCost')}</dt>
                    <dd className="num text-right" data-testid="buy-folded" data-paise={totals?.folded ?? 0}>
                      {formatPaise(totals?.folded ?? 0, { symbol: true })}
                    </dd>
                  </>
                ) : null}
                {!!totals?.rounding && (
                  <>
                    <dt>{t('simple.buy.roundOff')}</dt>
                    <dd className="num text-right" data-testid="buy-rounding" data-paise={totals.rounding}>
                      {formatPaise(totals.rounding, { symbol: true })}
                    </dd>
                  </>
                )}
              </dl>
            )}
            <div className="flex items-baseline justify-between gap-6">
              <span className="text-lead font-semibold text-ink">{t('simple.buy.total')}</span>
              <span className="num text-heading font-semibold text-ink" data-testid="buy-total" data-paise={totals?.total ?? 0}>
                {formatPaise(totals?.total ?? 0, { symbol: true })}
              </span>
            </div>
            {previewProblem && (
              <p role="status" className="mt-1 text-detail text-warning" data-testid="buy-preview-problem">
                {t('simple.buy.previewProblem', { reason: previewProblem })}
              </p>
            )}
          </section>

          {general && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="buy-error">
              <p>{general.text}</p>
              <details className="mt-1 text-muted">
                <summary className="cursor-pointer">{t('common.details')}</summary>
                <p className="mt-1 font-mono text-small">{general.details}</p>
              </details>
            </div>
          )}

          <SaveBar
            total={formatPaise(totals?.total ?? 0, { symbol: true })}
            totalTestId="buy-total-bar"
            preview={preview ? purchasePreviewLine(preview.facts, t) : ready && !previewFailed ? t('simple.buy.preview.checking') : ''}
            previewTestId="buy-preview"
            shortcuts={t('simple.buy.shortcuts')}
          >
            <Button data-testid="btn-buy-start-again" disabled={saving} onClick={() => (dirty ? void askDiscard().then((ok) => ok && startNew()) : startNew())}>
              {t('simple.buy.startAgain')}
            </Button>
            <Button variant="primary" data-testid="btn-buy-save" disabled={saving || !setup || noPurchaseAccount} onClick={() => void save()}>
              {t('simple.buy.save')}
            </Button>
          </SaveBar>
        </div>
      )}

      {creating?.what === 'supplier' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'party', side: 'purchase' }} // i18n-technical
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleBuySetup'] }) // i18n-technical
            update({ supplierId: l.id })
          }}
        />
      )}
      {creating?.what === 'bank' && (
        <NewAccountDialog
          name={creating.name}
          context={{ field: 'line', voucherKind: 'payment', drCr: 'cr' }} // i18n-technical: money out → where it came from = a bank
          onClose={() => setCreating(null)}
          onCreated={(l: Ledger) => {
            setCreating(null)
            void queryClient.invalidateQueries({ queryKey: ['simpleBuySetup'] }) // i18n-technical
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
            update({ lines: form.lines.map((l) => (l.key === key ? { ...l, itemId: id } : l)) })
          }}
        />
      )}
    </Page>
  )
}
