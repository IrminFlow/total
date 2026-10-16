import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { AmountInput, Button, DateInput, Field, Select, TextInput } from '../components/ui'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { useSession } from '../state/stores'
import type { MessageKey } from '@shared/i18n'
import {
  OPENING_OTHER_KINDS,
  billNames,
  openingGstChoices,
  parseQtyText,
  readCustomGstRate,
  stockLineValue,
  type BillDraft,
  type ItemDraft,
  type MoneyRowDraft,
  type OpeningOtherKind,
  type OpeningsDraft,
  type OpeningsErrors,
  type OpeningsState,
  type OtherDraft,
  type PartyDraft
} from '@shared/simple/openings'

/** WP 8.7: the opening setup's steps (Openings.tsx holds the answers and moves between them).
 *  Every word through t(); each problem sits under its own field. */
export interface OpeningsStepProps {
  draft: OpeningsDraft
  update: (fn: (d: OpeningsDraft) => OpeningsDraft) => void
  state: OpeningsState
}

let keySeq = 0
const LOAN_TAKEN = 'loan_taken' as const // i18n-technical
export const newKey = (): string => `n${++keySeq}`
const rupees = (paise: number): string => formatPaise(paise, { symbol: true })

/** The step's errors by field path ('banks.0.amount' …); OField shows its own under it. */
export const OpeningsErrorsContext = createContext<OpeningsErrors>({})

/** A Field whose message comes from the step's errors by its `name` (the field path). */
function OField(props: Omit<Parameters<typeof Field>[0], 'error'> & { name: string }): React.JSX.Element {
  const t = useT()
  const key = useContext(OpeningsErrorsContext)[props.name]
  return <Field {...props} error={key ? t(key) : null} /> // i18n-technical: errors.openings.* keys (OpeningsErrorKey)
}

export function Question({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="mb-4">
      <h2 className="text-lead font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 text-small text-muted">{hint}</p>
    </div>
  )
}

function Total({ children, testId }: { children: ReactNode; testId: string }): React.JSX.Element {
  return (
    <p className="mt-4 text-right text-body font-semibold text-ink num" data-testid={testId}>
      {children}
    </p>
  )
}

function RemoveButton({ onClick, testId }: { onClick: () => void; testId: string }): React.JSX.Element {
  const t = useT()
  return (
    <button type="button" data-testid={testId} onClick={onClick} className="text-small text-muted underline-offset-2 hover:text-danger hover:underline">
      {t('simple.openings.remove')}
    </button>
  )
}

// ---------- money ----------

type MoneyPath = 'banks' | 'overdrafts'

/** Bank rows (money you have) or overdrafts (what you owe the bank): a loaded row shows its name
 *  and can be cleared ("Remove" sends it at zero); a new row asks for a name. */
function MoneyRows({ path, draft, update, date }: { path: MoneyPath; draft: OpeningsDraft; update: OpeningsStepProps['update']; date: string }): React.JSX.Element {
  const t = useT()
  const rows = draft[path]
  const set = (i: number, patch: Partial<MoneyRowDraft>): void => update((d) => ({ ...d, [path]: d[path].map((b, j) => (j === i ? { ...b, ...patch } : b)) }))
  const amountLabel = path === 'banks' ? t('simple.openings.money.bankBalance', { date }) : t('simple.openings.overdraft.amount', { date })
  const prefix = path === 'banks' ? 'bank' : 'overdraft' // i18n-technical: test ids
  return (
    <>
      {rows.map((b, i) => (
        <div key={b.key} className="grid grid-cols-1 gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_12rem_4rem] md:items-start" data-testid={`openings-${prefix}-${i}`}>
          {b.ledgerId != null ? (
            <p className="pt-6 text-body font-semibold text-ink">{b.name}</p>
          ) : (
            <OField label={path === 'banks' ? t('simple.openings.money.bankName') : t('simple.openings.overdraft.name')} name={`${path}.${i}.name`}>
              <TextInput data-testid={`openings-${prefix}-${i}-name`} value={b.name} placeholder={t('simple.openings.money.bankNamePlaceholder')} onChange={(e) => set(i, { name: e.target.value })} />
            </OField>
          )}
          <OField label={amountLabel} name={`${path}.${i}.amount`}>
            <AmountInput testId={`openings-${prefix}-${i}-amount`} paise={b.amount} onPaise={(p) => set(i, { amount: p })} />
          </OField>
          <div className="md:pt-6">
            <RemoveButton
              testId={`openings-${prefix}-${i}-remove`}
              onClick={() => update((d) => ({ ...d, [path]: b.ledgerId != null ? d[path].map((x, j) => (j === i ? { ...x, amount: null } : x)) : d[path].filter((_, j) => j !== i) }))}
            />
          </div>
        </div>
      ))}
    </>
  )
}

