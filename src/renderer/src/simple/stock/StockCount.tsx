import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimplePreview } from '@shared/simple/intents'
import { countDifference, countFormErrors, countIntentFrom, parseCountText, type CountField, type CountForm } from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSimplePost } from '../../lib/simplePost'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { confirmDialog } from '../../lib/dialogs'
import { useNav, useSession } from '../../state/stores'
import { Button, DateInput, Field, FieldError, isAnyModalOpen, Page, TextInput, useFormErrors } from '../../components/ui'
import { SaveCard } from '../SaveCard'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'

const F = { date: 'date', counts: 'counts' } as const satisfies Record<CountField, CountField> // i18n-technical: form field paths

const isDirty = (f: CountForm): boolean => Object.values(f.counted).some((v) => v.trim() !== '')

/**
 * WP 9.7 — Count your stock (plan §2.2): every product with what Total shows, a box for what is
 * actually on the shelf (blank = not counted, left as it is) and the difference in words. Save
 * records ONE stock count — the physical-stock entry the accountant's editor makes, through the
 * `stock_count` intent (simple:post); the value of a difference is the valuation engine's, said
 * in the preview and on the save card (Undo bins it). ⌘↵ saves, Esc asks before discarding.
 */
export function StockCount(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const poster = useSimplePost()
  const blank = (): CountForm => ({ date: workingDate, counted: {} })
  const [form, setForm] = useState<CountForm>(blank)
  const [search, setSearch] = useState('')
  const [saved, setSaved] = useState<{ ids: number[]; sentences: string[] } | null>(null)
  const [preview, setPreview] = useState<SimplePreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [general, setGeneral] = useState<{ text: string; details: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const saving = poster.status === 'posting'
  // What Total shows as on the count's date (the Stock summary's own pass).
  const { data } = useQuery({ queryKey: ['simpleStock', form.date], queryFn: () => api.simpleStock.list(form.date) }) // i18n-technical
  const rows = data?.rows ?? []
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows
  }, [rows, search])

  const errors = useFormErrors<CountField>({ date: form.date, counts: form.counted }, { simple: true, t })
  const clientErrors = useMemo(() => countFormErrors(form), [form])
  const dirty = !saved && !leaving && isDirty(form)
  useUnsavedGuard(dirty)
  useEffect(() => {
    if (leaving) nav.back()
  }, [leaving, nav])

  const update = (patch: Partial<CountForm>): void => {
    setGeneral(null)
    setForm((f) => ({ ...f, ...patch }))
  }
  const setCount = (itemId: number, text: string): void => update({ counted: { ...form.counted, [itemId]: text } })

  // ---------- the plain preview (simple:preview, rehearsed — nothing saved) ----------
  const ready = Object.keys(clientErrors).length === 0
  const intent = useMemo(() => (ready ? countIntentFrom(form) : null), [ready, form])
  const intentKey = intent ? JSON.stringify(intent) : ''
  const previewRef = useRef(poster.preview)
  previewRef.current = poster.preview
  useEffect(() => {
    setPreview(null)
    setPreviewProblem(null)
    if (!intent || saved) return
    const id = window.setTimeout(() => {
      previewRef.current(intent).then(
        (p) => setPreview(p),
        (err: unknown) => {
          const m = mapError(err as CaughtError, { simple: true, t })
          setPreviewProblem([m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('simple.stock.err.problem'))
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

  const save = async (): Promise<void> => {
    if (saving) return
    setGeneral(null)
    const keys = Object.entries(clientErrors) as [CountField, string][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, t(key as 'simple.stock.count.err.none')) // i18n-technical: keys from countFormErrors
      return
    }
    try {
      const r = await poster.post(countIntentFrom(form))
      setSaved({ ids: r.voucherIds, sentences: r.sentences })
      for (const k of ['simpleStock', 'simpleStockProduct', 'stockItems', 'stockSummary', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      place(err)
    }
  }

  const startNew = (): void => {
    poster.reset()
    setSaved(null)
    setPreview(null)
    setPreviewProblem(null)
    setGeneral(null)
    errors.clear()
    setForm(blank())
  }

  const askDiscard = (): Promise<boolean> =>
    confirmDialog({ title: t('simple.stock.count.discardTitle'), message: t('simple.stock.count.discardBody'), confirmLabel: t('simple.buy.discard'), cancelLabel: t('simple.buy.keepEditing'), danger: true })

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen()) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!saved) void save()
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

  // WP 9.10: the saved count, or the full stock count form with these counts filled in.
  const openFull = useAccountantView('simple-stock-count') // i18n-technical: screen name
  const accountantView = (always: boolean): void => void openFull({ intent: dirty ? intent : null, savedId: saved?.ids[0] ?? null, always })

  const counted = Object.values(form.counted).filter((v) => v.trim() !== '').length

  return (
    <Page data-testid="simple-stock-count">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.stock.count')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.stock.count.subtitle')}</p>
        </div>
        <AccountantViewButton testId="btn-count-accountant-view" title={t('simple.stock.count.accountantHint')} onOpen={accountantView} />
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
      ) : (
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_2fr]">
              <Field label={t('simple.stock.count.date')} name="date" error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={((d: string) => toPlainDate(d, t.lang))} testId="input-count-date" />
              </Field>
              <Field label={t('simple.stock.count.find')}>
                <TextInput value={search} placeholder={t('simple.stock.count.findPlaceholder')} onChange={(e) => setSearch(e.target.value)} data-testid="input-count-search" />
              </Field>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.stock.count')}>
            <p className="mb-3 text-small text-muted">{t('simple.stock.count.hint')}</p>
            <FieldError name="counts" error={errors.get(F.counts)} />
            {rows.length === 0 ? (
              <p className="text-detail text-muted" data-testid="count-empty">{t('simple.stock.empty')}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="count-rows">
                {shown.map((r) => {
                  const text = form.counted[r.itemId] ?? ''
                  const milli = parseCountText(text)
                  const bad = text.trim() !== '' && milli == null
                  const d = milli != null ? countDifference(r.qtyMilli, milli) : null
                  const qty = (m: number): string => t('simple.stock.qtyUnit', { qty: formatQtyMilli(m), unit: r.unit })
                  return (
                    <li key={r.itemId} className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[2fr_1fr_8rem_2fr]" data-testid={`count-row-${r.itemId}`}>
                      <span className="text-body text-ink">{r.name}</span>
                      <span className="num text-detail text-muted">{t('simple.stock.count.shows', { qty: qty(r.qtyMilli) })}</span>
                      <TextInput
                        value={text}
                        inputMode="decimal"
                        aria-label={t('simple.stock.count.countedOf', { name: r.name })}
                        placeholder={t('simple.stock.count.notCounted')}
                        className={`num text-right ${bad ? 'border-danger/70' : ''}`}
                        onChange={(e) => setCount(r.itemId, e.target.value)}
                        data-testid={`input-count-${r.itemId}`}
                      />
                      <span
                        className={`text-detail ${d?.kind === 'short' ? 'text-danger' : d?.kind === 'extra' ? 'text-ink' : 'text-muted'}`}
                        data-testid={`count-diff-${r.itemId}`}
                        data-kind={d?.kind ?? (bad ? 'bad' : 'none')}
                      >
                        {bad
                          ? t('simple.stock.count.err.qty')
                          : d == null
                            ? ''
                            : d.kind === 'same'
                              ? t('simple.stock.count.same')
                              : d.kind === 'short'
                                ? t('simple.stock.count.short', { qty: qty(d.milli) })
                                : t('simple.stock.count.extra', { qty: qty(d.milli) })}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-line bg-panel2 p-panel" aria-live="polite" data-testid="count-preview">
            {!preview && <p className="text-body text-ink">{t('simple.stock.count.countedN', { count: counted })}</p>}
            {preview && (
              <ul className="list-disc pl-5 text-body text-ink" data-testid="count-preview-lines">
                {preview.sentences.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
            {previewProblem && (
              <p role="status" className="mt-1 text-detail text-warning" data-testid="count-preview-problem">
                {previewProblem}
              </p>
            )}
          </section>

          {general && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="count-error">
              <p>{general.text}</p>
              <details className="mt-1 text-muted">
                <summary className="cursor-pointer">{t('common.details')}</summary>
                <p className="mt-1 font-mono text-small">{general.details}</p>
              </details>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
            <p className="text-small text-muted">{t('simple.stock.count.shortcuts')}</p>
            <Button variant="primary" data-testid="btn-count-save" disabled={saving} onClick={() => void save()}>
              {t('simple.stock.count.save')}
            </Button>
          </div>
        </div>
      )}
    </Page>
  )
}
