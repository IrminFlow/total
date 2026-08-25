import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import {
  AmountInput,
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  SkeletonRows,
  TextInput
} from '../../components/ui'
import { useStockItems } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { toDisplayDate, todayISO } from '@shared/dates'
import { varianceBp } from '@shared/standardCost'

/**
 * Standard costing and the variance against actual (roadmap E #118).
 *
 * Two halves on one tab because they are useless apart: the standards are the yardstick and the
 * variance is what the yardstick is for, and a screen that shows one without the other sends the
 * user hunting for the other.
 *
 * The variance is split into price and usage on screen because that is the whole point — "we are
 * ₹1,40,000 over" is not a number anybody can act on, and "₹1,20,000 of it is what we paid and
 * ₹20,000 is what we used" is two conversations with two different people.
 */
export function StandardCostsTab(): React.JSX.Element {
  const { from, to } = useSession()
  const [basis, setBasis] = useState<'purchase' | 'consumption'>('purchase')
  const [editing, setEditing] = useState(false)

  const { data: variance, isLoading } = useQuery({
    queryKey: ['variance', from, to, basis],
    queryFn: () => api.standardCosts.variance({ from, to, basis, stockItemId: null })
  })
  const { data: standards } = useQuery({ queryKey: ['standardCosts'], queryFn: () => api.standardCosts.list(null) })

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Select
          data-testid="select-variance-basis"
          aria-label="What to score"
          value={basis}
          onChange={(e) => setBasis(e.target.value as 'purchase' | 'consumption')}
        >
          <option value="purchase">What was bought</option>
          <option value="consumption">What was consumed</option>
        </Select>
        <Button variant="primary" data-testid="btn-standard-cost-new" onClick={() => setEditing(true)}>
          Set a standard
        </Button>
      </div>

      <Panel className="mb-3">
        <h3 className="mb-2 text-body font-medium">
          Variance — {toDisplayDate(from)} to {toDisplayDate(to)}
        </h3>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : !variance || variance.lines.length === 0 ? (
          <EmptyState
            title="Nothing to compare yet"
            hint="Set a standard cost for an item, then this shows what it actually cost against it"
          />
        ) : (
          <table className="ledger-table" data-testid="rows-variance">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-36">Standard</th>
                <th scope="col" className="r w-36">Actual</th>
                <th scope="col" className="r w-36">Price</th>
                <th scope="col" className="r w-36">Usage</th>
                <th scope="col" className="r w-36">Total</th>
                <th scope="col" className="r w-20">%</th>
              </tr>
            </thead>
            <tbody>
              {variance.lines.map((l) => {
                const bp = varianceBp(l)
                return (
                  <tr key={l.stockItemId}>
                    <td>{l.name}</td>
                    <td className="r">
                      <Money paise={l.standardCostPaise} />
                    </td>
                    <td className="r">
                      <Money paise={l.actualCostPaise} />
                    </td>
                    <td className="r">
                      <Money paise={l.priceVariancePaise} signed />
                    </td>
                    <td className="r">
                      <Money paise={l.usageVariancePaise} signed />
                    </td>
                    {/* Only the offending CELL is coloured, never the row: red means "this number
                        is wrong", and a whole red row makes every number on it look wrong. */}
                    <td className={`r ${l.verdict === 'adverse' ? 'text-cr' : ''}`}>
                      <Money paise={l.totalVariancePaise} signed />
                    </td>
                    <td className="r num text-muted">{bp === null ? '—' : `${(bp / 100).toFixed(1)}%`}</td>
                  </tr>
                )
              })}
              <tr className="total-row">
                <td>Total</td>
                <td className="r">
                  <Money paise={variance.standardCostPaise} />
                </td>
                <td className="r">
                  <Money paise={variance.actualCostPaise} />
                </td>
                <td className="r">
                  <Money paise={variance.priceVariancePaise} signed />
                </td>
                <td className="r">
                  <Money paise={variance.usageVariancePaise} signed />
                </td>
                <td className="r">
                  <Money paise={variance.totalVariancePaise} signed />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
        {/* Listed, never scored as zero: an item with no standard has not met one, and a blank in
            a variance report is a question where a zero would be a wrong answer. */}
        {variance && variance.withoutStandard.length > 0 && (
          <p className="mt-2 px-1 text-hint text-muted" data-testid="variance-no-standard">
            No standard set for {variance.withoutStandard.map((w) => w.name).join(', ')} — those movements are left out
            of the totals rather than scored as on standard.
          </p>
        )}
      </Panel>

      <StandardsPanel standards={standards ?? []} />
      {editing && <StandardCostModal onClose={() => setEditing(false)} />}
    </>
  )
}

