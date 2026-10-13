import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { CATEGORIES, type CategoryKey } from '@shared/simple/categories'
import type { AccountContext } from '@shared/simple/accountKinds'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useToasts } from '../state/stores'
import { LedgerPicker, useGroups, useLedgers } from '../components/pickers'
import { inputCls, useFormErrors } from '../components/ui'
import { PlainIcon } from './icons'
import { NewAccountDialog } from './NewAccountDialog'

const PARTY = 'party' as const // i18n-technical: search mode
const ALL = 'all' as const // i18n-technical: search mode
const SUPPLIER_CONTEXT: AccountContext = { field: 'party', side: 'purchase' } // i18n-technical

/** A customer / supplier account (under Sundry Debtors / Creditors, at any depth). */
function isParty(l: Ledger, groups: Map<number, Group>): boolean {
  let g = groups.get(l.groupId)
  while (g) {
    if (g.name === 'Sundry Creditors' || g.name === 'Sundry Debtors') return true // i18n-technical: group names
    g = g.parentId ? groups.get(g.parentId) : undefined
  }
  return false
}

/** The ledger a category stands for: the one carrying its key, else one with its seeded name. */
function ledgerFor(key: CategoryKey, ledgers: readonly Ledger[]): Ledger | undefined {
  const name = CATEGORIES[key].name.toLowerCase()
  return ledgers.find((l) => l.simpleCategory === key) ?? ledgers.find((l) => l.name.toLowerCase() === name)
}

/**
 * WP 8.4 — the category picker for expense / income lines in simple mode (plan §4.1): the
 * categories as tiles with icons, the company's own (seeded / used) ones first; picking one that
 * has no account yet creates it under the category's group with its `simple_category` key (an
 * explicit click — nothing is created by typing). "Search all accounts" opens the normal picker
 * (Enter selects, never creates) and "Something else…" the plain new-account dialog.
 */