const blankMoneyRow = (): MoneyRowDraft => ({ key: newKey(), ledgerId: null, name: '', amount: null, base: null })

export function MoneyStep({ draft, update, state }: OpeningsStepProps): React.JSX.Element {
  const t = useT()
  const date = toPlainDate(state.booksBegin, t.lang)
  const total = (draft.cash.amount ?? 0) + draft.banks.reduce((s, b) => s + (b.amount ?? 0), 0)
  return (
    <div data-testid="openings-step-money">
      <Question title={t('simple.openings.money.title')} hint={t('simple.openings.money.hint', { date })} />
      <div className="flex flex-col gap-3">
        <OField label={t('simple.openings.money.cash')} name="cash.amount">
          <AmountInput testId="openings-cash" paise={draft.cash.amount} onPaise={(p) => update((d) => ({ ...d, cash: { ...d.cash, amount: p } }))} autoFocus />
        </OField>
        <MoneyRows path={BANKS} draft={draft} update={update} date={date} />
        <div>
          <Button type="button" variant="ghost" className="text-ink" data-testid="openings-add-bank" onClick={() => update((d) => ({ ...d, banks: [...d.banks, blankMoneyRow()] }))}>
            {t('simple.openings.money.addBank')}
          </Button>
        </div>
        {draft.overdrafts.length > 0 && <p className="text-small text-muted" data-testid="openings-overdraft-note">{t('simple.openings.overdraft.note')}</p>}
      </div>
      <Total testId="openings-money-total">{t('simple.openings.money.total', { amount: rupees(total) })}</Total>
    </div>
  )
}

const BANKS: MoneyPath = 'banks' // i18n-technical
const OVERDRAFTS: MoneyPath = 'overdrafts' // i18n-technical

// ---------- customers / suppliers ----------

const PARTY_TEXT: Record<
  'customers' | 'suppliers',
  {
    title: MessageKey
    hint: MessageKey
    name: MessageKey
    add: MessageKey
    total: MessageKey
    none: MessageKey
  }
> = {
  customers: {
    title: 'simple.openings.customers.title',
    hint: 'simple.openings.customers.hint',
    name: 'simple.openings.customers.name',
    add: 'simple.openings.customers.add',
    total: 'simple.openings.customers.total',
    none: 'simple.openings.customers.none'
  },
  suppliers: {
    title: 'simple.openings.suppliers.title',
    hint: 'simple.openings.suppliers.hint',
    name: 'simple.openings.suppliers.name',
    add: 'simple.openings.suppliers.add',
    total: 'simple.openings.suppliers.total',
    none: 'simple.openings.suppliers.none'
  }
}

const blankBill = (): BillDraft => ({
  key: newKey(),
  ref: '',
  date: '',
  amount: null
})

