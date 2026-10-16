import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import {
  formFieldOf, recipeFormErrors, recipeFormFrom, recipeInputFrom, type RecipeForm, type RecipeFormErrorKey, type StockProductView
} from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { AmountInput, Button, Field, FieldError, TextInput, useFormErrors } from '../../components/ui'
import { TypeAhead } from '../../components/pickers'
import { useCanSave } from '../ViewerNote'

/** The full product form, where the accountant BOM editor (every version) lives. */
const fullItemScreen = (itemId: number): { name: 'masters'; tab: 'items'; itemId: number } => ({ name: 'masters', tab: 'items', itemId }) // i18n-technical
const INVALIDATE = ['simpleStockProduct', 'simpleStock', 'simpleMadeSetup', 'bomVersions', 'bom'] as const // i18n-technical: query keys

const itemField = (i: number): string => `rows.${i}.item` // i18n-technical: form field path
const qtyField = (i: number): string => `rows.${i}.qty` // i18n-technical: form field path
const ROWS = 'rows' // i18n-technical: form field path
const LABOUR = 'labour' // i18n-technical: form field path

const blankRow = (): RecipeForm['rows'][number] => ({ itemId: null, qtyText: '' })

/** The form's values by field path — what useFormErrors watches to clear a message once its
 *  field changes. */
function fieldValues(form: RecipeForm): Record<string, unknown> {
  const out: Record<string, unknown> = { rows: form.rows.length, labour: form.labourPerUnit }
  form.rows.forEach((r, i) => {
    out[`rows.${i}.item`] = r.itemId
    out[`rows.${i}.qty`] = r.qtyText
  })
  return out
}

/**
 * The recipe on a product's simple view (shown only while manufacturing is on): "To make 1 X you
 * use …" in words, and for an accountant / owner "Add a recipe" / "Change recipe" — material rows
 * (product picker + how much per one, in its unit) and an optional labour per one. Save =
 * simple:stock:setRecipe → ONE new BOM version through the accountant BOM service (first recipe:
 * always; a change: from the working date — what was made before keeps the old one). A viewer
 * sees it read-only. "Accountant view" opens the product's full form with its BOM editor.
 */
