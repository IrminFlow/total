import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, type ImportLoadResult, type ImportRunResult, type ImportSheetSummary, type ImportTemplateRow, type ImportWizardOptions
} from '../lib/client'
import { useNav, useToasts, type ToastState } from '../state/stores'
import { Badge, Banner, Button, Checkbox, DrawerSection, Field, Page, PageHeader, Panel, Select, StatGrid, StatTile, TextInput } from '../components/ui'
import { Segmented } from '../components/kit'
import { DataTable, defineColumns } from '../components/table'
import { PROFILES, profileById, type ImportProfile } from '@shared/dataImport/profiles'
import { autoMap, mappingFromNames } from '@shared/dataImport/detect'
import { TARGETS } from '@shared/dataImport/targets'
import { formatPaise } from '@shared/money'
import { xlsxReport } from '../lib/reportExport'

/**
 * System → Import (WP 6.3): one wizard for Excel / CSV tables (any target, generic or a Busy /
 * Zoho export), a Total Books workbook and a Busy XML export.
 *   1. Pick a file  2. Map columns (auto-detected; remembered templates)  3. Preview — a real dry
 *   run with row-level errors  4. Done — counts, error report, undo.
 * Nothing is written until step 4's button; every write is audited and the run is undoable.
 */

type Step =
  | { kind: 'pick' }
  | { kind: 'map'; file: ImportLoadResult }
  | { kind: 'preview'; file: ImportLoadResult; result: ImportRunResult }
  | { kind: 'done'; file: ImportLoadResult; result: ImportRunResult }

const DEFAULT_OPTS: ImportWizardOptions = { duplicate: 'skip', createMissing: true, openingDifference: 'block', dateOrder: 'dmy', applyBooksFrom: true }

const SOURCE_LABEL: Record<string, string> = { generic: 'Excel / CSV', busy: 'Busy', zoho: 'Zoho Books' }

