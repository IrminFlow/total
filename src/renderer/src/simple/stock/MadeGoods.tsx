import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import { emptyMakeForm, makeFormErrors, makeIntentFrom, parseCountText, recipeLabour, recipeNeeds, type MakeField, type MakeForm } from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useFeatures } from '../../lib/useFeatures'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { confirmDialog } from '../../lib/dialogs'
import { useNav, useSession, type Screen } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, FieldError, isAnyModalOpen, Page, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead } from '../../components/pickers'
import { SaveCard } from '../SaveCard'
import { useCanSave, ViewerNote } from '../ViewerNote'
import { useAccountantView, useKeptForm } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'

const F = { date: 'date', item: 'item', qty: 'qty', price: 'price', labour: 'labour', labourRecorded: 'labourRecorded' } as const satisfies Record<MakeField, MakeField> // i18n-technical: form field paths
const FEATURES_SCREEN = { name: 'simple-features' } as const // i18n-technical
const MANUFACTURE_SCREEN = { name: 'manufacture' } as const // i18n-technical
const PRODUCTS_SCREEN = { name: 'simple-stock' } as const // i18n-technical: the recipe is added on a product's view

const isDirty = (f: MakeForm): boolean => f.itemId != null || f.qtyText.trim() !== '' || (f.labour ?? 0) > 0

/**
 * WP 9.7 — Made goods (plan §2.2, manufacturer preset): pick a product that has a recipe ("To make
 * 1 X you use …" — its BOM in force on the date), how many were made, what one sells for, and the
 * labour ("already recorded?"). Save records the WP 2.2 manufacture entry through the
 * `make_goods` intent (simple:post): the materials leave stock at the engine's cost and the made
 * goods enter at that cost + labour (the derived rule). Not enough material is said under "How
 * many". Shown only while manufacturing is on (Features).
 */