function StandardsPanel({
  standards
}: {
  standards: { id: number; itemName: string; effectiveFrom: string; standardCost: number; note: string | null }[]
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const remove = async (id: number, name: string): Promise<void> => {
    if (!(await confirmDialog({ title: 'Remove this standard?', message: `${name}. Past reports that used it will fall back to the standard before it.`, confirmLabel: 'Remove' }))) return
    try {
      await api.standardCosts.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['standardCosts'] })
      await queryClient.invalidateQueries({ queryKey: ['variance'] })
      toast.push('success', 'Standard removed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Panel>
      <h3 className="mb-2 text-body font-medium">Standards</h3>
      {standards.length === 0 ? (
        <p className="px-1 text-hint text-muted">None set.</p>
      ) : (
        <table className="ledger-table" data-testid="rows-standard-costs">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="w-36">In force from</th>
              <th scope="col" className="r w-40">Standard cost</th>
              <th scope="col">Note</th>
              <th scope="col" className="w-24" />
            </tr>
          </thead>
          <tbody>
            {standards.map((s) => (
              <tr key={s.id}>
                <td>{s.itemName}</td>
                <td className="num">{toDisplayDate(s.effectiveFrom)}</td>
                <td className="r">
                  <Money paise={s.standardCost} />
                </td>
                <td className="text-muted">{s.note ?? '—'}</td>
                <td className="r whitespace-nowrap">
                  <Button
                    variant="ghost"
                    className="row-action"
                    data-testid={`btn-standard-cost-delete-${s.id}`}
                    onClick={() => void remove(s.id, s.itemName)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function StandardCostModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const items = useStockItems()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [stockItemId, setStockItemId] = useState<number | null>(items[0]?.id ?? null)
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO())
  const [standardCost, setStandardCost] = useState(0)
  const [note, setNote] = useState('')

  const save = async (): Promise<void> => {
    if (stockItemId == null) return
    try {
      await api.standardCosts.save({ stockItemId, effectiveFrom, standardCost, note: note.trim() || null })
      await queryClient.invalidateQueries({ queryKey: ['standardCosts'] })
      await queryClient.invalidateQueries({ queryKey: ['variance'] })
      toast.push('success', 'Standard set')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Set a standard cost" onClose={onClose}>
      <div className="grid gap-3">
        <Field label="Item">
          <Select
            data-testid="select-standard-cost-item"
            value={stockItemId ?? ''}
            onChange={(e) => setStockItemId(e.target.value ? Number(e.target.value) : null)}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="In force from"
          hint="A standard is dated, not a setting: revising it in October leaves September's variance report saying what it said."
        >
          <DateInput testId="input-standard-cost-date" context={effectiveFrom} value={effectiveFrom} onChange={setEffectiveFrom} />
        </Field>
        <Field label="Standard cost per unit">
          <AmountInput testId="input-standard-cost-amount" paise={standardCost} onPaise={(v) => setStandardCost(v ?? 0)} />
        </Field>
        <Field label="Note">
          <TextInput
            data-testid="input-standard-cost-note"
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it changed"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-standard-cost-save" disabled={stockItemId == null} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}
