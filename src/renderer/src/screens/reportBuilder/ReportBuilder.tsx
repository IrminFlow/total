import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultModel, modelProblems, reportModelSchema, RELATIVE_PERIODS, type ReportModel } from '@shared/reportBuilder/model'
import { RELATIVE_LABELS, resolvePeriod } from '@shared/reportBuilder/period'
import { toDisplayDate, todayISO } from '@shared/dates'
import { reportsApi, type SavedReport } from '../../lib/reportsClient'
import { useSavedReports } from '../../lib/pinnedReports'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Banner, Button, DateInput, DrawerSection, Page, PageHeader, Panel, Select } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { OptionToggle, OptionsTable } from '../../components/ScreenOptions'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { tableActions } from '../../components/table'
import { DesignPanel } from './DesignPanel'
import { ResultView } from './ResultView'

/** Debounced copy of a value (the live preview reruns 250 ms after the last edit). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const sameModel = (a: ReportModel | null | undefined, b: ReportModel | null | undefined): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Analysis → Report builder (WP 6.1): pick a source, dimensions, measures and filters; the result
 * previews live (computed at query time in the main process), pivots, compares and charts; save
 * it by name, pin it to the sidebar, duplicate / rename / delete it, share it as JSON. A pinned
 * report opens here with its `reportId`.
 */
