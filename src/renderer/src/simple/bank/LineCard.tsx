import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { categoriesFor } from '@shared/simple/accountKinds'
import { CATEGORIES, type CategoryKey } from '@shared/simple/categories'
import type { AccountContext } from '@shared/simple/accountKinds'
import { choiceComplete, choiceLabelKey, choicesFor, intentForChoice, type BankChoice, type BankChoiceKind, type BankLineView, type BankSetup, type BankSuggestion } from '@shared/simple/bank'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSession } from '../../state/stores'
import { Button, Field, FieldError, Select } from '../../components/ui'
import { TypeAhead } from '../../components/pickers'
import { CategoryPicker } from '../CategoryPicker'

const EXPENSE_CONTEXT: AccountContext = { field: 'line', voucherKind: 'payment', drCr: 'dr' } // i18n-technical
const INCOME_CONTEXT: AccountContext = { field: 'account', side: 'sales' } // i18n-technical
const PREVIEW_ID = 'bank-preview-' // i18n-technical: clientId prefix for the rehearsal
const EXPENSE_KEYS = categoriesFor('expense')
const INCOME_KEYS = categoriesFor('income')

export interface LineProblem {
  /** Messages for the line's own fields ('party' …). */
  fields: Record<string, string>
  general: string | null
  details: string
}

/** The empty answer for a kind: what it needs is picked next (0 = not picked / added on save). */
export function blankChoice(kind: BankChoiceKind, side: BankLineView['side'], setup: BankSetup): BankChoice {
  switch (kind) {
    case 'existing':
    case 'skip':
      return { kind }
    case 'customer':
    case 'supplier':
      return { kind, partyId: 0 }
    case 'owner':
      return { kind, accountId: (side === 'deposit' ? setup.ids.ownerMoney : setup.ids.drawings) ?? 0 }
    case 'charges':
      return { kind, accountId: (side === 'deposit' ? setup.ids.interest : setup.ids.bankCharges) ?? 0 }
    default:
      return { kind, accountId: 0 }
  }
}

/** The category account an owner / bank shortcut uses on a side (added on save when missing). */
export function categoryFor(kind: 'owner' | 'charges', side: BankLineView['side']): CategoryKey {
  if (kind === 'owner') return side === 'deposit' ? 'owner_capital' : 'owner_drawings' // i18n-technical
  return side === 'deposit' ? 'interest_received' : 'bank_charges' // i18n-technical
}

/** Save is possible: the answer is complete, or an owner / bank shortcut whose account is added on save. */
export function canSave(c: BankChoice | null): boolean {
  if (c?.kind === 'owner' || c?.kind === 'charges') return true
  return choiceComplete(c)
}

const sameChoice = (a: BankChoice | null, b: BankChoice | null): boolean => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

/**
 * WP 9.6 — one open statement line and its "What is this?": the plain choices for its side, the
 * suggestion pre-selected with its "because …", what the choice needs (the customer, the
 * category, the other account), what will be recorded (simple:preview's sentences, for a
 * customer / supplier — which bills it settles) and Save. Problems sit on the line (the picker's
 * own under it).
 */