export function RecipeSection({ product }: { product: StockProductView }): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const [form, setForm] = useState<RecipeForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [general, setGeneral] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const editing = form != null
  const { data: stock } = useQuery({ queryKey: ['simpleStock', workingDate], queryFn: () => api.simpleStock.list(workingDate), enabled: editing }) // i18n-technical
  const products = useMemo(() => (stock?.rows ?? []).filter((r) => r.itemId !== product.itemId), [stock, product.itemId])
  const options = useMemo(() => products.map((r) => ({ id: r.itemId, label: r.name })), [products])
  const unitOf = (id: number | null): string | null => (id == null ? null : (products.find((r) => r.itemId === id)?.unit ?? null))
  const values = useMemo(() => (form ? fieldValues(form) : {}), [form])
  const errors = useFormErrors<string>(values, { simple: true, t })
  const recipe = product.recipe
  const money = (v: number): string => formatPaise(v, { symbol: true })

  const start = (): void => {
    const f = recipeFormFrom(recipe)
    setForm({ ...f, rows: [...f.rows, blankRow()] })
    setGeneral(null)
    setNote(null)
    errors.clear()
  }
  const cancel = (): void => {
    setForm(null)
    setGeneral(null)
    errors.clear()
  }
  const update = (fn: (f: RecipeForm) => RecipeForm): void => {
    setGeneral(null)
    setForm((f) => (f ? fn(f) : f))
  }
  const setRow = (i: number, patch: Partial<RecipeForm['rows'][number]>): void =>
    update((f) => {
      const rows = f.rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
      // Always one empty row at the end to add the next material.
      const last = rows[rows.length - 1]
      if (!last || last.itemId != null || last.qtyText.trim() !== '') rows.push(blankRow())
      return { ...f, rows }
    })
  const removeRow = (i: number): void => update((f) => ({ ...f, rows: f.rows.length > 1 ? f.rows.filter((_r, j) => j !== i) : [blankRow()] }))

  const save = async (): Promise<void> => {
    if (!form || saving) return
    const client = Object.entries(recipeFormErrors(form, product.itemId)) as [string, RecipeFormErrorKey][]
    if (client.length) {
      errors.clear()
      for (const [f, key] of client) errors.set(f, t(key)) // i18n-technical: keys from recipeFormErrors
      return
    }
    const input = recipeInputFrom(form, product.itemId)
    setSaving(true)
    setGeneral(null)
    try {
      const r = await api.simpleStock.setRecipe({ itemId: input.itemId, rows: input.rows, labourPerUnit: input.labourPerUnit }, workingDate)
      setForm(null)
      setNote(
        !r.changed
          ? t('simple.stock.recipe.unchanged')
          : r.recipe?.effectiveFrom
            ? `${t('simple.stock.recipe.saved')} ${t('simple.stock.recipe.fromDate', { date: toPlainDate(r.recipe.effectiveFrom, t.lang) })}`
            : t('simple.stock.recipe.saved')
      )
      for (const k of INVALIDATE) void queryClient.invalidateQueries({ queryKey: [k] })
    } catch (err) {
      // A refusal on a sent row lands on the FORM's row (blank rows were not sent).
      const caught = err as CaughtError
      const placed: CaughtError = {
        ...caught,
        message: caught.message,
        ...(caught.field ? { field: formFieldOf(caught.field, input.rowIndex) } : {}),
        ...(caught.issues ? { issues: caught.issues.map((i) => (i.field ? { ...i, field: formFieldOf(i.field, input.rowIndex) } : i)) } : {})
      }
      const mapped = errors.apply(Object.assign(new Error(caught.message), placed))
      if (mapped.general || Object.keys(mapped.fields).length === 0) setGeneral(mapped.general || mapError(placed, { simple: true, t }).general || t('errors.generic'))
    } finally {
      setSaving(false)
    }
  }

  const recipeText = recipe
    ? t('simple.stock.recipeLine', {
        name: product.name,
        list: recipe.lines.map((l) => t('simple.stock.intent.usedItem', { name: l.name, qty: formatQtyMilli(l.qtyMilliPerUnit), unit: l.unit })).join(', ')
      })
    : null

  return (
    <section className="mt-4 rounded-md border border-line bg-panel2 px-3 py-3" aria-label={t('simple.stock.recipe.title')} data-testid="stock-recipe-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.recipe.title')}</h2>
        <button
          type="button"
          className="text-detail text-blue hover:underline"
          title={t('simple.stock.recipe.accountantHint')}
          data-testid="btn-recipe-accountant-view"
          onClick={() => nav.go(fullItemScreen(product.itemId))}
        >
          {t('common.accountantView')}
        </button>
      </div>

      {!editing && (
        <>
          {recipeText ? (
            <>
              <p className="mt-1 text-body text-ink" data-testid="stock-product-recipe">
                {recipeText}
              </p>
              {recipe?.labourPerUnit != null && (
                <p className="mt-1 text-detail text-ink" data-testid="stock-recipe-labour">
                  {t('simple.stock.recipe.labourLine', { amount: money(recipe.labourPerUnit) })}
                </p>
              )}
              {recipe?.effectiveFrom && <p className="mt-1 text-small text-muted">{t('simple.stock.recipe.since', { date: toPlainDate(recipe.effectiveFrom, t.lang) })}</p>}
            </>
          ) : (
            <p className="mt-1 text-detail text-muted" data-testid="stock-recipe-none">
              {canSave ? t('simple.stock.recipe.none', { name: product.name }) : t('simple.stock.recipe.noneViewer')}
            </p>
          )}
          {note && (
            <p role="status" className="mt-1 text-detail text-ink" data-testid="stock-recipe-note">
              {note}
            </p>
          )}
          {canSave && (
            <Button className="mt-2" data-testid="btn-recipe-edit" onClick={start}>
              {recipe ? t('simple.stock.recipe.change') : t('simple.stock.recipe.add')}
            </Button>
          )}
        </>
      )}

      {editing && form && (
        <div className="mt-2" data-testid="stock-recipe-editor">
          <p className="mb-2 text-body font-semibold text-ink">{t('simple.stock.recipe.heading', { name: product.name })}</p>
          <ul className="flex flex-col gap-2">
            {form.rows.map((row, i) => {
              const unit = unitOf(row.itemId)
              const isLast = i === form.rows.length - 1 && row.itemId == null && row.qtyText.trim() === ''
              return (
                <li key={i} className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[2fr_1fr_auto]" data-testid={`recipe-row-${i}`}>
                  <Field label={t('simple.stock.recipe.material', { n: i + 1 })} name={itemField(i)} error={errors.get(itemField(i))}>
                    <TypeAhead
                      options={options}
                      value={row.itemId}
                      onPick={(id) => setRow(i, { itemId: id })}
                      placeholder={t('simple.stock.recipe.pick')}
                      testId={`picker-recipe-item-${i}`}
                      autoFocus={i === 0 && row.itemId == null}
                    />
                  </Field>
                  <Field label={unit ? t('simple.stock.recipe.qtyIn', { unit }) : t('simple.stock.recipe.qty')} name={qtyField(i)} error={errors.get(qtyField(i))}>
                    <TextInput
                      value={row.qtyText}
                      inputMode="decimal"
                      className="num text-right"
                      onChange={(e) => setRow(i, { qtyText: e.target.value })}
                      data-testid={`input-recipe-qty-${i}`}
                    />
                  </Field>
                  {!isLast ? (
                    <Button
                      className="sm:mt-6"
                      variant="ghost"
                      aria-label={t('simple.stock.recipe.removeRow', { n: i + 1 })}
                      data-testid={`btn-recipe-remove-${i}`}
                      onClick={() => removeRow(i)}
                    >
                      {t('common.remove')}
                    </Button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </li>
              )
            })}
          </ul>
          <FieldError name={ROWS} error={errors.get(ROWS)} />
          <div className="mt-3 max-w-xs">
            <Field label={t('simple.stock.recipe.labour')} name={LABOUR} error={errors.get(LABOUR)} hint={t('simple.stock.recipe.labourHint')}>
              <AmountInput paise={form.labourPerUnit} onPaise={(p) => update((f) => ({ ...f, labourPerUnit: p }))} testId="input-recipe-labour" />
            </Field>
          </div>
          <p className="mt-2 text-small text-muted">
            {recipe ? t('simple.stock.recipe.fromDate', { date: toPlainDate(workingDate, t.lang) }) : t('simple.stock.recipe.firstHint')}
          </p>
          {general && (
            <p role="alert" className="mt-2 text-detail text-danger" data-testid="stock-recipe-error">
              {general}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={saving} data-testid="btn-recipe-save" onClick={() => void save()}>
              {t('simple.stock.recipe.save')}
            </Button>
            <Button disabled={saving} data-testid="btn-recipe-cancel" onClick={cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