export function PartiesStep({ side, draft, update, state }: OpeningsStepProps & { side: 'customers' | 'suppliers' }): React.JSX.Element {
  const t = useT()
  const say = (k: MessageKey, vars?: Record<string, string>): string => t(k, vars) // i18n-technical: keys from PARTY_TEXT
  const listId = useId()
  const text = PARTY_TEXT[side]
  const date = toPlainDate(state.booksBegin, t.lang)
  const rows = draft[side]
  const listed = new Set(rows.map((r) => r.name.trim().toLowerCase()))
  const suggestions = state.pick[side].filter((p) => !listed.has(p.name.toLowerCase()))
  const setRows = (fn: (rows: PartyDraft[]) => PartyDraft[]): void => update((d) => ({ ...d, [side]: fn(d[side]) }))
  const setRow = (i: number, patch: Partial<PartyDraft>): void => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setBill = (i: number, k: number, patch: Partial<BillDraft>): void =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i
          ? {
              ...r,
              bills: r.bills.map((b, l) => (l === k ? { ...b, ...patch } : b))
            }
          : r
      )
    )
  const total = rows.reduce((s, r) => s + r.bills.reduce((x, b) => x + (b.amount ?? 0), 0), 0) + (side === 'suppliers' ? draft.overdrafts.reduce((s, b) => s + (b.amount ?? 0), 0) : 0)
  const prefix = side === 'customers' ? 'customer' : 'supplier' // i18n-technical: test ids
  // The numbers blank bills will get (shown greyed in their box), in date order.
  const generated = (r: PartyDraft): string[] =>
    billNames(
      r.bills.map((b) => b.ref),
      r.bills.map((b) => b.date || null),
      state.booksBegin
    )
  const mismatched = new Set(state[side].filter((p) => p.mismatch).map((p) => p.ledgerId))
  return (
    <div data-testid={`openings-step-${side}`}>
      <Question title={say(text.title)} hint={say(text.hint, { date })} />
      <datalist id={listId}>
        {suggestions.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>
      <div className="flex flex-col gap-3">
        {rows.length === 0 && <p className="text-small text-muted">{say(text.none)}</p>}
        {rows.map((r, i) => (
          <div key={r.key} className="rounded-md border border-line p-3" data-testid={`openings-${prefix}-${i}`}>
            <div className="flex items-start justify-between gap-3">
              {r.ledgerId != null ? (
                <p className="pt-1 text-body font-semibold text-ink">{r.name}</p>
              ) : (
                <OField className="min-w-0 flex-1" label={say(text.name)} name={`${side}.${i}.name`}>
                  <TextInput
                    data-testid={`openings-${prefix}-${i}-name`}
                    list={listId}
                    value={r.name}
                    placeholder={t('simple.openings.party.namePlaceholder')}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                  />
                </OField>
              )}
              <div className={r.ledgerId != null ? 'pt-1' : 'pt-6'}>
                <RemoveButton
                  testId={`openings-${prefix}-${i}-remove`}
                  onClick={() => setRows((rs) => (r.ledgerId != null ? rs.map((x, j) => (j === i ? { ...x, bills: [] } : x)) : rs.filter((_, j) => j !== i)))}
                />
              </div>
            </div>
            {r.ledgerId != null && mismatched.has(r.ledgerId) && (
              <p className="mt-1 text-small text-warning" data-testid={`openings-${prefix}-${i}-mismatch`}>
                {t('simple.openings.party.mismatch')}
              </p>
            )}
            {r.bills.map((b, k) => (
              <div key={b.key} className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[1fr_11rem_10rem_4rem] md:items-start">
                <OField label={t('simple.openings.bill.number')} name={`${side}.${i}.bills.${k}.ref`}>
                  <TextInput
                    data-testid={`openings-${prefix}-${i}-bill-${k}-ref`}
                    value={b.ref}
                    placeholder={generated(r)[k]}
                    onChange={(e) => setBill(i, k, { ref: e.target.value })}
                  />
                </OField>
                <OField label={t('simple.openings.bill.date')} name={`${side}.${i}.bills.${k}.date`}>
                  <DateInput
                    testId={`openings-${prefix}-${i}-bill-${k}-date`}
                    value={b.date}
                    context={state.booksBegin}
                    allowEmpty
                    format={((d: string) => toPlainDate(d, t.lang))}
                    placeholder={t('simple.openings.bill.datePlaceholder', {
                      date
                    })}
                    onChange={(iso) => setBill(i, k, { date: iso })}
                  />
                </OField>
                <OField label={t('simple.openings.bill.amount')} name={`${side}.${i}.bills.${k}.amount`}>
                  <AmountInput testId={`openings-${prefix}-${i}-bill-${k}-amount`} paise={b.amount} onPaise={(p) => setBill(i, k, { amount: p })} />
                </OField>
                <div className="md:pt-6">
                  {r.bills.length > 1 && (
                    <RemoveButton testId={`openings-${prefix}-${i}-bill-${k}-remove`} onClick={() => setRow(i, { bills: r.bills.filter((_, l) => l !== k) })} />
                  )}
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="mt-2 text-ink"
              data-testid={`openings-${prefix}-${i}-add-bill`}
              onClick={() => setRow(i, { bills: [...r.bills, blankBill()] })}
            >
              {t('simple.openings.bill.add')}
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            className="text-ink"
            data-testid={`openings-add-${prefix}`}
            onClick={() =>
              setRows((rs) => [
                ...rs,
                {
                  key: newKey(),
                  ledgerId: null,
                  name: '',
                  base: null,
                  bills: [blankBill()]
                }
              ])
            }
          >
            {say(text.add)}
          </Button>
        </div>
      </div>
      {side === 'suppliers' && (
        <div className="mt-6" data-testid="openings-overdrafts">
          <Question title={t('simple.openings.overdraft.title')} hint={t('simple.openings.overdraft.hint', { date })} />
          <div className="flex flex-col gap-3">
            <MoneyRows path={OVERDRAFTS} draft={draft} update={update} date={date} />
            <div>
              <Button type="button" variant="ghost" className="text-ink" data-testid="openings-add-overdraft" onClick={() => update((d) => ({ ...d, overdrafts: [...d.overdrafts, blankMoneyRow()] }))}>
                {t('simple.openings.overdraft.add')}
              </Button>
            </div>
          </div>
        </div>
      )}
      <Total testId={`openings-${side}-total`}>{say(text.total, { amount: rupees(total) })}</Total>
    </div>
  )
}

// ---------- stock ----------

/** The rate picker's "Custom rate (check with your CA)" choice (never a rate). */
const CUSTOM_RATE = 'custom' // i18n-technical: option value

export function StockStep({ draft, update, state }: OpeningsStepProps): React.JSX.Element {
  const t = useT()
  const listId = useId()
  const date = toPlainDate(state.booksBegin, t.lang)
  const listed = new Set(draft.items.map((r) => r.name.trim().toLowerCase()))
  const suggestions = state.pick.items.filter((p) => !listed.has(p.name.toLowerCase()))
  const known = (name: string): boolean => state.pick.items.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())
  // WP 10.8: while the business charges GST, a new product's rate is asked here — a product made
  // without one would go on its first bill with no GST at all (the slabs in force on the day).
  const askGst = state.chargesGst === true
  // to-do §4: the slabs in force on the WORKING date (what the next bill charges); the books-begin
  // date's other slabs only behind "Custom rate (check with your CA)".
  const workingDate = useSession((s) => s.workingDate)
  const { offered, earlier } = askGst ? openingGstChoices(workingDate, state.booksBegin) : { offered: [], earlier: [] }
  /** Rows whose custom-rate box is open → the text typed there. */
  const [custom, setCustom] = useState<Record<string, string>>({})
  const customShown = (r: ItemDraft): boolean => custom[r.key] != null || (r.gstRate != null && !offered.includes(r.gstRate))
  const setCustomRate = (i: number, r: ItemDraft, text: string): void => {
    setCustom((c) => ({ ...c, [r.key]: text }))
    setItem(i, { gstRate: readCustomGstRate(text) })
  }
  const defaultUnit = state.pick.units.find((u) => u.symbol === 'Pcs')?.id ?? state.pick.units[0]?.id ?? null
  const setItem = (i: number, patch: Partial<ItemDraft>): void =>
    update((d) => ({
      ...d,
      items: d.items.map((r, j) => (j === i ? { ...r, ...patch } : r))
    }))
  const valueOf = (r: ItemDraft): number => {
    const q = parseQtyText(r.qty)
    if (q == null || r.rate == null || r.rate < 0) return 0
    return r.base && q === r.base.qtyMilli && r.rate === state.items.find((i) => i.itemId === r.itemId)?.ratePaise ? r.base.value : stockLineValue(q, r.rate)
  }
  const total = draft.items.reduce((s, r) => s + valueOf(r), 0)
  return (
    <div data-testid="openings-step-stock">
      <Question title={t('simple.openings.stock.title')} hint={t('simple.openings.stock.hint', { date })} />
      <datalist id={listId}>
        {suggestions.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>
      <div className="flex flex-col gap-3">
        {draft.items.map((r, i) => (
          <div
            key={r.key}
            className={`grid grid-cols-1 gap-2 rounded-md border border-line p-3 md:items-start ${askGst ? 'md:grid-cols-[1fr_7rem_7rem_6rem_8rem_8rem_7rem_auto]' : 'md:grid-cols-[1fr_8rem_7rem_9rem_9rem_7rem_auto]'}`}
            data-testid={`openings-item-${i}`}
          >
            {r.itemId != null ? (
              <p className="pt-6 text-body font-semibold text-ink md:col-span-2">{r.name}</p>
            ) : (
              <>
                <OField label={t('simple.openings.stock.product')} name={`items.${i}.name`}>
                  <TextInput data-testid={`openings-item-${i}-name`} list={listId} value={r.name} onChange={(e) => setItem(i, { name: e.target.value })} />
                </OField>
                {known(r.name) ? (
                  <span />
                ) : (
                  <OField label={t('simple.openings.stock.unit')} name={`items.${i}.unit`}>
                    <Select
                      data-testid={`openings-item-${i}-unit`}
                      value={String(r.unitId ?? defaultUnit ?? '')}
                      onChange={(e) => setItem(i, { unitId: Number(e.target.value) })}
                    >
                      {state.pick.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.symbol}
                        </option>
                      ))}
                    </Select>
                  </OField>
                )}
              </>
            )}
            {askGst &&
              (r.itemId == null && !known(r.name) ? (
                <OField label={t('simple.openings.stock.gstRate')} name={`items.${i}.gstRate`}>
                  <Select
                    data-testid={`openings-item-${i}-gst`}
                    value={customShown(r) ? CUSTOM_RATE : r.gstRate == null ? '' : String(r.gstRate)}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === CUSTOM_RATE) {
                        setCustom((c) => ({ ...c, [r.key]: r.gstRate != null && !offered.includes(r.gstRate) ? String(r.gstRate) : '' }))
                        setItem(i, { gstRate: null })
                        return
                      }
                      setCustom(({ [r.key]: _gone, ...rest }) => rest)
                      setItem(i, { gstRate: v === '' ? null : Number(v) })
                    }}
                  >
                    <option value="">{t('simple.openings.stock.gstPick')}</option>
                    {offered.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate === 0 ? t('simple.newProduct.gstNil') : t('simple.sell.gstChip', { rate })}
                      </option>
                    ))}
                    <option value={CUSTOM_RATE}>{t('simple.newProduct.customRate')}</option>
                  </Select>
                </OField>
              ) : (
                <span />
              ))}
            <OField label={t('simple.openings.stock.qty')} name={`items.${i}.qty`}>
              <TextInput
                data-testid={`openings-item-${i}-qty`}
                inputMode="decimal"
                className="num text-right"
                value={r.qty}
                onChange={(e) => setItem(i, { qty: e.target.value })}
              />
            </OField>
            <OField label={t('simple.openings.stock.rate')} name={`items.${i}.rate`}>
              <AmountInput testId={`openings-item-${i}-rate`} paise={r.rate} onPaise={(p) => setItem(i, { rate: p })} />
            </OField>
            {/* Gate polish: optional — the first bill then fills the price, the Stock list shows it. */}
            <OField label={t('simple.openings.stock.sell')} name={`items.${i}.sell`}>
              <AmountInput testId={`openings-item-${i}-sell`} paise={r.sell ?? null} onPaise={(p) => setItem(i, { sell: p })} />
            </OField>
            <div>
              <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.openings.stock.value')}</span>
              <p className="num pt-1.5 text-right text-body text-ink" data-testid={`openings-item-${i}-value`}>
                {rupees(valueOf(r))}
              </p>
            </div>
            <div className="md:pt-6">
              <RemoveButton
                testId={`openings-item-${i}-remove`}
                onClick={() =>
                  update((d) => ({
                    ...d,
                    items: r.itemId != null ? d.items.map((x, j) => (j === i ? { ...x, qty: '', rate: null } : x)) : d.items.filter((_, j) => j !== i)
                  }))
                }
              />
            </div>
            {askGst && r.itemId == null && !known(r.name) && customShown(r) && (
              <div className="rounded-md border border-amber/60 bg-amberbar/10 px-3 py-2 md:col-span-full" data-testid={`openings-item-${i}-gst-custom`}>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={t('simple.newProduct.customRateLabel')} className="w-44">
                    <TextInput
                      data-testid={`openings-item-${i}-gst-custom-input`}
                      inputMode="decimal"
                      className="num"
                      placeholder={t('simple.newProduct.otherRate')}
                      value={custom[r.key] ?? (r.gstRate != null ? String(r.gstRate) : '')}
                      onChange={(e) => setCustomRate(i, r, e.target.value)}
                    />
                  </Field>
                  {earlier.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      aria-pressed={r.gstRate === rate}
                      data-testid={`openings-item-${i}-gst-earlier-${rate}`}
                      onClick={() => setCustomRate(i, r, String(rate))}
                      className="rounded-md border border-line px-3 py-1.5 text-detail text-ink hover:border-amber/60"
                    >
                      {t('simple.sell.gstChip', { rate })}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-small text-ink">{t('simple.newProduct.customRateWarn')}</p>
              </div>
            )}
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            data-testid="openings-add-item"
            onClick={() =>
              update((d) => ({
                ...d,
                items: [
                  ...d.items,
                  {
                    key: newKey(),
                    itemId: null,
                    name: '',
                    unitId: defaultUnit,
                    qty: '',
                    rate: null,
                    base: null,
                    gstRate: null,
                    sell: null,
                    sellBase: null
                  }
                ]
              }))
            }
          >
            {t('simple.openings.stock.add')}
          </Button>
        </div>
      </div>
      <Total testId="openings-stock-total">{t('simple.openings.stock.total', { amount: rupees(total) })}</Total>
    </div>
  )
}

// ---------- other balances (behind "More…" on the confirm step) ----------

const KIND_LABEL: Record<OpeningOtherKind, MessageKey> = {
  loan_taken: 'simple.openings.other.kind.loanTaken',
  loan_given: 'simple.openings.other.kind.loanGiven',
  fixed_asset: 'simple.openings.other.kind.fixedAsset'
}

export function OtherBalances({ draft, update, state }: OpeningsStepProps): React.JSX.Element {
  const t = useT()
  const say = (k: MessageKey): string => t(k) // i18n-technical: keys from KIND_LABEL
  const date = toPlainDate(state.booksBegin, t.lang)
  const setRow = (i: number, patch: Partial<OtherDraft>): void =>
    update((d) => ({
      ...d,
      others: d.others.map((r, j) => (j === i ? { ...r, ...patch } : r))
    }))
  return (
    <div className="rounded-lg border border-line p-4" data-testid="openings-other">
      <Question title={t('simple.openings.other.title')} hint={t('simple.openings.other.hint')} />
      <div className="flex flex-col gap-3">
        {draft.others.map((r, i) => (
          <div key={r.key} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_10rem_auto] md:items-start" data-testid={`openings-other-${i}`}>
            {r.ledgerId != null ? (
              <p className="pt-6 text-body font-semibold text-ink md:col-span-2">
                {r.name} <span className="font-normal text-muted">· {say(KIND_LABEL[r.kind])}</span>
              </p>
            ) : (
              <>
                <OField label={t('simple.openings.other.kind')} name={`others.${i}.kind`}>
                  <Select data-testid={`openings-other-${i}-kind`} value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as OpeningOtherKind })}>
                    {OPENING_OTHER_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {say(KIND_LABEL[k])}
                      </option>
                    ))}
                  </Select>
                </OField>
                <OField label={t('simple.openings.other.name')} name={`others.${i}.name`}>
                  <TextInput
                    data-testid={`openings-other-${i}-name`}
                    value={r.name}
                    placeholder={t('simple.openings.other.namePlaceholder')}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                  />
                </OField>
              </>
            )}
            <OField label={t('simple.openings.other.amount', { date })} name={`others.${i}.amount`}>
              <AmountInput testId={`openings-other-${i}-amount`} paise={r.amount} onPaise={(p) => setRow(i, { amount: p })} />
            </OField>
            <div className="md:pt-6">
              <RemoveButton
                testId={`openings-other-${i}-remove`}
                onClick={() =>
                  update((d) => ({
                    ...d,
                    others: r.ledgerId != null ? d.others.map((x, j) => (j === i ? { ...x, amount: null } : x)) : d.others.filter((_, j) => j !== i)
                  }))
                }
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            data-testid="openings-add-other"
            onClick={() =>
              update((d) => ({
                ...d,
                others: [
                  ...d.others,
                  {
                    key: newKey(),
                    kind: LOAN_TAKEN,
                    ledgerId: null,
                    name: '',
                    amount: null,
                    base: null
                  }
                ]
              }))
            }
          >
            {t('simple.openings.other.add')}
          </Button>
        </div>
      </div>
    </div>
  )
}
