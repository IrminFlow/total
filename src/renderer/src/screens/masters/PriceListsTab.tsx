import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  RowAction,
  Select,
  TextInput
} from '../../components/ui'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { toDisplayDate, todayISO } from '@shared/dates'

/**
 * Price lists and their versions (roadmap E #128).
 *
 * The screen answers one question the app could not answer before: what did this list say on a
 * date that has passed. Every other control here exists to make that question have an answer worth
 * having — a version is a revision with a date, the "as on" box walks back through them, and a
 * whole version can be undone as one because a percentage applied with a digit wrong leaves forty
 * rows to fix by hand otherwise.
 */
export function PriceListsTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: levels } = useQuery({ queryKey: ['priceLevels'], queryFn: api.priceLevels.list })
  const [levelId, setLevelId] = useState<number | null>(null)
  const [asOn, setAsOn] = useState(todayISO())
  const [revising, setRevising] = useState(false)

  useEffect(() => {
    if (levelId == null && levels?.length) setLevelId(levels[0]!.id)
  }, [levels, levelId])

  const { data: versions } = useQuery({
    queryKey: ['priceVersions', levelId, asOn],
    queryFn: () => api.priceVersions.list(levelId!, asOn),
    enabled: levelId != null
  })
  const { data: rows } = useQuery({
    queryKey: ['priceListAsOn', levelId, asOn],
    queryFn: () => api.priceVersions.asOn(levelId!, asOn),
    enabled: levelId != null
  })

  const createLevel = async (): Promise<void> => {
    const name = await promptDialog({ title: 'New price list', message: 'A named list — Retail, Wholesale, Distributor.', placeholder: 'Wholesale' })
    if (!name?.trim()) return
    try {
      const created = await api.priceLevels.create({ name: name.trim() })
      await queryClient.invalidateQueries({ queryKey: ['priceLevels'] })
      setLevelId(created.id)
      toast.push('success', `${created.name} created`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const dropVersion = async (effectiveFrom: string, itemCount: number): Promise<void> => {
    const ok = await confirmDialog({
      title: `Undo the version of ${toDisplayDate(effectiveFrom)}?`,
      message: `${itemCount} rate${itemCount === 1 ? '' : 's'} go, and the list falls back to what it said before that date.`,
      confirmLabel: 'Undo the version'
    })
    if (!ok || levelId == null) return
    try {
      const result = await api.priceVersions.deleteVersion(levelId, effectiveFrom)
      await queryClient.invalidateQueries({ queryKey: ['priceVersions'] })
      await queryClient.invalidateQueries({ queryKey: ['priceListAsOn'] })
      toast.push('success', `${result.removed} rates removed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          data-testid="select-price-level"
          aria-label="Price list"
          value={levelId ?? ''}
          onChange={(e) => setLevelId(e.target.value ? Number(e.target.value) : null)}
        >
          {(levels ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <span className="text-detail text-muted">as on</span>
        <DateInput testId="input-price-as-on" context={asOn} value={asOn} onChange={setAsOn} className="w-36" />
        <div className="ml-auto flex gap-2">
          <Button data-testid="btn-price-level-new" onClick={() => void createLevel()}>
            New price list
          </Button>
          <Button
            variant="primary"
            data-testid="btn-price-revise"
            disabled={levelId == null}
            disabledTitle="Create a price list first"
            onClick={() => setRevising(true)}
          >
            Revise
          </Button>
        </div>
      </div>

      <Panel className="mb-3">
        <h3 className="mb-2 text-body font-medium">Versions</h3>
        {!versions?.length ? (
          <p className="px-1 text-hint text-muted">
            No rates yet. A version is simply every rate that came into force on one date.
          </p>
        ) : (
          <table className="ledger-table" data-testid="rows-price-versions">
            <thead>
              <tr>
                <th scope="col" className="w-36">In force from</th>
                <th scope="col" className="r w-32">Items changed</th>
                <th scope="col">State</th>
                <th scope="col" className="w-32" />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.effectiveFrom}>
                  <td className="num">{toDisplayDate(v.effectiveFrom)}</td>
                  <td className="r num">{v.itemCount}</td>
                  <td className="text-muted">{v.inForce ? 'In force' : 'Staged — starts later'}</td>
                  <td className="r whitespace-nowrap">
                    <RowAction
                      className="row-action"
                      data-testid={`btn-price-version-drop-${v.effectiveFrom}`}
                      onClick={() => void dropVersion(v.effectiveFrom, v.itemCount)}
                    >
                      Undo
                    </RowAction>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <h3 className="mb-2 text-body font-medium">The list as it stood on {toDisplayDate(asOn)}</h3>
        {!rows?.length ? (
          <EmptyState
            title="Nothing priced on that date"
            hint="Either the list is empty, or every version of it starts after this date"
          />
        ) : (
          <table className="ledger-table" data-testid="rows-price-list">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-40">Rate</th>
                <th scope="col" className="w-40">From version</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.stockItemId}>
                  <td>{r.itemName}</td>
                  <td className="r">
                    <Money paise={r.rate} /> <span className="text-caption text-muted">/ {r.unitSymbol}</span>
                  </td>
                  <td className="num text-muted">{toDisplayDate(r.effectiveFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {revising && levelId != null && <RevisionModal priceLevelId={levelId} onClose={() => setRevising(false)} />}
    </>
  )
}

function RevisionModal({ priceLevelId, onClose }: { priceLevelId: number; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO())
  const [percentText, setPercentText] = useState('5')
  const [rounding, setRounding] = useState<'paise' | 'rupee' | 'ten'>('rupee')

  // Basis points as an integer: a percentage carried as a float would reintroduce, one layer up,
  // exactly the imprecision that integer paise exist to avoid.
  const changeBp = /^-?\d+(\.\d{1,2})?$/.test(percentText.trim()) ? Math.round(Number(percentText) * 100) : null

  const { data: plan } = useQuery({
    queryKey: ['priceRevision', priceLevelId, effectiveFrom, changeBp, rounding],
    queryFn: () => api.priceVersions.previewRevision({ priceLevelId, effectiveFrom, changeBp: changeBp!, rounding, skip: [] }),
    enabled: changeBp !== null
  })

  const apply = async (): Promise<void> => {
    if (changeBp === null) return
    try {
      const result = await api.priceVersions.applyRevision({ priceLevelId, effectiveFrom, changeBp, rounding, skip: [] })
      await queryClient.invalidateQueries({ queryKey: ['priceVersions'] })
      await queryClient.invalidateQueries({ queryKey: ['priceListAsOn'] })
      toast.push('success', `${result.rows} rates in force from ${toDisplayDate(result.effectiveFrom)}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Revise the price list" onClose={onClose} wide>
      <div className="grid gap-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="In force from">
            <DateInput testId="input-revision-date" context={effectiveFrom} value={effectiveFrom} onChange={setEffectiveFrom} />
          </Field>
          <Field
            label="Change %"
            error={percentText.trim() && changeBp === null ? 'Up to two decimal places' : null}
          >
            <TextInput
              data-testid="input-revision-percent"
              aria-label="Change percent"
              className="num text-right"
              value={percentText}
              onChange={(e) => setPercentText(e.target.value)}
            />
          </Field>
          <Field label="Round to">
            <Select
              data-testid="select-revision-rounding"
              value={rounding}
              onChange={(e) => setRounding(e.target.value as 'paise' | 'rupee' | 'ten')}
            >
              <option value="paise">The paisa</option>
              <option value="rupee">The rupee</option>
              <option value="ten">Ten rupees</option>
            </Select>
          </Field>
        </div>

        {plan?.errors.length ? (
          <ul className="px-1 text-hint text-cr" data-testid="revision-errors">
            {plan.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : null}

        {plan && plan.rows.length > 0 && (
          <table className="ledger-table" data-testid="rows-revision-preview">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-40">Now</th>
                <th scope="col" className="r w-40">From {toDisplayDate(effectiveFrom)}</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.stockItemId}>
                  <td>{plan.names[r.stockItemId] ?? `Item ${r.stockItemId}`}</td>
                  <td className="r">
                    <Money paise={r.fromRate} />
                  </td>
                  <td className="r">
                    <Money paise={r.rate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-1 text-hint text-muted">
          Only the rates that actually move are recorded, so a version reads as a revision rather than a copy of the
          whole list. What the list said before this date keeps saying it.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-revision-apply"
            disabled={!plan || plan.rows.length === 0 || plan.errors.length > 0}
            disabledTitle="Nothing would change"
            onClick={() => void apply()}
          >
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  )
}
