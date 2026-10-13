import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { slabsOn } from '@shared/gst/rateTable'
import { nearDuplicates } from '@shared/simple/nearDuplicate'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { itemShowsGst, itemShowsHsn, presetUnitId } from '../lib/itemDefaults'
import { isBusinessType } from '@shared/simple/presets'
import { useSession, useToasts } from '../state/stores'
import { AmountInput, Button, Field, Modal, Select, TextInput, useFormErrors } from '../components/ui'
import { useStockItems } from '../components/pickers'

const F = { name: 'name', unit: 'unit', gstRate: 'gstRate', sellingPrice: 'sellingPrice' } as const // i18n-technical: form field paths
type FieldName = (typeof F)[keyof typeof F]

/** The rate text as a number in 0–100, or null when it isn't one. */
function rateOf(text: string): number | null {
  const n = Number(text.trim())
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null
}

/**
 * WP 8.4 — the plain "New product" dialog opened from a bill line (plan §4.2): name, the unit it is
 * sold by (the preset's default), a selling price (saved on the company's default price level by
 * `master:stockItems:quickCreate`, so the pricing resolver fills it in on new bills — its order
 * unchanged), an optional purchase price, and — only in a REGULAR GST company (WP 8.0) — the GST
 * rate, picked from the cited slab table in force on the working date (shared/gst/rateTable.ts;
 * blank and required, never pre-picked; which slab a product falls in is for the user / CA).
 */
