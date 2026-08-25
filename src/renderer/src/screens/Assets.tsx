import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type FixedAsset } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  ExportGroup,
  Field,
  Modal,
  Money,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { confirmDialog } from '../lib/dialogs'
import { useStickyTab } from '../lib/useStickyTab'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { SCHEDULE_II_LIVES } from '@shared/depreciation'
import { csvReport, printReport } from '../lib/reportExport'

/**
 * What the business owns, and what it is worth now.
 *
 * "Fixed Assets" existed in this app as a ledger group and nothing else — the books knew four
 * lakh of machinery had been bought and nothing knew what the machinery was. Two schedules,
 * because the law asks for two different numbers and doing one and calling it depreciation is
 * the mistake this screen exists to prevent.
 */
type Tab = 'register' | 'schedule'

export function AssetsScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>('assets-tab', ['register', 'schedule'], 'register')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex gap-1" role="group" aria-label="Assets view">
            {(
              [
                ['register', 'Register'],
                ['schedule', 'Depreciation']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-testid={`tab-assets-${id}`}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-small ${
                  tab === id ? 'bg-accentbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        Fixed assets
      </SectionTitle>
      {tab === 'register' ? <RegisterTab /> : <ScheduleTab />}
    </div>
  )
}

// ---------- the register (#366) ----------

function RegisterTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<FixedAsset | 'new' | null>(null)
  const [disposing, setDisposing] = useState<FixedAsset | null>(null)
  const [showDisposed, setShowDisposed] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['assets', showDisposed],
    queryFn: () => api.assets.list(showDisposed)
  })
  const rows = data ?? []
  const table = useTableNav(rows, { rowId: (a) => a.id, onEnter: (a) => setEditing(a) })

  const remove = async (a: FixedAsset): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete asset',
      message: `Delete ${a.name} from the register? This does not touch the books.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.assets.remove(a.id)
      await queryClient.invalidateQueries({ queryKey: ['assets'] })
      toast.push('success', `${a.name} removed from the register`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const totals = rows.reduce(
    (t, a) => ({ cost: t.cost + a.cost, accumulated: t.accumulated + a.accumulated, book: t.book + a.bookValue }),
    { cost: 0, accumulated: 0, book: 0 }
  )

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="ghost" data-testid="btn-assets-show-disposed" onClick={() => setShowDisposed(!showDisposed)}>
            {showDisposed ? 'Hide disposed' : 'Include disposed'}
          </Button>
          <ExportGroup
            items={[
              {
                label: 'CSV',
                disabled: !rows.length,
                onClick: () => void csvReport(
                  ['Asset', 'Code', 'Block', 'Bought', 'In use from', 'Cost', 'Depreciated', 'Book value'],
                  rows.map((a) => [
                    a.name,
                    a.code ?? '',
                    a.blockName ?? '',
                    a.purchaseDate,
                    a.putToUseDate ?? '',
                    formatPaise(a.cost),
                    formatPaise(a.accumulated),
                    formatPaise(a.bookValue)
                  ]),
                  'fixed-assets',
                  toast
                )
              }
            ]}
          />
        </div>
        <Button variant="primary" data-testid="btn-asset-add" onClick={() => setEditing('new')}>
          Add asset
        </Button>
      </div>

      <Panel scroll={{ maxH: '66vh' }} data-testid="panel-assets">
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No assets recorded"
            hint="Record what the business owns: the ledger balance says how much was spent, not what was bought."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col" className="w-44">Block</th>
                <th scope="col" className="w-28">In use from</th>
                <th scope="col" className="r w-32">Cost</th>
                <th scope="col" className="r w-32">Depreciated</th>
                <th scope="col" className="r w-32">Book value</th>
                <th scope="col" className="w-40" />
              </tr>
            </thead>
            <tbody data-testid="rows-assets">
              {rows.map((a, i) => (
                <tr key={a.id} {...table.rowProps(i, a)} className={`${table.rowProps(i, a).className} ${a.disposedOn ? 'opacity-50' : ''}`}>
                  <td>
                    {a.name}
                    {a.code && <span className="ml-2 num text-hint text-muted">{a.code}</span>}
                    {a.disposedOn && (
                      <span className="ml-2 text-caption text-muted">sold {toDisplayDate(a.disposedOn)}</span>
                    )}
                  </td>
                  <td className="text-muted">
                    {a.blockName ?? <span className="text-cr">no block</span>}
                    {a.itRate != null && <span className="ml-1.5 num text-hint">{a.itRate}%</span>}
                  </td>
                  <td className="num text-muted">{a.putToUseDate ? toDisplayDate(a.putToUseDate) : '–'}</td>
                  <td className="r"><Money paise={a.cost} /></td>
                  <td className="r text-muted"><Money paise={a.accumulated} /></td>
                  <td className="r font-medium"><Money paise={a.bookValue} /></td>
                  <td onClick={(e) => e.stopPropagation()} className="r whitespace-nowrap">
                    <Button variant="ghost" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                    {!a.disposedOn && (
                      <Button variant="ghost" data-testid={`btn-asset-dispose-${a.id}`} onClick={() => setDisposing(a)}>
                        Dispose
                      </Button>
                    )}
                    {a.accumulated === 0 && (
                      <button className="ml-2 text-small text-cr hover:underline" onClick={() => void remove(a)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={3}>Total · {rows.length} assets</td>
                <td className="r"><Money paise={totals.cost} /></td>
                <td className="r"><Money paise={totals.accumulated} /></td>
                <td className="r"><Money paise={totals.book} /></td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-2 text-hint text-muted">
        Depreciation starts on the day an asset is put to use, not the day it was bought — an asset
        still in its crate is not in use. An asset with no block appears in the books&rsquo;
        schedule and not in the return&rsquo;s.
      </p>

      {editing && <AssetModal asset={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {disposing && <DisposeModal asset={disposing} onClose={() => setDisposing(null)} />}
    </>
  )
}

function AssetModal({ asset, onClose }: { asset: FixedAsset | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: blocks } = useQuery({ queryKey: ['assetBlocks'], queryFn: api.assets.blocks })
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })

  const [name, setName] = useState(asset?.name ?? '')
  const [code, setCode] = useState(asset?.code ?? '')
  const [blockId, setBlockId] = useState<number | ''>(asset?.blockId ?? '')
  const [ledgerId, setLedgerId] = useState<number | ''>(asset?.ledgerId ?? '')
  const [purchaseDate, setPurchaseDate] = useState(asset?.purchaseDate ?? todayISO())
  const [putToUseDate, setPutToUseDate] = useState(asset?.putToUseDate ?? todayISO())
  const [cost, setCost] = useState<number | null>(asset?.cost ?? null)
  const [residual, setResidual] = useState<number | null>(asset?.residualValue ?? null)
  const [lifeYears, setLifeYears] = useState(asset ? String(asset.usefulLifeMonths / 12) : '')
  const [method, setMethod] = useState<'slm' | 'wdv'>(asset?.method ?? 'slm')
  const [location, setLocation] = useState(asset?.location ?? '')
  const [busy, setBusy] = useState(false)

  // Schedule II caps the residual at 5% of cost; a company may assume less, never more.
  const maxResidual = cost ? Math.floor((cost * 5) / 100) : 0
  const residualOver = residual != null && cost != null && residual > maxResidual

  const assetLedgers = (ledgers ?? []).filter((l) => l.groupId != null)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name the asset')
    if (!cost) return void toast.push('error', 'What did it cost?')
    if (!lifeYears.trim() || Number(lifeYears) <= 0) return void toast.push('error', 'How long will it last?')
    setBusy(true)
    try {
      await api.assets.save(
        {
          name: name.trim(),
          code: code.trim() || null,
          blockId: blockId === '' ? null : blockId,
          ledgerId: ledgerId === '' ? null : ledgerId,
          purchaseDate,
          putToUseDate: putToUseDate || purchaseDate,
          cost,
          residualValue: residual ?? 0,
          usefulLifeMonths: Math.round(Number(lifeYears) * 12),
          method,
          location: location.trim() || null
        },
        asset?.id
      )
      await queryClient.invalidateQueries({ queryKey: ['assets'] })
      await queryClient.invalidateQueries({ queryKey: ['assetSchedule'] })
      toast.push('success', `${name.trim()} ${asset ? 'updated' : 'recorded'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={asset ? `Edit ${asset.name}` : 'Add asset'} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name">
          <TextInput data-testid="input-asset-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Code" hint="Whatever is stencilled on it">
          <TextInput value={code} onChange={(e) => setCode(e.target.value)} className="num" placeholder="Optional" />
        </Field>
        <Field label="Where it is">
          <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional" />
        </Field>

        <Field label="Bought on">
          <TextInput type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </Field>
        <Field label="In use from" hint="Depreciation starts here, not at purchase">
          <TextInput
            type="date"
            data-testid="input-asset-in-use"
            value={putToUseDate}
            onChange={(e) => setPutToUseDate(e.target.value)}
          />
        </Field>
        <Field label="Cost">
          <AmountInput testId="input-asset-cost" paise={cost} onPaise={setCost} />
        </Field>

        <Field
          label="Useful life (years)"
          hint="Schedule II: computers 3, office equipment 5, plant 15, furniture 10"
        >
          <TextInput
            data-testid="input-asset-life"
            value={lifeYears}
            onChange={(e) => setLifeYears(e.target.value)}
            className="num text-right"
            inputMode="decimal"
            list="schedule-ii-lives"
          />
          <datalist id="schedule-ii-lives">
            {SCHEDULE_II_LIVES.map((l) => (
              <option key={l.category} value={l.years}>
                {l.category}
              </option>
            ))}
          </datalist>
        </Field>
        <Field
          label="Residual value"
          error={residualOver ? `Schedule II caps this at 5% of cost — ${formatPaise(maxResidual)}` : null}
        >
          <AmountInput paise={residual} onPaise={setResidual} />
        </Field>
        <Field label="Method" hint="How the books depreciate it; the return always uses WDV by block">
          <Select data-testid="select-asset-method" value={method} onChange={(e) => setMethod(e.target.value as 'slm' | 'wdv')}>
            <option value="slm">Straight line</option>
            <option value="wdv">Written-down value</option>
          </Select>
        </Field>

        <Field label="Income-tax block" hint="Assets sharing a rate are pooled in the return">
          <Select
            data-testid="select-asset-block"
            value={blockId}
            onChange={(e) => setBlockId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">No block — books only</option>
            {(blocks ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.itRate}%
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bought through" hint="The ledger its cost sits in, so the register reconciles to the books">
          <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Not linked</option>
            {assetLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-asset-save" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : asset ? 'Save' : 'Add asset'}
        </Button>
      </div>
    </Modal>
  )
}

function DisposeModal({ asset, onClose }: { asset: FixedAsset; onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [on, setOn] = useState(todayISO())
  const [proceeds, setProceeds] = useState<number | null>(null)
  const { data: draft } = useQuery({
    queryKey: ['disposalDraft', asset.id, on, proceeds ?? 0],
    queryFn: () => api.assets.disposalDraft(asset.id, on, proceeds ?? 0),
    retry: false
  })

  const record = async (): Promise<void> => {
    try {
      await api.assets.dispose(asset.id, on, proceeds ?? 0)
      await queryClient.invalidateQueries({ queryKey: ['assets'] })
      await queryClient.invalidateQueries({ queryKey: ['assetSchedule'] })
      toast.push('success', `${asset.name} marked as sold`)
      if (draft) {
        nav.go({
          name: 'voucher-entry',
          kindHint: 'journal',
          draft: {
            date: draft.date,
            narration: draft.narration,
            lines: draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
          },
          draftId: Date.now()
        } as never)
      }
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Dispose of ${asset.name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sold on">
          <TextInput type="date" data-testid="input-dispose-date" value={on} onChange={(e) => setOn(e.target.value)} />
        </Field>
        <Field label="Proceeds" hint="Zero for scrapping">
          <AmountInput testId="input-dispose-proceeds" paise={proceeds} onPaise={setProceeds} autoFocus />
        </Field>
      </div>

      {draft && (
        <div className="mt-4 rounded-md border border-line bg-panel2 p-3 text-body-sm" data-testid="disposal-summary">
          <div className="flex justify-between">
            <span>Book value on that day</span>
            <Money paise={draft.bookValue} />
          </div>
          <div className="flex justify-between font-medium">
            <span>{draft.profitOrLoss >= 0 ? 'Profit on sale' : 'Loss on sale'}</span>
            <Money paise={Math.abs(draft.profitOrLoss)} />
          </div>
          <p className="mt-2 text-hint text-muted">
            In the return there is no profit or loss on the asset itself — the proceeds simply
            reduce the {asset.blockName ?? 'block'}. Both treatments are correct and they are not
            the same.
          </p>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-dispose-confirm" onClick={() => void record()}>
          Record and draft the journal
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the two schedules (#367) ----------

function ScheduleTab(): React.JSX.Element {
  const { from } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [fy, setFy] = useState(() => Number(from.slice(0, 4)))
  const { data, isLoading } = useQuery({ queryKey: ['assetSchedule', fy], queryFn: () => api.assets.schedule(fy) })
  const s = data?.schedule

  const post = async (): Promise<void> => {
    if (!data?.draft) return
    try {
      await api.assets.postDepreciation(fy, null)
      await queryClient.invalidateQueries({ queryKey: ['assetSchedule'] })
      await queryClient.invalidateQueries({ queryKey: ['assets'] })
      nav.go({
        name: 'voucher-entry',
        kindHint: 'journal',
        draft: {
          date: data.draft.date,
          narration: data.draft.narration,
          lines: data.draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
        },
        draftId: Date.now()
      } as never)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-small text-muted">
          <span>Financial year</span>
          <Select className="w-32" data-testid="select-schedule-fy" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
            {[2, 1, 0, -1].map((back) => {
              const year = Number(from.slice(0, 4)) - back
              return (
                <option key={year} value={year}>
                  {year}-{String(year + 1).slice(2)}
                </option>
              )
            })}
          </Select>
          {s?.alreadyPosted && <span className="text-dr">already posted</span>}
        </div>
        <div className="flex items-center gap-2">
          <ExportGroup
            items={[
              {
                label: 'PDF',
                disabled: !s?.companiesAct.length,
                onClick: () => void printReport(
                  {
                    title: 'Depreciation schedule — Companies Act',
                    periodLabel: `${toDisplayDate(s!.from)} to ${toDisplayDate(s!.to)}`,
                    columns: [
                      { label: 'Asset', align: 'l' },
                      { label: 'Method', align: 'l' },
                      { label: 'Opening', align: 'r' },
                      { label: 'Depreciation', align: 'r' },
                      { label: 'Closing', align: 'r' }
                    ],
                    rows: s!.companiesAct.map((r) => ({
                      cells: [r.name, r.method.toUpperCase(), formatPaise(r.openingWdv), formatPaise(r.depreciation), formatPaise(r.closingWdv)]
                    })),
                    footNote:
                      'Companies Act only. The income-tax schedule is computed per block and gives a different figure by design.',
                    filename: 'depreciation-companies-act'
                  },
                  toast
                )
              }
            ]}
          />
          <Button
            variant="primary"
            data-testid="btn-post-depreciation"
            disabled={!data?.draft || s?.alreadyPosted}
            onClick={() => void post()}
          >
            Draft the journal
          </Button>
        </div>
      </div>

      {s && (
        <div className="mb-3 grid grid-cols-3 gap-3">
          <Stat label="Companies Act — for the books" value={<Money paise={s.companiesActTotal} />} />
          <Stat label="Income tax — for the return" value={<Money paise={s.incomeTaxTotal} />} />
          <Stat
            label="Difference"
            value={<Money paise={Math.abs(s.difference)} />}
            hint={s.difference === 0 ? undefined : 'Carry as deferred tax'}
          />
        </div>
      )}

      {s && s.unblocked > 0 && (
        <div className="mb-3 rounded-md border border-accentbar/50 bg-accentbar/10 px-3.5 py-2.5 text-body-sm">
          <b>{s.unblocked}</b> asset{s.unblocked === 1 ? ' has' : 's have'} no income-tax block, so
          {s.unblocked === 1 ? ' it appears' : ' they appear'} in the books&rsquo; schedule and not
          in the return&rsquo;s.
        </div>
      )}

      <Panel scroll={{ maxH: '40vh' }} data-testid="panel-schedule-companies">
        {isLoading || !s ? (
          <SkeletonRows rows={5} />
        ) : s.companiesAct.length === 0 ? (
          <EmptyState title="Nothing to depreciate" hint="No asset was in use during this year." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Asset (Companies Act)</th>
                <th scope="col" className="w-20">Method</th>
                <th scope="col" className="r w-32">Opening</th>
                <th scope="col" className="r w-20">Held</th>
                <th scope="col" className="r w-32">Depreciation</th>
                <th scope="col" className="r w-32">Closing</th>
              </tr>
            </thead>
            <tbody data-testid="rows-schedule-companies">
              {s.companiesAct.map((r) => (
                <tr key={r.assetId}>
                  <td>
                    {r.name}
                    {r.disposedOn && <span className="ml-2 text-caption text-muted">sold {toDisplayDate(r.disposedOn)}</span>}
                    {r.cappedAtResidual && <span className="ml-2 text-caption text-muted">at residual</span>}
                  </td>
                  <td className="uppercase text-muted">{r.method}</td>
                  <td className="r"><Money paise={r.openingWdv} /></td>
                  <td className="r num text-muted">{Math.round(r.heldFraction * 100)}%</td>
                  <td className="r"><Money paise={r.depreciation} /></td>
                  <td className="r"><Money paise={r.closingWdv} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={4}>Total for the books</td>
                <td className="r"><Money paise={s.companiesActTotal} /></td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>

      <Panel scroll={{ maxH: '34vh' }} className="mt-3" data-testid="panel-schedule-tax">
        {!s ? null : s.incomeTax.length === 0 ? (
          <EmptyState title="No blocks in play" hint="Assign assets to an income-tax block to build the return's schedule." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Block (Income-tax Act)</th>
                <th scope="col" className="r w-16">Rate</th>
                <th scope="col" className="r w-32">Opening</th>
                <th scope="col" className="r w-32">Added</th>
                <th scope="col" className="r w-32">Sold</th>
                <th scope="col" className="r w-32">Depreciation</th>
                <th scope="col" className="r w-32">Closing</th>
              </tr>
            </thead>
            <tbody data-testid="rows-schedule-tax">
              {s.incomeTax.map((b) => (
                <Fragment key={b.blockName}>
                  <tr>
                    <td>
                      {b.blockName}
                      {b.blockExhausted && <span className="ml-2 text-caption text-cr">exhausted</span>}
                    </td>
                    <td className="r num">{b.rate}%</td>
                    <td className="r"><Money paise={b.openingWdv} /></td>
                    <td className="r">
                      <Money paise={b.additionsFullRate + b.additionsHalfRate} />
                      {b.additionsHalfRate > 0 && (
                        <span className="ml-1.5 text-hint text-muted">half rate on <Money paise={b.additionsHalfRate} /></span>
                      )}
                    </td>
                    <td className="r text-muted">{b.deletions > 0 ? <Money paise={b.deletions} /> : '–'}</td>
                    <td className="r"><Money paise={b.depreciation} /></td>
                    <td className="r"><Money paise={b.closingWdv} /></td>
                  </tr>
                  {b.shortTermGain > 0 && (
                    <tr className="text-small text-cr">
                      <td colSpan={7} className="pl-8">
                        Sales exceeded the block by <Money paise={b.shortTermGain} /> — a short-term
                        capital gain under section 50, and no depreciation is allowed on this block.
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className="total-row">
                <td colSpan={5}>Total for the return</td>
                <td className="r"><Money paise={s.incomeTaxTotal} /></td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>


      <p className="mt-2 text-hint text-muted">
        Only the Companies Act figure goes in the books — booking the income-tax number would make
        the accounts wrong. The return pools assets by rate, charges half in the first year for
        anything used under 180 days, and does not pro-rate by days at all.
      </p>
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <Panel className="p-3">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-body font-semibold">{value}</div>
      {hint && <div className="text-hint text-muted">{hint}</div>}
    </Panel>
  )
}