export function ImportWizardScreen(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  // Table mapping state (step 2), kept across preview → back.
  const [sheetName, setSheetName] = useState('')
  const [sheet, setSheet] = useState<ImportSheetSummary | null>(null)
  const [profileId, setProfileId] = useState('')
  const [mapping, setMapping] = useState<Record<string, number | null>>({})
  const [opts, setOpts] = useState<ImportWizardOptions>(DEFAULT_OPTS)
  const [templateName, setTemplateName] = useState('')

  const fail = (err: unknown): void => toast.push('error', (err as Error).message)

  const chooseSheet = (s: ImportSheetSummary, pid?: string): void => {
    setSheetName(s.name)
    setSheet(s)
    const template = s.templates[0]
    const best = pid ?? template?.profileId ?? s.guesses[0]?.profileId ?? 'generic:ledgers'
    setProfileId(best)
    const profile = profileById(best)!
    setMapping(template && template.profileId === best ? mappingFromNames(s.headers, template.mapping) : autoMap(s.headers, profile.fields))
    if (template) setOpts((o) => ({ ...o, ...(template.options as Partial<ImportWizardOptions>) }))
  }

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const file = await api.dataImport.load()
      if (!file) return
      setOpts(DEFAULT_OPTS)
      if (file.kind === 'table') chooseSheet(file.sheets[0] as ImportSheetSummary)
      setStep({ kind: 'map', file })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const query = (file: ImportLoadResult): Parameters<typeof api.dataImport.preview>[0] => ({
    token: file.token, sheet: sheetName, headerRow: sheet?.headerRow ?? 0, profileId, mapping, options: opts
  })

  const preview = async (file: ImportLoadResult): Promise<void> => {
    setBusy(true)
    try {
      const result = file.kind === 'table' ? await api.dataImport.preview(query(file)) : await api.dataImport.planPreview(file.token, opts)
      setStep({ kind: 'preview', file, result })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (file: ImportLoadResult): Promise<void> => {
    setBusy(true)
    try {
      const result =
        file.kind === 'table'
          ? await api.dataImport.run({ ...query(file), saveTemplate: templateName.trim() ? { name: templateName.trim() } : null })
          : await api.dataImport.planRun(file.token, opts)
      await qc.invalidateQueries()
      const made = result.steps.reduce((n, s) => n + s.created + s.updated, 0)
      toast.push('success', `Imported ${made} record${made === 1 ? '' : 's'}`)
      setStep({ kind: 'done', file, result })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const stepNo = { pick: 1, map: 2, preview: 3, done: 4 }[step.kind]
  return (
    <Page width="wide">
      <PageHeader
        title="Import"
        subtitle={`Step ${stepNo} of 4 · ${['choose a file', 'map the columns', 'check the preview', 'done'][stepNo - 1]}`}
        options={{
          content: (
            <DrawerSection title="How the import works">
              <p className="text-hint text-muted">
                The preview is a real dry run: every row goes through the same checks as the voucher and master screens (GSTIN,
                PAN and HSN validation, the posting rules, locked periods), then everything is rolled back. Importing writes
                each record through the same services, audits it, and records the batch so it can be undone.
              </p>
            </DrawerSection>
          )
        }}
      />
      {step.kind === 'pick' && <PickStep busy={busy} onPick={() => void pick()} />}
      {step.kind === 'map' && step.file.kind === 'table' && sheet && (
        <MapStep
          file={step.file}
          sheet={sheet}
          profileId={profileId}
          mapping={mapping}
          opts={opts}
          busy={busy}
          onSheet={async (name, headerRow) => {
            try {
              const s = await api.dataImport.sheet(step.file.token, name, headerRow)
              chooseSheet(s, headerRow !== undefined ? profileId : undefined)
            } catch (err) {
              fail(err)
            }
          }}
          onProfile={(pid) => {
            setProfileId(pid)
            setMapping(autoMap(sheet.headers, profileById(pid)!.fields))
          }}
          onTemplate={(t) => {
            setProfileId(t.profileId)
            setMapping(mappingFromNames(sheet.headers, t.mapping))
            setOpts((o) => ({ ...o, ...(t.options as Partial<ImportWizardOptions>) }))
          }}
          onMapping={setMapping}
          onOpts={setOpts}
          onBack={() => setStep({ kind: 'pick' })}
          onNext={() => void preview(step.file)}
        />
      )}
      {step.kind === 'map' && step.file.kind !== 'table' && (
        <PlanStep file={step.file} opts={opts} busy={busy} onOpts={setOpts} onBack={() => setStep({ kind: 'pick' })} onNext={() => void preview(step.file)} />
      )}
      {step.kind === 'preview' && (
        <PreviewStep
          file={step.file}
          result={step.result}
          busy={busy}
          templateName={templateName}
          onTemplateName={setTemplateName}
          onBack={() => setStep({ kind: 'map', file: step.file })}
          onImport={() => void apply(step.file)}
        />
      )}
      {step.kind === 'done' && <DoneStep result={step.result} onAnother={() => setStep({ kind: 'pick' })} />}
    </Page>
  )
}

// ---------- step 1 ----------

function PickStep({ busy, onPick }: { busy: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-6">
        <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p className="text-body text-ink">Bring masters, opening balances and vouchers in from a spreadsheet or another accounting program.</p>
            <ul className="mt-3 grid gap-1.5 text-body-sm text-muted sm:grid-cols-2">
              <li><b className="text-ink">Excel / CSV</b> — any layout; you map the columns</li>
              <li><b className="text-ink">Zoho Books</b> — Export data / Backup files per module</li>
              <li><b className="text-ink">Busy</b> — Excel exports, or the XML data export</li>
              <li><b className="text-ink">Total books workbook</b> — System → Export</li>
            </ul>
            <p className="mt-3 text-hint text-muted">Tally XML has its own screen: System → Import from Tally.</p>
          </div>
          <Button variant="primary" data-testid="btn-import-pick" loading={busy} onClick={onPick} className="px-8 py-3 text-lead">
            {busy ? 'Reading…' : 'Choose file…'}
          </Button>
        </div>
      </Panel>
      <RecentImports />
    </div>
  )
}

function RecentImports(): React.JSX.Element | null {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['importBatches'], queryFn: () => api.dataImport.batches() })
  const columns = useMemo(
    () =>
      defineColumns<NonNullable<typeof data>[number]>([
        { id: 'id', header: 'Batch', kind: 'number', value: (r) => r.id, width: 80 },
        { id: 'at', header: 'When', kind: 'text', value: (r) => r.createdAt, width: 170 },
        { id: 'file', header: 'File', kind: 'text', value: (r) => r.fileName ?? '', minWidth: 180 },
        { id: 'source', header: 'Source', kind: 'text', value: (r) => (r.profileId ? (profileById(r.profileId)?.label ?? r.profileId) : r.source) },
        { id: 'created', header: 'Created', kind: 'number', value: (r) => r.created, width: 90 },
        { id: 'updated', header: 'Updated', kind: 'number', value: (r) => r.updated, width: 90 },
        { id: 'errors', header: 'Errors', kind: 'number', value: (r) => r.errorCount, width: 80 },
        {
          id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 130,
          options: [{ value: 'applied', label: 'Applied' }, { value: 'undone', label: 'Undone' }, { value: 'partly_undone', label: 'Partly undone' }]
        }
      ]),
    []
  )
  if (!data || data.length === 0) return null
  return (
    <Panel>
      <DataTable
        viewId="import-batches"
        testId="import-batches"
        columns={columns}
        rows={data}
        rowKey={(r) => r.id}
        maxHeight="320px"
        toolbarStart={<span className="text-body-sm font-semibold text-ink">Recent imports</span>}
        trailing={(r) =>
          r.status === 'applied' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`btn-import-undo-${r.id}`}
              onClick={async () => {
                if (!window.confirm(`Undo import batch ${r.id}? Its vouchers go to the bin and unused masters it created are removed.`)) return
                try {
                  const u = await api.dataImport.undo(r.id)
                  await qc.invalidateQueries()
                  toast.push(u.kept.length ? 'warning' : 'success', `Undone: ${u.binned} binned, ${u.deleted} removed, ${u.restored} restored${u.kept.length ? ` · ${u.kept.length} kept (still in use)` : ''}`)
                } catch (err) {
                  toast.push('error', (err as Error).message)
                }
              }}
            >
              Undo
            </Button>
          )
        }
      />
    </Panel>
  )
}