export function MadeGoods({ itemId }: { itemId?: number }): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const features = useFeatures()
  const poster = useSimplePost()
  const blank = (): MakeForm => ({ ...emptyMakeForm(workingDate), itemId: itemId ?? null })
  const [form, setForm] = useKeptForm<MakeForm>(blank)
  const [saved, setSaved] = useState<{ ids: number[]; sentences: string[] } | null>(null)
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const saving = poster.status === 'posting'
  const { data: setup } = useQuery({ queryKey: ['simpleMadeSetup', form.date], queryFn: () => api.simpleStock.madeSetup(form.date), enabled: features.manufacturing }) // i18n-technical
  const { data: stock } = useQuery({ queryKey: ['simpleStock', form.date], queryFn: () => api.simpleStock.list(form.date), enabled: features.manufacturing }) // i18n-technical
  const products = setup?.products ?? []
  const picked = products.find((p) => p.itemId === form.itemId) ?? null
  const onHand = useMemo(() => new Map((stock?.rows ?? []).map((r) => [r.itemId, r])), [stock])

  // The price prefill: the Manufacture screen's suggestion for the product picked (until typed).
  const priceTouched = useRef(false)
  useEffect(() => {
    if (!priceTouched.current && picked) setForm((f) => (f.price === picked.suggestedPrice ? f : { ...f, price: picked.suggestedPrice }))
  }, [picked])

  // The labour prefill: the recipe's labour per one × how many (until the labour is typed).
  const labourTouched = useRef(form.labour != null) // a kept form's typed labour stays
  const perUnitLabour = picked?.recipe.labourPerUnit ?? null
  useEffect(() => {
    if (labourTouched.current || perUnitLabour == null) return
    const q = parseCountText(form.qtyText)
    const next = q != null && q > 0 ? recipeLabour(perUnitLabour, q) : null
    setForm((f) => (f.labour === next ? f : { ...f, labour: next }))
  }, [perUnitLabour, form.qtyText])

  const errors = useFormErrors<MakeField>(
    { date: form.date, item: form.itemId, qty: form.qtyText, price: form.price, labour: form.labour, labourRecorded: form.labourRecorded },
    { simple: true, t }
  )
  const clientErrors = useMemo(() => makeFormErrors(form), [form])
  const dirty = !saved && !leaving && isDirty(form)
  useUnsavedGuard(dirty)
  useEffect(() => {
    if (leaving) nav.back()
  }, [leaving, nav])

  const update = (patch: Partial<MakeForm>): void => {
    setGeneral(null)
    setForm((f) => ({ ...f, ...patch }))
  }

  // ---------- the plain preview (simple:preview, rehearsed — nothing saved) ----------
  const ready = Object.keys(clientErrors).length === 0
  const intent = useMemo(() => (ready ? makeIntentFrom(form) : null), [ready, form])
  const intentKey = intent ? JSON.stringify(intent) : ''
  const previewRef = useRef(poster.preview)
  previewRef.current = poster.preview
  const placeRef = useRef<(err: unknown) => void>(() => undefined)
  useEffect(() => {
    setPreview(null)
    setPreviewProblem(null)
    if (!intent || saved) return
    const id = window.setTimeout(() => {
      previewRef.current(intent).then(
        (p) => setPreview(p),
        (err: unknown) => {
          // Not enough material (or another refusal on a question) goes under that question at once.
          const m = mapError(err as CaughtError, { simple: true, t })
          if (Object.keys(m.fields).length > 0) placeRef.current(err)
          else setPreviewProblem(m.general || t('simple.stock.err.problem'))
        }
      )
    }, 350)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, saved])

  const place = (err: unknown): void => {
    const mapped = errors.apply(err)
    if (mapped.general || Object.keys(mapped.fields).length === 0) {
      setGeneral({ text: mapped.general || t('simple.stock.err.problem'), details: mapError(err as CaughtError, { simple: true, t }).details })
    }
  }
  placeRef.current = place

  const save = async (): Promise<void> => {
    if (saving) return
    setGeneral(null)
    const keys = Object.entries(clientErrors) as [MakeField, string][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.made.err.item')) // i18n-technical: keys from makeFormErrors
      return
    }
    try {
      const r = await poster.post(makeIntentFrom(form))
      setSaved({ ids: r.voucherIds, sentences: r.sentences })
      for (const k of ['simpleStock', 'simpleStockProduct', 'simpleMadeSetup', 'stockItems', 'stockSummary', 'dashboard', 'ledgers']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    }
  }

  const startNew = (): void => {
    poster.reset()
    priceTouched.current = false
    labourTouched.current = false
    setSaved(null)
    setPreview(null)
    setPreviewProblem(null)
    setGeneral(null)
    errors.clear()
    setForm({ ...emptyMakeForm(workingDate), itemId: null })
  }

  const askDiscard = (): Promise<boolean> =>
    confirmDialog({ title: t('simple.made.discardTitle'), message: t('simple.made.discardBody'), confirmLabel: t('simple.buy.discard'), cancelLabel: t('simple.buy.keepEditing'), danger: true })

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen()) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!saved && canSave) void save() // WP 10.8 review: a viewer's ⌘↵ saves nothing (the note says why)
      return
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      e.stopPropagation()
      if (saved || !dirty) startNew()
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

  // WP 9.10: the saved batch, the full manufacture form with these answers filled in, or (not
  // complete yet) the form started for the product and quantity picked.
  const openFull = useAccountantView('simple-made-goods') // i18n-technical: screen name
  const accountantView = (always: boolean): void => {
    const q = parseCountText(form.qtyText)
    const fallback: Screen = form.itemId != null && q != null && q > 0 ? { name: 'manufacture', prefill: { itemId: form.itemId, qtyMilli: q } } : MANUFACTURE_SCREEN // i18n-technical
    void openFull({ intent: dirty ? intent : null, savedId: saved?.ids[0] ?? null, always, fallback, keep: { form } })
  }


  const options = useMemo(() => products.map((p) => ({ id: p.itemId, label: p.name })), [products])
  const qtyMilli = parseCountText(form.qtyText)
  const needs = picked && qtyMilli != null && qtyMilli > 0 ? recipeNeeds(picked.recipe, qtyMilli) : null
  const choice = (selected: boolean): string =>
    `rounded-md border px-3 py-1.5 text-detail transition-colors ${selected ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'}`

  if (!features.manufacturing) {
    return (
      <Page data-testid="simple-made-goods" data-off="true">
        <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.stock.madeGoods')}</h1>
        <p className="mt-2 text-body text-ink">{t('simple.made.off')}</p>
        <Button className="mt-3" variant="primary" data-testid="btn-made-features" onClick={() => nav.go(FEATURES_SCREEN)}>
          {t('simple.made.turnOn')}
        </Button>
      </Page>
    )
  }

  return (
    <Page data-testid="simple-made-goods">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.stock.madeGoods')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.made.subtitle')}</p>
        </div>
        <AccountantViewButton testId="btn-made-accountant-view" title={t('simple.made.accountantHint')} onOpen={accountantView} />
      </div>

      {saved ? (
        <SaveCard
          voucherIds={saved.ids}
          sentences={saved.sentences}
          printable={false}
          onNew={startNew}
          onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} // i18n-technical
          onUndone={() => void queryClient.invalidateQueries({ queryKey: ['simpleStock'] })} // i18n-technical
        />
      ) : setup && products.length === 0 ? (
        <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="made-no-recipes">
          <p className="text-body text-ink">{t('simple.made.noRecipes')}</p>
          <p className="mt-1 text-detail text-muted">{t('simple.made.noRecipesHint')}</p>
          <Button className="mt-3" data-testid="btn-made-set-recipe" onClick={() => nav.go(PRODUCTS_SCREEN)}>
            {t('simple.made.setRecipe')}
          </Button>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.made.what')}>
            <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.made.what')}</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr_1fr]">
              <Field label={t('simple.made.product')} name="item" error={errors.get(F.item)}>
                <TypeAhead
                  options={options}
                  value={form.itemId}
                  onPick={(id) => {
                    priceTouched.current = false
                    labourTouched.current = false
                    update({ itemId: id })
                  }}
                  placeholder={t('simple.made.productPlaceholder')}
                  testId="picker-made-product"
                  autoFocus={itemId == null}
                />
              </Field>
              <Field label={t('simple.made.howMany')} name="qty" error={errors.get(F.qty)}>
                <TextInput
                  value={form.qtyText}
                  inputMode="decimal"
                  placeholder={picked ? t('simple.made.inUnit', { unit: picked.unit }) : ''}
                  onChange={(e) => update({ qtyText: e.target.value })}
                  data-testid="input-made-qty"
                  autoFocus={itemId != null}
                />
              </Field>
              <Field label={t('simple.made.date')} name="date" error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-made-date" />
              </Field>
            </div>

            {picked && (
              <div className="mt-4 rounded-md border border-line bg-panel2 px-3 py-2" data-testid="made-recipe">
                <p className="text-body text-ink">
                  {t('simple.stock.recipeLine', {
                    name: picked.name,
                    list: picked.recipe.lines.map((l) => t('simple.stock.intent.usedItem', { name: l.name, qty: formatQtyMilli(l.qtyMilliPerUnit), unit: l.unit })).join(', ')
                  })}
                </p>
                {needs && (
                  <ul className="mt-2 text-detail text-ink" data-testid="made-needs">
                    {needs.map((n) => {
                      const line = picked.recipe.lines.find((l) => l.itemId === n.itemId)!
                      const have = onHand.get(n.itemId)?.qtyMilli ?? 0
                      const short = have < n.qtyMilli
                      return (
                        <li key={n.itemId} className={short ? 'text-danger' : ''} data-testid={`made-need-${n.itemId}`} data-short={short ? 'true' : 'false'}>
                          {short
                            ? t('simple.made.needShort', { name: line.name, qty: formatQtyMilli(n.qtyMilli), have: formatQtyMilli(have), unit: line.unit })
                            : t('simple.made.need', { name: line.name, qty: formatQtyMilli(n.qtyMilli), have: formatQtyMilli(have), unit: line.unit })}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.made.moneyPart')}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={picked ? t('simple.made.price', { name: picked.name }) : t('simple.made.priceNoProduct')} name="price" error={errors.get(F.price)} hint={t('simple.made.priceHint')}>
                <AmountInput
                  paise={form.price}
                  onPaise={(p) => {
                    priceTouched.current = true
                    update({ price: p })
                  }}
                  testId="input-made-price"
                />
              </Field>
              <Field label={t('simple.made.labour')} name="labour" error={errors.get(F.labour)} hint={t('simple.made.labourHint')}>
                <AmountInput
                  paise={form.labour}
                  onPaise={(p) => {
                    labourTouched.current = true
                    update({ labour: p })
                  }}
                  testId="input-made-labour"
                />
              </Field>
            </div>
            {(form.labour ?? 0) > 0 && (
              <div className="mt-4" data-testid="made-labour-question">
                <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.made.labourRecorded')}</span>
                <div role="radiogroup" aria-label={t('simple.made.labourRecorded')} className="flex flex-wrap gap-2">
                  {[true, false].map((yes) => (
                    <button
                      key={String(yes)}
                      type="button"
                      role="radio"
                      aria-checked={form.labourRecorded === yes}
                      data-testid={`made-labour-${yes ? 'yes' : 'no'}`}
                      onClick={() => update({ labourRecorded: yes })}
                      className={choice(form.labourRecorded === yes)}
                    >
                      {yes ? t('simple.made.labourYes') : t('simple.made.labourNo')}
                    </button>
                  ))}
                </div>
                <FieldError name="labourRecorded" error={errors.get(F.labourRecorded)} />
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-panel2 p-panel" aria-live="polite" data-testid="made-preview">
            {preview ? (
              <ul className="list-disc pl-5 text-body text-ink" data-testid="made-preview-lines">
                {preview.sentences.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <p className="min-h-5 text-body text-muted">{ready ? t('simple.made.checking') : t('simple.made.fillIn')}</p>
            )}
            {previewProblem && (
              <p role="status" className="mt-1 text-detail text-warning" data-testid="made-preview-problem">
                {previewProblem}
              </p>
            )}
          </section>

          {general && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="made-error">
              <p>{general.text}</p>
              <details className="mt-1 text-muted">
                <summary className="cursor-pointer">{t('common.details')}</summary>
                <p className="mt-1 font-mono text-small">{general.details}</p>
              </details>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
            <p className="text-small text-muted">{t('simple.made.shortcuts')}</p>
            {canSave ? (
              <Button variant="primary" data-testid="btn-made-save" disabled={saving} onClick={() => void save()}>
                {t('simple.made.save')}
              </Button>
            ) : (
              <ViewerNote />
            )}
          </div>
        </div>
      )}
    </Page>
  )
}
