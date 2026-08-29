import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { AmountInput, Button, Panel, TextInput } from '../components/ui'
import { formatPaise } from '@shared/money'
import {
  OPENING_CATEGORIES, openingAdvice, openingTotals, signedOpening, type OpeningCategory, type OpeningRow
} from '@shared/openingBalances'

/**
 * Opening balances for a business that has never used an accounting package (roadmap O #289).
 *
 * The Tally path is a file. This is the other path, and it is the commoner one: a shop that has
 * been run out of a notebook, moving on to software for GST. Asked for "opening balances, debit
 * positive", they close the app. Asked what is in the bank, who owes them, and who they owe, they
 * can answer every line.
 *
 * Nothing here posts a voucher. Opening balances are a property of a ledger, and each line either
 * creates that ledger or sets its opening — which is also why the screen can be left half-done and
 * come back to.
 */
export function OpeningBalances(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data: groups } = useQuery({ queryKey: ['groups'], queryFn: api.groups.list })
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const [rows, setRows] = useState<Record<string, OpeningRow[]>>({})
  const [busy, setBusy] = useState(false)

  const all = OPENING_CATEGORIES.flatMap((c) => rows[c.id] ?? [])
  const totals = openingTotals(all)

  const setRow = (categoryId: OpeningCategory['id'], index: number, patch: Partial<OpeningRow>): void => {
    setRows((current) => {
      const list = [...(current[categoryId] ?? [])]
      list[index] = { name: '', amount: 0, categoryId, ...list[index], ...patch }
      return { ...current, [categoryId]: list }
    })
  }

  const addRow = (categoryId: OpeningCategory['id']): void =>
    setRows((current) => ({ ...current, [categoryId]: [...(current[categoryId] ?? []), { name: '', amount: 0, categoryId }] }))

  const save = async (): Promise<void> => {
    if (!groups) return
    setBusy(true)
    try {
      let created = 0
      let updated = 0
      for (const category of OPENING_CATEGORIES) {
        const group = groups.find((g) => g.name === category.group)
        if (!group) continue
        for (const row of rows[category.id] ?? []) {
          const name = row.name.trim()
          if (!name || row.amount <= 0) continue
          const opening = signedOpening(category, row.amount)
          const existing = (ledgers ?? []).find((l) => l.name.toLowerCase() === name.toLowerCase())
          if (existing) {
            // Only the opening is touched. Everything else about a ledger somebody already set
            // up — GSTIN, credit terms, bank details — is left exactly as it is.
            await api.ledgers.update(existing.id, { ...existing, openingBalance: opening })
            updated++
          } else {
            await api.ledgers.create({ name, groupId: group.id, openingBalance: opening })
            created++
          }
        }
      }
      await qc.invalidateQueries()
      setRows({})
      toast.push('success', `${created} ledger${created === 1 ? '' : 's'} created, ${updated} updated`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="opening-balances">
      <Panel className="p-5">
        <p className="max-w-prose text-body-sm text-muted">
          Six questions about the day you start. Answer what you know and come back for the rest — nothing is
          posted, each line simply sets that ledger&rsquo;s opening balance. A line whose name already exists
          updates it; anything else is created for you under the right group.
        </p>
      </Panel>

      {OPENING_CATEGORIES.map((category) => {
        const list = rows[category.id] ?? []
        return (
          <Panel className="mt-3 p-4" key={category.id} data-testid={`opening-category-${category.id}`}>
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-detail font-medium">{category.question}</p>
              <span className="text-caption tracking-[0.06em] text-muted uppercase">
                {category.side === 'dr' ? 'the business owns' : 'the business owes'}
              </span>
            </div>
            <p className="mt-1 max-w-prose text-body-sm text-muted">{category.hint}</p>
            <div className="mt-3 flex flex-col gap-2">
              {list.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TextInput
                    data-testid={`input-opening-name-${category.id}-${i}`}
                    value={row.name}
                    placeholder={category.id === 'cash' ? 'HDFC Current A/c' : 'Name'}
                    onChange={(e) => setRow(category.id, i, { name: e.target.value })}
                    className="flex-1"
                  />
                  <AmountInput
                    testId={`input-opening-amount-${category.id}-${i}`}
                    paise={row.amount}
                    onPaise={(paise) => setRow(category.id, i, { amount: paise ?? 0 })}
                    className="w-40"
                  />
                </div>
              ))}
              <div>
                <Button variant="ghost" data-testid={`btn-opening-add-${category.id}`} onClick={() => addRow(category.id)}>
                  + Add a line
                </Button>
              </div>
            </div>
          </Panel>
        )
      })}

      <Panel className="mt-4 p-4" data-testid="opening-totals">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex gap-6">
            <Figure label="Owns" value={totals.debit} />
            <Figure label="Owes" value={totals.credit} />
            <Figure
              label="Difference"
              value={Math.abs(totals.difference)}
              tone={totals.balanced ? 'good' : 'bad'}
              testId="opening-difference"
            />
          </div>
          <Button
            variant="primary"
            data-testid="btn-opening-save"
            disabled={busy || totals.debit + totals.credit === 0}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save these balances'}
          </Button>
        </div>
        <p className="mt-3 max-w-prose text-body-sm text-muted" data-testid="opening-advice">
          {openingAdvice(totals, formatPaise)}
        </p>
        {/* Saving an unbalanced set is allowed on purpose: the alternative is refusing to keep
            what somebody has just typed, which loses their work over a rule they can satisfy
            tomorrow with one more figure. The trial balance will show the gap until they do. */}
      </Panel>
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
  testId
}: {
  label: string
  value: number
  tone?: 'good' | 'bad'
  testId?: string
}): React.JSX.Element {
  return (
    <div>
      <p className="text-caption tracking-[0.08em] text-muted uppercase">{label}</p>
      <p
        data-testid={testId}
        className={`num text-lead font-semibold ${tone === 'good' ? 'text-dr' : tone === 'bad' ? 'text-cr' : ''}`}
      >
        {formatPaise(value)}
      </p>
    </div>
  )
}