// ---------- step 2 (tables) ----------

function MapStep(props: {
  file: ImportLoadResult
  sheet: ImportSheetSummary
  profileId: string
  mapping: Record<string, number | null>
  opts: ImportWizardOptions
  busy: boolean
  onSheet: (name: string, headerRow?: number) => void
  onProfile: (id: string) => void
  onTemplate: (t: ImportTemplateRow) => void
  onMapping: (m: Record<string, number | null>) => void
  onOpts: (o: ImportWizardOptions) => void
  onBack: () => void
  onNext: () => void
}): React.JSX.Element {
  const { file, sheet, mapping, opts } = props
  const profile = profileById(props.profileId) as ImportProfile
  const sheets = file.sheets as ImportSheetSummary[]
  const missing = profile.fields.filter((f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined))
  const { data: templates } = useQuery({ queryKey: ['importTemplates', profile.id], queryFn: () => api.dataImport.templates(profile.id) })
  const { data: bankLedgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: () => api.bank.ledgers(), enabled: profile.target === 'bank' })
  const guess = sheet.guesses[0]
  const sample = (col: number | null | undefined): string => (col === null || col === undefined ? '' : sheet.sample.map((r) => r[col] ?? '').find((v) => v.trim()) ?? '')
  const groupedProfiles = (['generic', 'zoho', 'busy'] as const).map((src) => ({ src, list: PROFILES.filter((p) => p.source === src) }))

  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="File">
            <p className="truncate py-1.5 text-body text-ink" data-testid="import-file-name" title={file.fileName}>{file.fileName}</p>
          </Field>
          {sheets.length > 1 ? (
            <Field label="Sheet">
              <Select value={sheet.name} onChange={(e) => props.onSheet(e.target.value)} data-testid="import-sheet">
                {sheets.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.rowCount} rows)</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="Rows"><p className="num py-1.5 text-body text-ink">{sheet.rowCount}</p></Field>
          )}
          <Field label="Header row" hint="Detected automatically — change it if titles sit above the table">
            <Select value={String(sheet.headerRow)} onChange={(e) => props.onSheet(sheet.name, Number(e.target.value))} data-testid="import-header-row">
              {Array.from({ length: Math.max(15, sheet.headerRow + 1) }, (_, i) => <option key={i} value={i}>Row {i + 1}{i === sheet.headerRow ? ` — ${sheet.headers.slice(0, 3).join(', ')}…` : ''}</option>)}
            </Select>
          </Field>
          <Field label="What is this file?" hint={guess ? `Looks like: ${profileById(guess.profileId)?.label}` : undefined}>
            <Select value={profile.id} onChange={(e) => props.onProfile(e.target.value)} data-testid="import-profile">
              {groupedProfiles.map((g) => (
                <optgroup key={g.src} label={SOURCE_LABEL[g.src]}>
                  {g.list.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
        {(templates?.length ?? 0) > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-body-sm">
            <span className="text-muted">Saved mappings:</span>
            {templates!.map((t) => (
              <Button key={t.id} size="sm" variant="ghost" onClick={() => props.onTemplate(t)} data-testid={`btn-import-template-${t.id}`}>
                {t.name}
              </Button>
            ))}
          </div>
        )}
        {(profile.unverified.length > 0 || profile.citations.length > 0) && (
          <Banner tone="warning" className="mt-4" title={`${SOURCE_LABEL[profile.source]} layout — check the mapping`} testId="import-unverified">
            <ul className="list-disc pl-4">
              {profile.unverified.map((u) => <li key={u}>UNVERIFIED: {u}</li>)}
            </ul>
            {profile.citations.length > 0 && <p className="mt-1 text-hint text-muted">Column names from: {profile.citations.join(' · ')}</p>}
          </Banner>
        )}
      </Panel>

      <Panel className="p-0">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-body font-semibold text-ink">Columns → {TARGETS[profile.target].label}</h2>
          <Button size="sm" variant="ghost" onClick={() => void api.dataImport.sample(profile.id)} data-testid="btn-import-sample">
            Blank template (.xlsx)
          </Button>
        </div>
        <table className="ledger-table w-full" data-testid="import-mapping">
          <thead>
            <tr><th className="w-[30%] text-left">Field</th><th className="w-[35%] text-left">Column in the file</th><th className="text-left">First value</th></tr>
          </thead>
          <tbody>
            {profile.fields.map((f) => {
              const col = mapping[f.key]
              const unmappedRequired = f.required && (col === null || col === undefined)
              return (
                <tr key={f.key} data-testid={`import-map-row-${f.key}`}>
                  <td>
                    <span className="text-ink">{f.label}</span>
                    {f.required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
                    {f.hint && <span className="block text-hint text-muted">{f.hint}</span>}
                  </td>
                  <td>
                    <Select
                      aria-label={`Column for ${f.label}`}
                      invalid={unmappedRequired}
                      value={col === null || col === undefined ? '' : String(col)}
                      onChange={(e) => props.onMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })}
                      data-testid={`import-map-${f.key}`}
                    >
                      <option value="">— not in this file —</option>
                      {sheet.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </Select>
                  </td>
                  <td className="truncate text-muted" title={sample(col)}>{sample(col)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>

      <OptionsPanel opts={opts} onOpts={props.onOpts} target={profile.target} bankLedgers={bankLedgers ?? []} />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onBack}>Choose a different file</Button>
        <Button variant="primary" data-testid="btn-import-preview" loading={props.busy} disabled={missing.length > 0 || (profile.target === 'bank' && !opts.bankLedgerId)} onClick={props.onNext} title={missing.length ? `Map: ${missing.map((m) => m.label).join(', ')}` : undefined}>
          Preview (dry run)
        </Button>
      </div>
    </div>
  )
}

function OptionsPanel({ opts, onOpts, target, bankLedgers }: { opts: ImportWizardOptions; onOpts: (o: ImportWizardOptions) => void; target: string; bankLedgers: { id: number; name: string }[] }): React.JSX.Element {
  return (
    <Panel className="p-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Already exists" hint="Matched by name (vouchers: type + number)">
          <Segmented
            label="Duplicate strategy"
            testId="import-duplicate"
            value={opts.duplicate}
            onChange={(duplicate) => onOpts({ ...opts, duplicate })}
            options={[{ value: 'skip', label: 'Skip' }, { value: 'update', label: 'Update' }, { value: 'create', label: 'Create new' }]}
          />
        </Field>
        <Field label="Dates are written">
          <Select value={opts.dateOrder} onChange={(e) => onOpts({ ...opts, dateOrder: e.target.value as ImportWizardOptions['dateOrder'] })} data-testid="import-date-order">
            <option value="dmy">Day first (31/03/2026)</option>
            <option value="mdy">Month first (03/31/2026)</option>
            <option value="ymd">Year first (2026-03-31)</option>
          </Select>
        </Field>
        <div className="pt-5">
          <Checkbox
            label="Create missing masters"
            hint="Units, stock groups, godowns, parties and items named in the file; unknown account groups go to Suspense A/c"
            checked={opts.createMissing}
            onChange={(createMissing) => onOpts({ ...opts, createMissing })}
            testId="import-create-missing"
          />
        </div>
        {(target === 'openings' || target === 'ledgers' || target === 'parties' || target === 'books') && (
          <Field label="If openings don't tie (Dr ≠ Cr)" className="md:col-span-2">
            <Segmented
              label="Opening difference"
              testId="import-opening-diff"
              value={opts.openingDifference}
              onChange={(openingDifference) => onOpts({ ...opts, openingDifference })}
              options={[{ value: 'block', label: 'Stop' }, { value: 'suspense', label: 'Post to "Difference in Opening Balances"' }, { value: 'leave', label: 'Leave the difference' }]}
            />
          </Field>
        )}
        {target === 'bank' && (
          <Field label="Bank ledger" required>
            <Select value={opts.bankLedgerId ? String(opts.bankLedgerId) : ''} onChange={(e) => onOpts({ ...opts, bankLedgerId: e.target.value ? Number(e.target.value) : undefined })} data-testid="import-bank-ledger">
              <option value="">Choose…</option>
              {bankLedgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Panel>
  )
}

// ---------- step 2 (whole-file plans) ----------

function PlanStep({ file, opts, busy, onOpts, onBack, onNext }: { file: ImportLoadResult; opts: ImportWizardOptions; busy: boolean; onOpts: (o: ImportWizardOptions) => void; onBack: () => void; onNext: () => void }): React.JSX.Element {
  const isBooks = file.kind === 'books'
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <h2 className="text-body font-semibold text-ink" data-testid="import-plan-title">
          {isBooks ? `Total books workbook — ${String(file.manifest?.company ?? '')}` : 'Busy XML data export'}
        </h2>
        <p className="mt-1 text-body-sm text-muted">{file.fileName}</p>
        {isBooks ? (
          <ul className="mt-3 grid gap-1 text-body-sm sm:grid-cols-3">
            {file.sheets.filter((s) => s.name !== 'Manifest' && !s.name.includes('(info)')).map((s) => (
              <li key={s.name} className="flex justify-between gap-3 rounded border border-line px-3 py-1.5"><span>{s.name}</span><span className="num text-muted">{s.rowCount}</span></li>
            ))}
          </ul>
        ) : (
          <>
            <StatGrid className="mt-3">
              <StatTile label="Accounts" value={String(file.busy?.ledgers ?? 0)} />
              <StatTile label="Items" value={String(file.busy?.items ?? 0)} />
              <StatTile label="Vouchers" value={String(file.busy?.vouchers ?? 0)} />
              <StatTile label="New groups" value={String(file.busy?.groups ?? 0)} />
            </StatGrid>
            <Banner tone="warning" className="mt-3" title="Busy XML layout is UNVERIFIED">
              Read from real exports published by third parties (Busy does not document it): opening balances are taken as negative = Dr, and
              only vouchers with account entries import. Check the preview against Busy's trial balance.
            </Banner>
          </>
        )}
        {isBooks && file.manifest?.booksFrom && (
          <div className="mt-3">
            <Checkbox
              label={`Start this company's books in FY ${file.manifest.booksFrom} (from the workbook)`}
              hint="Only when the company has no vouchers yet"
              checked={opts.applyBooksFrom}
              onChange={(applyBooksFrom) => onOpts({ ...opts, applyBooksFrom })}
            />
          </div>
        )}
      </Panel>
      <OptionsPanel opts={opts} onOpts={onOpts} target="books" bankLedgers={[]} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>Choose a different file</Button>
        <Button variant="primary" data-testid="btn-import-preview" loading={busy} onClick={onNext}>Preview (dry run)</Button>
      </div>
    </div>
  )
}

// ---------- step 3 / 4 ----------

type Outcome = ImportRunResult['outcomes'][number]
const OUTCOME_COLUMNS = defineColumns<Outcome>([
  { id: 'line', header: 'Row', kind: 'number', value: (r) => r.line || null, width: 70 },
  { id: 'target', header: 'What', kind: 'text', value: (r) => TARGETS[r.target as keyof typeof TARGETS]?.label ?? r.target, width: 150 },
  { id: 'label', header: 'Record', kind: 'text', value: (r) => r.label, minWidth: 200 },
  {
    id: 'action', header: 'Result', kind: 'enum', value: (r) => r.action, width: 110,
    options: [{ value: 'create', label: 'Create' }, { value: 'update', label: 'Update' }, { value: 'skip', label: 'Skip' }, { value: 'error', label: 'Error' }],
    cell: (r) => <Badge tone={r.action === 'error' ? 'danger' : r.action === 'skip' ? 'neutral' : 'success'}>{r.action === 'create' ? 'Create' : r.action === 'update' ? 'Update' : r.action === 'skip' ? 'Skip' : 'Error'}</Badge>
  },
  { id: 'message', header: 'Detail', kind: 'text', value: (r) => r.message ?? '', minWidth: 260 }
])

function totals(result: ImportRunResult): { created: number; updated: number; skipped: number; errors: number } {
  return result.steps.reduce((t, s) => ({ created: t.created + s.created, updated: t.updated + s.updated, skipped: t.skipped + s.skipped, errors: t.errors + s.errors.length }), { created: 0, updated: 0, skipped: 0, errors: 0 })
}

function ResultSummary({ result, testId }: { result: ImportRunResult; testId: string }): React.JSX.Element {
  const t = totals(result)
  const oc = result.openingCheck
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <StatGrid>
        <StatTile label={result.dryRun ? 'Will create' : 'Created'} value={String(t.created)} />
        <StatTile label={result.dryRun ? 'Will update' : 'Updated'} value={String(t.updated)} />
        <StatTile label="Skipped" value={String(t.skipped)} />
        <StatTile label="Errors" value={String(t.errors)} tone={t.errors ? 'cr' : undefined} />
      </StatGrid>
      {oc && (
        <Banner tone={oc.difference === 0 ? 'success' : 'warning'} title="Opening balances" testId="import-opening-check">
          Dr {formatPaise(oc.debit, { symbol: true })} · Cr {formatPaise(oc.credit, { symbol: true })}
          {oc.stockOpening ? ` (Dr includes opening stock ${formatPaise(oc.stockOpening, { symbol: true })})` : ''}
          {oc.difference === 0 ? ' — they tie.' : ` — difference ${formatPaise(Math.abs(oc.difference), { symbol: true })} ${oc.difference > 0 ? 'Dr' : 'Cr'}.`}
        </Banner>
      )}
      {result.bank && (
        <Banner tone="info" title="Bank statement">
          {result.bank.matched} of {result.bank.statementRows} rows match vouchers in the books; {result.bank.unmatched} to reconcile in Banking.
        </Banner>
      )}
      {result.steps.flatMap((s) => s.warnings).slice(0, 6).map((w, i) => <p key={i} className="text-body-sm text-muted">• {w}</p>)}
    </div>
  )
}

async function downloadErrors(result: ImportRunResult, fileName: string, toast: ToastState): Promise<void> {
  const rows = result.steps.flatMap((s) => s.errors.map((e) => [s.sheet ?? TARGETS[s.target as keyof typeof TARGETS]?.label ?? s.target, e.line || null, e.field ?? '', e.message]))
  await xlsxReport(
    { name: 'Import errors', preamble: [`Import errors — ${fileName}`], columns: [{ header: 'Sheet / target', kind: 'text' }, { header: 'Row', kind: 'integer' }, { header: 'Field', kind: 'text' }, { header: 'Problem', kind: 'text', width: 80 }], rows },
    'import-errors',
    toast
  )
}

function PreviewStep(props: { file: ImportLoadResult; result: ImportRunResult; busy: boolean; templateName: string; onTemplateName: (s: string) => void; onBack: () => void; onImport: () => void }): React.JSX.Element {
  const toast = useToasts()
  const { result } = props
  const t = totals(result)
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <p className="mb-3 text-body-sm text-muted">This is what the import would do — nothing has been written yet.</p>
        <ResultSummary result={result} testId="import-preview-summary" />
      </Panel>
      <Panel>
        <DataTable
          viewId="import-preview"
          testId="import-preview"
          columns={OUTCOME_COLUMNS}
          rows={result.outcomes}
          rowKey={(r) => `${r.target}-${r.line}-${r.label}-${r.action}`}
          maxHeight="calc(100vh - 520px)"
          exportOptions={{ title: 'Import preview', periodLabel: props.file.fileName, footNote: result.outcomesTruncated ? `${result.outcomesTruncated} more rows not listed` : undefined }}
        />
      </Panel>
      <div className="flex flex-wrap items-end justify-end gap-2">
        {t.errors > 0 && <Button variant="ghost" onClick={() => void downloadErrors(result, props.file.fileName, toast)} data-testid="btn-import-errors">Error report (.xlsx)</Button>}
        {props.file.kind === 'table' && (
          <Field label="Remember this mapping as" className="w-60">
            <TextInput value={props.templateName} onChange={(e) => props.onTemplateName(e.target.value)} placeholder="optional name" data-testid="import-template-name" />
          </Field>
        )}
        <Button variant="ghost" onClick={props.onBack}>Back to mapping</Button>
        <Button variant="primary" data-testid="btn-import-apply" loading={props.busy} disabled={t.created + t.updated === 0 && !result.bank} onClick={props.onImport}>
          Import {t.created + t.updated} record{t.created + t.updated === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  )
}

function DoneStep({ result, onAnother }: { result: ImportRunResult; onAnother: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const qc = useQueryClient()
  const [undone, setUndone] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="success">Imported</Badge>
          {result.batchId && <span className="text-body-sm text-muted" data-testid="import-batch-id">Batch {result.batchId} · recorded in the audit trail</span>}
        </div>
        <ResultSummary result={result} testId="import-done-summary" />
      </Panel>
      <div className="flex flex-wrap justify-end gap-2">
        {totals(result).errors > 0 && <Button variant="ghost" onClick={() => void downloadErrors(result, 'import', toast)}>Error report (.xlsx)</Button>}
        {result.batchId && !undone && (
          <Button
            variant="ghost"
            data-testid="btn-import-undo"
            onClick={async () => {
              if (!window.confirm('Undo this import? Its vouchers go to the bin and unused masters it created are removed.')) return
              try {
                const u = await api.dataImport.undo(result.batchId!)
                await qc.invalidateQueries()
                setUndone(true)
                toast.push('success', `Undone: ${u.binned} binned, ${u.deleted} removed, ${u.restored} restored`)
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            Undo this import
          </Button>
        )}
        <Button variant="ghost" onClick={() => nav.go({ name: 'trial-balance' })}>Trial balance</Button>
        <Button variant="primary" onClick={onAnother} data-testid="btn-import-another">Import another file</Button>
      </div>
    </div>
  )
}
