import { createContext, useContext, useId, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { AmountInput, Button, DateInput, Field, Select, TextInput } from '../components/ui'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import type { MessageKey } from '@shared/i18n'
import {
  OPENING_OTHER_KINDS,
  parseQtyText,
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

export function MoneyStep({ draft, update, state }: OpeningsStepProps): React.JSX.Element {
  const t = useT()
  const date = toPlainDate(state.booksBegin)
  const setBank = (i: number, patch: Partial<MoneyRowDraft>): void =>
    update((d) => ({
      ...d,
      banks: d.banks.map((b, j) => (j === i ? { ...b, ...patch } : b))
    }))
  const total = (draft.cash.amount ?? 0) + draft.banks.reduce((s, b) => s + (b.amount ?? 0), 0)
  return (
    <div data-testid="openings-step-money">
      <Question title={t('simple.openings.money.title')} hint={t('simple.openings.money.hint', { date })} />
      <div className="flex flex-col gap-3">
        <OField label={t('simple.openings.money.cash')} name="cash.amount">
          <AmountInput testId="openings-cash" paise={draft.cash.amount} onPaise={(p) => update((d) => ({ ...d, cash: { ...d.cash, amount: p } }))} autoFocus />
        </OField>
        {draft.banks.map((b, i) =>
          b.ledgerId != null ? (
            <OField key={b.key} label={b.name} hint={t('simple.openings.money.bankBalance', { date })} name={`banks.${i}.amount`}>
              <AmountInput testId={`openings-bank-${i}-amount`} paise={b.amount} onPaise={(p) => setBank(i, { amount: p })} />
            </OField>
          ) : (
            <div key={b.key} className="grid grid-cols-1 gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_12rem_auto] md:items-start">
              <OField label={t('simple.openings.money.bankName')} name={`banks.${i}.name`}>
                <TextInput
                  data-testid={`openings-bank-${i}-name`}
                  value={b.name}
                  placeholder={t('simple.openings.money.bankNamePlaceholder')}
                  onChange={(e) => setBank(i, { name: e.target.value })}
                />
              </OField>
              <OField label={t('simple.openings.money.bankBalance', { date })} name={`banks.${i}.amount`}>
                <AmountInput testId={`openings-bank-${i}-amount`} paise={b.amount} onPaise={(p) => setBank(i, { amount: p })} />
              </OField>
              <div className="md:pt-6">
                <RemoveButton
                  testId={`openings-bank-${i}-remove`}
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      banks: d.banks.filter((_, j) => j !== i)
                    }))
                  }
                />
              </div>
            </div>
          )
        )}
        <div>
          <Button
            type="button"
            variant="ghost"
            data-testid="openings-add-bank"
            onClick={() =>
              update((d) => ({
                ...d,
                banks: [
                  ...d.banks,
                  {
                    key: newKey(),
                    ledgerId: null,
                    name: '',
                    amount: null,
                    base: null
                  }
                ]
              }))
            }
          >
            {t('simple.openings.money.addBank')}
          </Button>
        </div>
      </div>
      <Total testId="openings-money-total">{t('simple.openings.money.total', { amount: rupees(total) })}</Total>
    </div>
  )
}

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
  const date = toPlainDate(state.booksBegin)
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
  const total = rows.reduce((s, r) => s + r.bills.reduce((x, b) => x + (b.amount ?? 0), 0), 0)
  const prefix = side === 'customers' ? 'customer' : 'supplier' // i18n-technical: test ids
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
            {r.bills.map((b, k) => (
              <div key={b.key} className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[1fr_11rem_10rem_4rem] md:items-start">
                <OField label={t('simple.openings.bill.number')} name={`${side}.${i}.bills.${k}.ref`}>
                  <TextInput data-testid={`openings-${prefix}-${i}-bill-${k}-ref`} value={b.ref} onChange={(e) => setBill(i, k, { ref: e.target.value })} />
                </OField>
                <OField label={t('simple.openings.bill.date')} name={`${side}.${i}.bills.${k}.date`}>
                  <DateInput
                    testId={`openings-${prefix}-${i}-bill-${k}-date`}
                    value={b.date}
                    context={state.booksBegin}
                    allowEmpty
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
              className="mt-2"
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
      <Total testId={`openings-${side}-total`}>{say(text.total, { amount: rupees(total) })}</Total>
    </div>
  )
}

// ---------- stock ----------

export function StockStep({ draft, update, state }: OpeningsStepProps): React.JSX.Element {
  const t = useT()
  const listId = useId()
  const date = toPlainDate(state.booksBegin)
  const listed = new Set(draft.items.map((r) => r.name.trim().toLowerCase()))
  const suggestions = state.pick.items.filter((p) => !listed.has(p.name.toLowerCase()))
  const known = (name: string): boolean => state.pick.items.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())
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
            className="grid grid-cols-1 gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_8rem_7rem_9rem_7rem_auto] md:items-start"
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
                    base: null
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
  const date = toPlainDate(state.booksBegin)
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