export function LineCard({
  line,
  setup,
  bankLedgerId,
  suggestion,
  choice,
  onChoice,
  onSave,
  onCreate,
  busy,
  problem
}: {
  line: BankLineView
  setup: BankSetup
  bankLedgerId: number
  suggestion: BankSuggestion | null
  choice: BankChoice | null
  onChoice: (c: BankChoice) => void
  onSave: () => void
  onCreate: (what: 'customer' | 'supplier' | 'account', name: string) => void
  busy: boolean
  problem: LineProblem | null
}): React.JSX.Element {
  const t = useT()
  const workingDate = useSession((s) => s.workingDate)
  const label = (k: MessageKey, vars?: Record<string, string | number>): string => t(k, vars) // i18n-technical: keys from shared/simple/bank.ts
  const deposit = line.side === 'deposit'
  const kinds = choicesFor(line.side, !!line.match)
  const accounts = setup.accounts
  const customers = useMemo(() => accounts.filter((a) => a.cls === 'debtor').map((a) => ({ id: a.id, label: a.name })), [accounts])
  const suppliers = useMemo(() => accounts.filter((a) => a.cls === 'creditor').map((a) => ({ id: a.id, label: a.name })), [accounts])
  const others = accounts.filter((a) => (a.cls === 'cash' || a.cls === 'bank') && a.id !== bankLedgerId)
  const suggested = suggestion && sameChoice(choice, suggestion.choice)

  // What will be recorded — for a customer / supplier the sentences say which bills it settles.
  const [sentences, setSentences] = useState<string[]>([])
  const wantPreview = !!choice && choiceComplete(choice) && (choice.kind === 'customer' || choice.kind === 'supplier')
  const key = wantPreview ? JSON.stringify(choice) : ''
  const seq = useRef(0)
  useEffect(() => {
    setSentences([])
    if (!wantPreview || !choice) return
    const intent = intentForChoice(line, choice, bankLedgerId, `${PREVIEW_ID}${line.id}`)
    if (!intent) return
    const n = ++seq.current
    const id = window.setTimeout(() => {
      api.simple.preview(intent, workingDate).then(
        (p) => n === seq.current && setSentences(p.sentences),
        () => undefined
      )
    }, 300)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workingDate])

  const accountName = (id: number): string | null => accounts.find((a) => a.id === id)?.name ?? null
  const addName = (kind: 'owner' | 'charges'): string => CATEGORIES[categoryFor(kind, line.side)].name

  return (
    <article
      className="rounded-lg border border-line bg-panel p-panel shadow-elev-1"
      data-testid="bank-line"
      data-line-id={line.id}
      data-side={line.side}
      data-choice={choice?.kind ?? ''}
      aria-label={line.description}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-small text-muted">
            {toPlainDate(line.date)} · {deposit ? t('simple.bank.in') : t('simple.bank.out')}
          </p>
          <p className="truncate text-body font-medium text-ink" title={line.description} data-testid="bank-line-description">
            {line.description}
          </p>
        </div>
        <span className={`num text-lead font-semibold ${deposit ? 'text-success' : 'text-ink'}`} data-testid="bank-line-amount" data-paise={line.amount}>
          {formatPaise(line.amount, { symbol: true })}
        </span>
      </div>

      <h3 className="mt-3 mb-2 text-detail font-semibold text-ink">{t('simple.bank.whatIsThis')}</h3>
      <div role="radiogroup" aria-label={t('simple.bank.whatIsThis')} className="flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={choice?.kind === k}
            data-testid={`bank-choice-${k}`}
            onClick={() => onChoice(suggestion && suggestion.choice.kind === k ? suggestion.choice : blankChoice(k, line.side, setup))}
            className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
              choice?.kind === k ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
            }`}
          >
            {label(choiceLabelKey(k, line.side))}
          </button>
        ))}
      </div>
      {suggested && suggestion && (
        <p className="mt-2 text-small text-muted" data-testid="bank-line-because" data-source={suggestion.source}>
          {t('simple.bank.suggested', { reason: label(suggestion.because.key, suggestion.because.vars) })}
        </p>
      )}

      <div className="mt-3 max-w-md">
        {choice?.kind === 'existing' && line.match && (
          <p className="text-detail text-ink" data-testid="bank-line-existing">
            {t('simple.bank.existingIs', { name: line.match.name, date: toPlainDate(line.match.date) })}
          </p>
        )}
        {(choice?.kind === 'customer' || choice?.kind === 'supplier') && (
          <Field label={choice.kind === 'customer' ? t('simple.bank.pickCustomer') : t('simple.bank.pickSupplier')} name="party" error={problem?.fields.party ?? null}>
            <TypeAhead
              options={choice.kind === 'customer' ? customers : suppliers}
              value={choice.partyId || null}
              onPick={(id) => onChoice({ kind: choice.kind, partyId: id ?? 0 })}
              placeholder={choice.kind === 'customer' ? t('simple.bank.pickCustomerPlaceholder') : t('simple.bank.pickSupplierPlaceholder')}
              onCreate={(name) => onCreate(choice.kind === 'customer' ? 'customer' : 'supplier', name)} // i18n-technical
              testId={`picker-bank-party-${line.id}`}
            />
          </Field>
        )}
        {(choice?.kind === 'expense' || choice?.kind === 'income') && (
          <Field label={choice.kind === 'expense' ? t('simple.bank.pickExpense') : t('simple.bank.pickIncome')} name="party" error={problem?.fields.party ?? null}>
            <CategoryPicker
              value={choice.accountId || null}
              onPick={(id) => onChoice({ kind: choice.kind, accountId: id ?? 0 })}
              keys={choice.kind === 'expense' ? EXPENSE_KEYS : INCOME_KEYS}
              context={choice.kind === 'expense' ? EXPENSE_CONTEXT : INCOME_CONTEXT}
              side={choice.kind}
              testId={`picker-bank-category-${line.id}`}
            />
          </Field>
        )}
        {choice?.kind === 'transfer' &&
          (others.length ? (
            <Field label={t('simple.bank.pickAccount')} name="to" error={problem?.fields.to ?? problem?.fields.from ?? null}>
              <Select value={choice.accountId || ''} onChange={(e) => onChoice({ kind: 'transfer', accountId: Number(e.target.value) })} data-testid={`select-bank-transfer-${line.id}`} // i18n-technical
              >
                <option value="">{t('simple.bank.pickAccount')}</option>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-small text-ink">{t('simple.bank.noOtherAccount')}</p>
              <Button data-testid={`btn-bank-add-account-${line.id}`} onClick={() => onCreate('account', '')} // i18n-technical
              >
                {t('simple.bank.addAccount')}
              </Button>
            </div>
          ))}
        {(choice?.kind === 'owner' || choice?.kind === 'charges') && (
          <p className="text-small text-muted" data-testid="bank-line-goes-to">
            {choice.accountId ? accountName(choice.accountId) : t('simple.bank.willAdd', { name: addName(choice.kind) })}
          </p>
        )}
        {choice?.kind === 'skip' && <p className="text-small text-muted">{t('simple.bank.skipped')}</p>}
      </div>

      {sentences.length > 0 && (
        <p className="mt-2 text-detail text-ink" data-testid="bank-line-preview">
          {sentences.join(' ')}
        </p>
      )}
      {problem?.general && (
        <div role="alert" className="mt-2 rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="bank-line-error">
          <p>{problem.general}</p>
          <details className="mt-1 text-muted">
            <summary className="cursor-pointer">{t('common.details')}</summary>
            <p className="mt-1 font-mono text-small">{problem.details}</p>
          </details>
        </div>
      )}
      <FieldError name="choice" error={problem?.fields.choice ?? null} />

      {choice && choice.kind !== 'skip' && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" disabled={busy || !canSave(choice)} data-testid="btn-bank-line-save" onClick={onSave}>
            {busy ? t('simple.bank.saving') : t('simple.bank.saveLine')}
          </Button>
        </div>
      )}
    </article>
  )
}