export function NewProductDialog({
  name,
  onClose,
  onCreated
}: {
  name: string
  onClose: () => void
  onCreated: (id: number) => void
}): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list }) // i18n-technical
  const regType = useSession((s) => s.info?.gstRegistrationType ?? 'regular') // i18n-technical
  const businessTypeRaw = useSession((s) => s.ui.setup?.businessType)
  const businessType = isBusinessType(businessTypeRaw) ? businessTypeRaw : null
  const workingDate = useSession((s) => s.workingDate)
  const showGst = itemShowsGst(regType)
  const slabs = useMemo(() => slabsOn(workingDate), [workingDate])

  const [itemName, setItemName] = useState(name)
  const [unitId, setUnitId] = useState<number | null>(null)
  const [selling, setSelling] = useState<number | null>(null)
  const [purchase, setPurchase] = useState<number | null>(null)
  const [rate, setRate] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
  const [hsn, setHsn] = useState('')
  const [saving, setSaving] = useState(false)
  const [asked, setAsked] = useState(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  useEffect(() => setAsked(false), [itemName])
  useEffect(() => {
    if (unitId == null && units?.length) setUnitId(presetUnitId(units, businessType))
  }, [units, unitId, businessType])

  const errors = useFormErrors<FieldName>({ name: itemName, unit: unitId, gstRate: rate, sellingPrice: selling }, { simple: true, t })
  const dups = useMemo(() => nearDuplicates(itemName, items), [itemName, items])
  const sameName = dups.find((d) => d.same)
  const special = slabs.filter((s) => !s.common)
  const picked = rateOf(rate)
  const isListed = picked != null && slabs.some((s) => s.rate === picked)

  const create = async (): Promise<void> => {
    const trimmed = itemName.trim()
    let bad = false
    if (!trimmed) {
      errors.set(F.name, t('simple.newAccount.nameMissing'))
      bad = true
    }
    if (showGst) {
      if (!rate.trim()) {
        errors.set(F.gstRate, t('errors.pickGstRate'))
        bad = true
      } else if (picked == null) {
        errors.set(F.gstRate, t('errors.gstRateInvalid'))
        bad = true
      }
    }
    if (bad || unitId == null) return
    if (dups.length > 0 && (sameName || confirmed !== trimmed)) {
      setAsked(true)
      return
    }
    setSaving(true)
    try {
      const res = await api.stockItems.quickCreate({
        item: {
          name: trimmed,
          groupId: null,
          unitId,
          hsn: itemShowsHsn(regType) && hsn.trim() ? hsn.trim() : null,
          gstRate: showGst ? picked : null,
          cessRate: null,
          openingQtyMilli: 0,
          openingValue: 0,
          barcode: null,
          reorderLevelMilli: null
        },
        sellingPricePaise: selling && selling > 0 ? selling : null,
        purchasePricePaise: purchase && purchase > 0 ? purchase : null
      })
      await queryClient.invalidateQueries({ queryKey: ['stockItems'] }) // i18n-technical
      await queryClient.invalidateQueries({ queryKey: ['priceLevels'] }) // i18n-technical
      toast.push('success', t('simple.newProduct.created', { name: res.item.name }))
      onCreated(res.item.id)
    } catch (err) {
      const mapped = errors.apply(err)
      if (mapped.general) toast.push('error', mapped.general)
    } finally {
      setSaving(false)
    }
  }

  const chip = (value: number, label: string): React.JSX.Element => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={picked === value && rate.trim() !== ''}
      data-testid={`gst-rate-${value}`}
      onClick={() => setRate(String(value))}
      className={`${value === 0 ? '' : 'num '}rounded-md border px-3 py-1.5 text-detail transition-colors focus-visible:outline-2 focus-visible:outline-amber/70 ${
        picked === value && rate.trim() !== '' ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
      }`}
    >
      {label}
    </button>
  )

  return (
    <Modal title={t('simple.newProduct.title')} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="dialog-new-product">
        <Field label={t('simple.newProduct.name')} name={F.name} error={errors.get(F.name)}>
          <TextInput autoFocus value={itemName} onChange={(e) => setItemName(e.target.value)} data-testid="input-product-name" />
        </Field>

        {asked && dups.length > 0 && (
          <div role="alert" className="rounded-md border border-amber/60 bg-amberbar/10 px-3 py-2.5" data-testid="product-did-you-mean">
            <p className="text-detail font-semibold text-ink">
              {sameName ? t('simple.newAccount.alreadyThere', { name: sameName.name }) : t('simple.newAccount.didYouMean', { name: dups[0]!.name })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {dups.map((d) => (
                <Button key={d.id} variant="primary" data-testid={`btn-dup-use-${d.id}`} onClick={() => onCreated(d.id)}>
                  {t('simple.newAccount.useExisting', { name: d.name })}
                </Button>
              ))}
              {!sameName && (
                <Button
                  data-testid="btn-dup-create"
                  onClick={() => {
                    setConfirmed(itemName.trim())
                    setAsked(false)
                  }}
                >
                  {t('simple.newAccount.createAnyway', { name: itemName.trim() })}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Field label={t('simple.newProduct.unit')} name={F.unit}>
            <Select value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))} data-testid="select-product-unit">
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.symbol}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={showGst ? t('simple.newProduct.sellingPriceBeforeGst') : t('simple.newProduct.sellingPrice')}
            name={F.sellingPrice}
            className="col-span-2"
            hint={t('simple.newProduct.sellingPriceHint')}
          >
            <AmountInput paise={selling} onPaise={setSelling} testId="input-product-selling" />
          </Field>
        </div>
        <Field label={t('simple.newProduct.purchasePrice')} hint={t('simple.newProduct.purchasePriceHint')}>
          <AmountInput paise={purchase} onPaise={setPurchase} testId="input-product-purchase" />
        </Field>

        {showGst && (
          <div data-testid="product-gst">
            <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.newProduct.gstRate')}</span>
            <p className="mb-2 text-small text-muted">{t('simple.newProduct.gstRateWhat')}</p>
            <div role="radiogroup" aria-label={t('simple.newProduct.gstRate')} className="flex flex-wrap gap-2">
              {slabs.filter((s) => s.common).map((s) => chip(s.rate, s.rate === 0 ? t('simple.newProduct.gstNil') : `${s.rate}%`))}
              <button
                type="button"
                data-testid="gst-rate-other"
                aria-expanded={otherOpen}
                onClick={() => setOtherOpen((o) => !o)}
                className="rounded-md border border-dashed border-line px-3 py-1.5 text-detail text-muted hover:border-amber/60"
              >
                {t('simple.newProduct.otherRates')}
              </button>
            </div>
            {(otherOpen || (picked != null && !slabs.find((s) => s.rate === picked)?.common && rate.trim() !== '')) && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {special.map((s) => chip(s.rate, `${s.rate}%`))}
                <Field label={t('simple.newProduct.otherRateLabel')} className="w-44">
                  <TextInput
                    value={isListed ? '' : rate}
                    placeholder={t('simple.newProduct.otherRate')}
                    onChange={(e) => setRate(e.target.value)}
                    className="num"
                    data-testid="input-product-gst-other"
                  />
                </Field>
              </div>
            )}
            {errors.get(F.gstRate) && (
              <p role="alert" className="mt-1 text-hint text-danger" data-testid="field-error-gstRate">
                {errors.get(F.gstRate)}
              </p>
            )}
            <p className="mt-2 text-caption text-muted">{t('simple.newProduct.cessNote')}</p>
          </div>
        )}

        {itemShowsHsn(regType) && (
          <Field label={showGst ? t('simple.newProduct.hsnRegular') : t('simple.newProduct.hsn')} hint={t('simple.newProduct.hsnHint')}>
            <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" data-testid="input-product-hsn" />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-product-create" onClick={() => void create()}>
            {t('simple.newProduct.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