export function CategoryPicker({
  value,
  onPick,
  keys,
  context,
  side = 'expense',
  filter,
  testId = 'picker-category',
  autoFocus,
  partyTile = false
}: {
  value: number | null
  onPick: (id: number | null) => void
  /** The categories offered (accountKinds.ts `categoriesFor`, or a narrower list). */
  keys: readonly CategoryKey[]
  /** Where "Something else…" starts (expense line → Expense …). */
  context: AccountContext
  /** What the line is: an expense (money out), income, a bill's sale or a bill's purchase — sets
   *  the plain question the empty picker asks. */
  side?: 'expense' | 'income' | 'sale' | 'purchase'
  /** The search-all picker's filter (e.g. only Sales Accounts on a sales bill). */
  filter?: (l: Ledger, groups: Map<number, Group>) => boolean
  testId?: string
  autoFocus?: boolean
  /** Money out: the first tile is "Pay a supplier" (a party search). */
  partyTile?: boolean
}): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const ledgers = useLedgers()
  const groups = useGroups()
  const [open, setOpen] = useState(false)
  // null = the tiles; 'all' = every account; 'party' = customers / suppliers ("Pay a supplier").
  const [searchMode, setSearchMode] = useState<null | 'all' | 'party'>(null)
  const searchAll = searchMode != null
  const setSearchAll = (on: boolean): void => setSearchMode(on ? ALL : null)
  const [newName, setNewName] = useState<string | null>(null)
  const errors = useFormErrors<'category'>({ category: value }, { simple: true, t })
  const wrapRef = useRef<HTMLDivElement>(null)
  const selected = value != null ? ledgers.find((l) => l.id === value) : undefined

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc) // i18n-technical
    return () => document.removeEventListener('mousedown', onDoc) // i18n-technical
  }, [])

  // The company's own categories (an account exists) first, then the rest, each in list order.
  const tiles = useMemo(() => {
    const withLedger = keys.map((k) => ({ key: k, ledger: ledgerFor(k, ledgers) }))
    return [...withLedger.filter((x) => x.ledger), ...withLedger.filter((x) => !x.ledger)]
  }, [keys, ledgers])

  const choose = async (key: CategoryKey, ledger: Ledger | undefined): Promise<void> => {
    if (ledger) {
      onPick(ledger.id)
      setOpen(false)
      return
    }
    const c = CATEGORIES[key]
    const group = groups.find((g) => g.name === c.group)
    if (!group) return
    try {
      const l = await api.ledgers.create({
        name: c.name,
        groupId: group.id,
        openingBalance: 0,
        gstin: null,
        stateCode: null,
        address: null,
        taxType: null,
        gstRate: null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: null,
        exportType: null,
        simpleCategory: key
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] }) // i18n-technical
      toast.push('success', t('simple.newAccount.created', { name: l.name }))
      onPick(l.id)
      setOpen(false)
    } catch (err) {
      const mapped = errors.apply(err)
      toast.push('error', mapped.general ?? mapped.fields.category ?? t('errors.duplicateName'))
    }
  }

  const label = selected?.name ?? ''
  // On a bill the field's label already asks the question ("What are you selling?").
  const placeholder =
    side === 'sale' || side === 'purchase'
      ? t('simple.category.choose')
      : side === 'income'
          ? t('simple.category.incomePlaceholder')
          : t('simple.category.placeholder')
  const icon = selected?.simpleCategory ? CATEGORIES[selected.simpleCategory].icon : null

  return (
    <div ref={wrapRef} className="relative">
      {searchAll ? (
        <div className="flex items-center gap-1.5">
          <LedgerPicker
            value={value}
            onPick={(id) => {
              onPick(id)
              if (id != null) setSearchAll(false)
            }}
            filter={searchMode === 'party' ? isParty : filter}
            autoFocus
            placeholder={searchMode === 'party' ? t('simple.category.searchSuppliers') : t('simple.category.searchAll')}
            onCreateRequest={(n) => setNewName(n)}
            className="flex-1"
            testId={`${testId}-search`}
          />
          <button type="button" className="shrink-0 text-caption text-muted hover:text-ink" onClick={() => setSearchAll(false)} data-testid={`${testId}-back`}>
            {t('simple.category.backToCategories')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          autoFocus={autoFocus}
          data-testid={testId}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`${inputCls} flex items-center gap-2 text-left`}
        >
          {icon && <PlainIcon id={icon} className="shrink-0 text-muted" />}
          <span className={label ? 'text-ink' : 'text-muted'}>
            {label || placeholder}
          </span>
        </button>
      )}
      {open && !searchAll && (
        <div
          role="listbox"
          aria-label={placeholder}
          className="absolute top-full right-0 z-30 mt-1 w-[24rem] max-w-[90vw] rounded-md border border-line bg-raised p-2 shadow-elev-2"
          data-testid={`${testId}-list`}
        >
          <div className="grid grid-cols-2 gap-1.5">
            {partyTile && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid={`${testId}-pay-supplier`}
                onClick={() => {
                  setOpen(false)
                  setSearchMode(PARTY)
                }}
                className="flex items-center gap-2 rounded-md border border-amber/50 bg-panel px-2 py-1.5 text-left text-detail text-ink transition-colors hover:border-amber focus-visible:outline-2 focus-visible:outline-amber/70"
              >
                <PlainIcon id="truck" className="shrink-0 text-muted" />
                <span className="truncate">{t('simple.category.paySupplier')}</span>
              </button>
            )}
            {tiles.map(({ key, ledger }) => (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={ledger != null && ledger.id === value}
                data-testid={`category-${key}`}
                onClick={() => void choose(key, ledger)}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-detail transition-colors focus-visible:outline-2 focus-visible:outline-amber/70 ${
                  ledger != null && ledger.id === value ? 'border-amber bg-amberbar/15 text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
                }`}
              >
                <PlainIcon id={CATEGORIES[key].icon} className="shrink-0 text-muted" />
                <span className="truncate">{ledger?.name ?? CATEGORIES[key].name}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              data-testid={`${testId}-search-all`}
              className="flex items-center gap-1.5 text-detail text-ink hover:text-amber"
              onClick={() => {
                setOpen(false)
                setSearchAll(true)
              }}
            >
              <PlainIcon id="search" className="text-muted" />
              {t('simple.category.searchAll')}
            </button>
            <button
              type="button"
              data-testid={`${testId}-new`}
              className="flex items-center gap-1.5 text-detail text-amber"
              onClick={() => {
                setOpen(false)
                setNewName('')
              }}
            >
              <PlainIcon id="plus" />
              {t('simple.category.new')}
            </button>
          </div>
        </div>
      )}
      {newName != null && (
        <NewAccountDialog
          name={newName}
          context={searchMode === PARTY ? SUPPLIER_CONTEXT : context}
          onClose={() => setNewName(null)}
          onCreated={(l) => {
            onPick(l.id)
            setNewName(null)
            setSearchAll(false)
          }}
        />
      )}
    </div>
  )
}