export function ReportBuilderScreen({
  reportId,
  initialModel,
  initialName
}: {
  reportId?: number
  /** WP 5.5: a model built from a question (the assistant's build_report, or Assistants → Report
   *  from a question) — opens unsaved, pre-filled; Save names it. */
  initialModel?: ReportModel
  initialName?: string
}): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const qc = useQueryClient()
  const saved = useQuery({ queryKey: ['savedReport', reportId], queryFn: () => reportsApi.get(reportId!), enabled: !!reportId })
  const { data: savedList } = useSavedReports()
  const [model, setModel] = useState<ReportModel>(() => (initialModel && !reportId ? reportModelSchema.parse(initialModel) : defaultModel('accounts')))
  const [loadedFor, setLoadedFor] = useState<number | null>(null)
  const [showDesign, setShowDesign] = useState(true)

  // Load the saved report once per id (later refetches — e.g. after a pin — keep the edits).
  useEffect(() => {
    if (!reportId || !saved.data || loadedFor === reportId) return
    if (saved.data.model) setModel(saved.data.model)
    setLoadedFor(reportId)
  }, [reportId, saved.data, loadedFor])

  const problems = useMemo(() => modelProblems(model), [model])
  const debounced = useDebounced(model, 250)
  const debouncedValid = useMemo(() => reportModelSchema.safeParse(debounced).success, [debounced])
  // A saved report runs only once its own model has settled through the debounce — never the
  // starter model's cached result for a moment in between.
  const [settledFor, setSettledFor] = useState<number | null | undefined>(undefined)
  const target = reportId ?? null
  useEffect(() => {
    if ((!reportId || loadedFor === reportId) && sameModel(debounced, model)) setSettledFor(target)
  }, [reportId, loadedFor, debounced, model, target])
  const ready = settledFor === target
  const run = useQuery({
    queryKey: ['rbRun', JSON.stringify(debounced), from, to],
    queryFn: () => reportsApi.run(debounced, { from, to }),
    enabled: debouncedValid && ready,
    placeholderData: keepPreviousData,
    retry: false
  })

  const current: SavedReport | null = reportId && saved.data ? saved.data : null
  const dirty = current ? !sameModel(current.model, model) : true
  const title = current?.name ?? 'Report builder'
  const range = resolvePeriod(model.period, { from, to }, todayISO())
  const periodLabel = `${toDisplayDate(range.from)} → ${toDisplayDate(range.to)}`

  const refreshSaved = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['savedReports'] })
    await qc.invalidateQueries({ queryKey: ['savedReport'] })
  }
  const fail = (err: unknown): void => toast.push('error', (err as Error).message)

  const save = async (asNew = false): Promise<void> => {
    if (problems.length) return toast.push('error', problems[0]!)
    try {
      if (current && !asNew) {
        await reportsApi.save(current.name, model, current.id)
        await refreshSaved()
        toast.push('success', `Saved “${current.name}”`)
        return
      }
      const name = await promptDialog({ title: asNew ? 'Save as a new report' : 'Save report', message: 'Name the report — it is saved with the company and can be pinned to the sidebar.', initial: current ? `${current.name} (copy)` : (initialName ?? ''), placeholder: 'e.g. Sales by party by month', confirmLabel: 'Save' })
      if (!name?.trim()) return
      const created = await reportsApi.save(name.trim(), model)
      await refreshSaved()
      toast.push('success', `Saved “${created.name}”`)
      nav.replace({ name: 'report-builder', reportId: created.id })
    } catch (err) {
      fail(err)
    }
  }

  const act = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try {
      await fn()
      await refreshSaved()
      if (done) toast.push('success', done)
    } catch (err) {
      fail(err)
    }
  }

  const menuItems = [
    { label: 'New report', testId: 'rb-menu-new', onSelect: () => nav.go({ name: 'report-builder' }) },
    { label: 'Save as new…', testId: 'rb-menu-save-as', onSelect: () => void save(true) },
    ...(current
      ? [
          { label: current.pinned ? 'Unpin from sidebar' : 'Pin to sidebar', testId: 'rb-menu-pin', onSelect: () => void act(() => reportsApi.pin(current.id, !current.pinned), current.pinned ? 'Unpinned' : `Pinned “${current.name}” under Analysis`) },
          {
            label: 'Rename…', testId: 'rb-menu-rename',
            onSelect: () => void (async () => {
              const name = await promptDialog({ title: 'Rename report', initial: current.name, confirmLabel: 'Rename' })
              if (name?.trim() && name.trim() !== current.name) await act(() => reportsApi.rename(current.id, name.trim()), 'Renamed')
            })()
          },
          {
            label: 'Duplicate', testId: 'rb-menu-duplicate',
            onSelect: () => void (async () => {
              try {
                const copy = await reportsApi.duplicate(current.id)
                await refreshSaved()
                toast.push('success', `Copied to “${copy.name}”`)
                nav.go({ name: 'report-builder', reportId: copy.id })
              } catch (err) {
                fail(err)
              }
            })()
          },
          {
            label: 'Share as JSON', testId: 'rb-menu-share',
            onSelect: () => void (async () => {
              try {
                const r = await reportsApi.exportJson(current.id)
                try {
                  await navigator.clipboard.writeText(r.json)
                } catch {
                  /* clipboard unavailable — the file is still written */
                }
                toast.push('success', `Copied to the clipboard and saved — ${r.path}`)
              } catch (err) {
                fail(err)
              }
            })()
          }
        ]
      : []),
    {
      label: 'Import JSON…', testId: 'rb-menu-import',
      onSelect: () => void (async () => {
        const json = await promptDialog({ title: 'Import a shared report', message: 'Paste the report JSON someone shared with you.', placeholder: '{"kind":"total-report", …}', confirmLabel: 'Import' })
        if (!json?.trim()) return
        try {
          const created = await reportsApi.importJson(json.trim())
          await refreshSaved()
          toast.push('success', `Imported “${created.name}”`)
          nav.go({ name: 'report-builder', reportId: created.id })
        } catch (err) {
          fail(err)
        }
      })()
    },
    ...(current
      ? [{
          label: 'Delete…', danger: true, testId: 'rb-menu-delete',
          onSelect: () => void (async () => {
            const ok = await confirmDialog({ title: 'Delete report', message: `Delete the saved report “${current.name}”? The books are not affected.`, confirmLabel: 'Delete', danger: true })
            if (!ok) return
            try {
              await reportsApi.remove(current.id)
              await refreshSaved()
              toast.push('success', 'Report deleted')
              nav.replace({ name: 'report-builder' })
            } catch (err) {
              fail(err)
            }
          })()
        }]
      : [])
  ]

  const periodValue = model.period.kind === 'relative' ? model.period.rule : model.period.kind
  const setPeriod = (v: string): void => {
    if (v === 'working') setModel({ ...model, period: { kind: 'working' } })
    else if (v === 'range') setModel({ ...model, period: { kind: 'range', from: range.from, to: range.to } })
    else setModel({ ...model, period: { kind: 'relative', rule: v as (typeof RELATIVE_PERIODS)[number] } })
  }

  return (
    <Page width="wide">
      <PageHeader
        title={title}
        subtitle={current ? `Saved report${current.pinned ? ' · pinned to the sidebar' : ''}${dirty ? ' · unsaved changes' : ''}` : 'Pick dimensions, measures and filters — the preview updates as you go'}
        period={periodLabel}
        controls={
          <div className="flex items-center gap-2">
            <Select aria-label="Period" value={periodValue} onChange={(e) => setPeriod(e.target.value)} data-testid="rb-period" className="w-48">
              <option value="working">Working period</option>
              {RELATIVE_PERIODS.map((r) => <option key={r} value={r}>{RELATIVE_LABELS[r]}</option>)}
              <option value="range">Fixed dates…</option>
            </Select>
            {model.period.kind === 'range' && (
              <>
                <DateInput value={model.period.from} context={model.period.from} onChange={(d) => setModel({ ...model, period: { kind: 'range', from: d, to: (model.period as { to: string }).to } })} className="w-28" testId="rb-period-from" ariaLabel="From date" />
                <DateInput value={model.period.to} context={model.period.to} onChange={(d) => setModel({ ...model, period: { kind: 'range', from: (model.period as { from: string }).from, to: d } })} className="w-28" testId="rb-period-to" ariaLabel="To date" />
              </>
            )}
            <Select
              aria-label="Open a saved report"
              value={reportId ?? ''}
              onChange={(e) => e.target.value && nav.go({ name: 'report-builder', reportId: Number(e.target.value) })}
              data-testid="rb-open"
              className="w-52"
            >
              <option value="">{savedList?.length ? 'Open a saved report…' : 'No saved reports yet'}</option>
              {(savedList ?? []).map((r) => <option key={r.id} value={r.id}>{r.pinned ? '◆ ' : ''}{r.name}</option>)}
            </Select>
          </div>
        }
        secondary={
          <>
            <Button variant="ghost" onClick={() => setShowDesign((v) => !v)} data-testid="rb-toggle-design">{showDesign ? 'Hide design' : 'Show design'}</Button>
            <Button variant="ghost" onClick={() => tableActions('report-builder')?.exportPdf?.()} data-testid="rb-export-pdf">PDF</Button>
            <Button variant="ghost" onClick={() => tableActions('report-builder')?.exportCsv?.()} data-testid="rb-export-csv">CSV</Button>
            <MenuButton label="Report actions" items={menuItems} testId="rb-menu">Report ▾</MenuButton>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={problems.length > 0 || (!!current && !dirty)} data-testid="rb-save">
            {current ? (dirty ? 'Save changes' : 'Saved') : 'Save report…'}
          </Button>
        }
        options={{
          onReset: () => setModel(defaultModel(model.source)),
          content: (
            <>
              <DrawerSection title="Saved report" testId="options-rb-saved">
                {current ? (
                  <OptionToggle
                    label="Pin to the sidebar (under Analysis)"
                    checked={current.pinned}
                    onChange={(v) => void act(() => reportsApi.pin(current.id, v), v ? 'Pinned' : 'Unpinned')}
                    testId="input-rb-pinned"
                  />
                ) : (
                  <p className="text-hint text-muted">Save the report to pin it to the sidebar, schedule it in a pack or share it.</p>
                )}
              </DrawerSection>
              <OptionsTable area="report-builder" label="Result table" />
            </>
          )
        }}
      />

      {saved.data?.problem && (
        <Banner tone="danger" className="mb-3" title="This saved report no longer fits the builder">{saved.data.problem}</Banner>
      )}

      <div className={`grid items-start gap-3 ${showDesign ? 'grid-cols-[320px_minmax(0,1fr)]' : 'grid-cols-1'}`}>
        {showDesign && (
          <Panel className="sticky top-0 max-h-[calc(100vh-150px)] overflow-y-auto">
            <DesignPanel model={model} onChange={setModel} />
          </Panel>
        )}
        <div className={`min-w-0 transition-opacity ${run.isPlaceholderData || run.isFetching ? 'opacity-70' : ''}`} data-testid="rb-result" data-state={!ready || run.isFetching ? 'loading' : run.data ? 'ready' : 'idle'}>
          {problems.length > 0 ? (
            <Banner tone="warning" title="Finish the design to see the report" testId="rb-problems">
              <ul className="list-disc pl-4">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </Banner>
          ) : run.error ? (
            <Banner tone="danger" testId="rb-error">{(run.error as Error).message}</Banner>
          ) : (
            <ResultView result={ready ? run.data : undefined} model={debounced} loading={!ready || run.isLoading} title={title} periodLabel={periodLabel} />
          )}
        </div>
      </div>
    </Page>
  )
}
