import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BUILTIN_PACK_KEYS, BUILTIN_PACK_REPORTS, PACK_FORMATS, PACK_FREQUENCIES, PACK_FREQUENCY_LABELS, PACK_PERIOD_LABELS, PACK_PERIOD_RULES,
  type PackInputPayload, type PackReportRef, type PackRun, type ReportPack
} from '@shared/reportBuilder/packs'
import { toDisplayDate, toDisplayDateTime } from '@shared/dates'
import { reportsApi } from '../../lib/reportsClient'
import { useSavedReports } from '../../lib/pinnedReports'
import { useSession, useToasts } from '../../state/stores'
import { Banner, Button, Checkbox, Field, Modal, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { confirmDialog } from '../../lib/dialogs'

const refKey = (r: PackReportRef): string => (r.kind === 'builtin' ? `b:${r.key}` : `s:${r.id}`)

const RUN_COLUMNS = defineColumns<PackRun & { packName: string }>([
  { id: 'started', header: 'Run at', kind: 'text', value: (r) => r.startedAt, text: (r) => toDisplayDateTime(new Date(r.startedAt)), width: 150 },
  { id: 'pack', header: 'Pack', kind: 'text', value: (r) => r.packName, minWidth: 140 },
  { id: 'trigger', header: 'Trigger', kind: 'enum', value: (r) => r.trigger, options: [{ value: 'schedule', label: 'Scheduled' }, { value: 'manual', label: 'Run now' }], width: 110 },
  { id: 'period', header: 'Period', kind: 'text', value: (r) => r.periodFrom, text: (r) => `${toDisplayDate(r.periodFrom)} → ${toDisplayDate(r.periodTo)}`, width: 190 },
  { id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, options: [{ value: 'ok', label: 'OK' }, { value: 'partial', label: 'Partial' }, { value: 'failed', label: 'Failed' }], width: 100 },
  { id: 'files', header: 'Files', kind: 'number', value: (r) => r.files.length, width: 80 },
  { id: 'error', header: 'Problems', kind: 'text', value: (r) => r.error ?? '', className: 'text-danger', minWidth: 160 }
])

/** Settings → Scheduled packs (WP 6.2): report packs written to a folder on a schedule. */
export function PacksSection(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const canEdit = useSession((s) => s.user?.role !== 'viewer')
  const { data: packs, isLoading } = useQuery({ queryKey: ['reportPacks'], queryFn: reportsApi.packs })
  const { data: runs, isLoading: runsLoading } = useQuery({ queryKey: ['reportPackRuns'], queryFn: () => reportsApi.packRuns() })
  const [editing, setEditing] = useState<ReportPack | 'new' | null>(null)
  const [running, setRunning] = useState<number | null>(null)
  const names = new Map((packs ?? []).map((p) => [p.id, p.name]))

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['reportPacks'] })
    await qc.invalidateQueries({ queryKey: ['reportPackRuns'] })
  }
  const runNow = async (p: ReportPack): Promise<void> => {
    setRunning(p.id)
    try {
      const r = await reportsApi.runPackNow(p.id)
      await refresh()
      if (r.status === 'ok') toast.push('success', `“${p.name}”: ${r.files.length} files written to ${r.outputDir}`)
      else toast.push('error', `“${p.name}” ran with problems: ${r.error ?? r.status}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setRunning(null)
    }
  }
  const remove = async (p: ReportPack): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete pack', message: `Delete the pack “${p.name}” and its run log? Files already written stay where they are.`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await reportsApi.deletePack(p.id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div>
      <SectionTitle right={canEdit && <Button variant="primary" onClick={() => setEditing('new')} data-testid="btn-packs-new">New pack</Button>}>Scheduled packs</SectionTitle>
      <p className="mb-3 text-body-sm text-muted">
        A pack writes a set of reports — built-in statements and your saved builder reports — as PDF and CSV into a folder, for a period like last month.
        Packs run when the company is opened (a run missed while the app was closed happens once) and hourly while it stays open. XLSX output arrives with the Excel work package.
      </p>
      <Panel className="mb-section">
        {isLoading ? null : (packs ?? []).length === 0 ? (
          <p className="p-5 text-detail text-muted" data-testid="packs-empty">No packs yet.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="rows-packs">
            {(packs ?? []).map((p) => (
              <li key={p.id} className="flex items-center gap-4 px-4 py-3" data-row-id={p.id}>
                <div className="min-w-0 flex-1">
                  <p className="text-detail font-medium">{p.name}{!p.active && <span className="ml-2 text-caption text-muted">(paused)</span>}</p>
                  <p className="text-small text-muted">
                    {PACK_FREQUENCY_LABELS[p.frequency]} · {PACK_PERIOD_LABELS[p.periodRule]} · {p.reports.length} report{p.reports.length === 1 ? '' : 's'} · {p.formats.map((f) => f.toUpperCase()).join(' + ')}
                    {' · '}{p.lastRunAt ? `last run ${toDisplayDateTime(new Date(p.lastRunAt))}` : 'not run yet'}{p.active ? ` · next ${toDisplayDate(p.nextDue)}` : ''}
                  </p>
                  <p className="num truncate text-hint text-muted">{p.outputDir ?? 'Company exports folder → packs'}</p>
                </div>
                {canEdit && (
                  <>
                    <Button size="sm" onClick={() => void runNow(p)} loading={running === p.id} data-testid={`btn-pack-run-${p.id}`}>Run now</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(p)}>Delete</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <SectionTitle as="h3">Run log</SectionTitle>
      <Panel>
        <DataTable
          testId="pack-runs"
          ariaLabel="Report pack runs"
          columns={RUN_COLUMNS}
          rows={(runs ?? []).map((r) => ({ ...r, packName: names.get(r.packId) ?? `#${r.packId}` }))}
          rowKey={(r) => r.id}
          loading={runsLoading}
          empty={{ title: 'No runs yet', hint: 'Run a pack now, or wait for its schedule' }}
          onRowActivate={(r) => void reportsApi.revealRun(r.id).catch((err: Error) => toast.push('error', err.message))}
          maxHeight="40vh"
          exportOptions={{ title: 'Report pack runs', periodLabel: '', filename: 'report-pack-runs' }}
        />
      </Panel>
      {editing && <PackModal pack={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}

function PackModal({ pack, onClose, onSaved }: { pack: ReportPack | null; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const { data: saved } = useSavedReports()
  const [form, setForm] = useState<PackInputPayload>(() =>
    pack
      ? { name: pack.name, reports: pack.reports, periodRule: pack.periodRule, frequency: pack.frequency, formats: pack.formats, outputDir: pack.outputDir, active: pack.active }
      : { name: '', reports: [{ kind: 'builtin', key: 'trialBalance' }, { kind: 'builtin', key: 'profitLoss' }, { kind: 'builtin', key: 'balanceSheet' }], periodRule: 'lastMonth', frequency: 'monthly', formats: ['pdf', 'csv'], outputDir: null, active: true }
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const has = (r: PackReportRef): boolean => form.reports.some((x) => refKey(x) === refKey(r))
  const toggle = (r: PackReportRef, on: boolean): void =>
    setForm({ ...form, reports: on ? [...form.reports, r] : form.reports.filter((x) => refKey(x) !== refKey(r)) })

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await reportsApi.savePack(form, pack?.id)
      await onSaved()
      toast.push('success', pack ? 'Pack saved' : `Pack “${form.name}” created`)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={pack ? `Edit pack — ${pack.name}` : 'New report pack'} onClose={onClose} wide dirty>
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-pack-name" autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period">
            <Select value={form.periodRule} onChange={(e) => setForm({ ...form, periodRule: e.target.value as PackInputPayload['periodRule'] })} data-testid="input-pack-period">
              {PACK_PERIOD_RULES.map((r) => <option key={r} value={r}>{PACK_PERIOD_LABELS[r]}</option>)}
            </Select>
          </Field>
          <Field label="Runs">
            <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as PackInputPayload['frequency'] })} data-testid="input-pack-frequency">
              {PACK_FREQUENCIES.map((f) => <option key={f} value={f}>{PACK_FREQUENCY_LABELS[f]}</option>)}
            </Select>
          </Field>
        </div>
        <div>
          <span className="mb-1 block text-detail text-ink">Reports</span>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1" data-testid="input-pack-reports">
            {BUILTIN_PACK_KEYS.map((k) => (
              <Checkbox key={k} label={BUILTIN_PACK_REPORTS[k]} checked={has({ kind: 'builtin', key: k })} onChange={(on) => toggle({ kind: 'builtin', key: k }, on)} testId={`input-pack-builtin-${k}`} />
            ))}
            {(saved ?? []).filter((r) => r.model).map((r) => (
              <Checkbox key={r.id} label={<>{r.name} <span className="text-caption text-muted">(saved report)</span></>} checked={has({ kind: 'saved', id: r.id })} onChange={(on) => toggle({ kind: 'saved', id: r.id }, on)} testId={`input-pack-saved-${r.id}`} />
            ))}
          </div>
        </div>
        <div className="flex gap-4">
          {PACK_FORMATS.map((f) => (
            <Checkbox key={f} label={f.toUpperCase()} checked={(form.formats ?? []).includes(f)} onChange={(on) => setForm({ ...form, formats: on ? [...(form.formats ?? []), f] : (form.formats ?? []).filter((x) => x !== f) })} testId={`input-pack-format-${f}`} />
          ))}
        </div>
        <Field label="Output folder" hint="Blank = the company’s exports folder, under packs/. Each run writes a sub-folder per pack and period.">
          <div className="flex gap-2">
            <TextInput value={form.outputDir ?? ''} placeholder="Company exports folder" onChange={(e) => setForm({ ...form, outputDir: e.target.value.trim() || null })} data-testid="input-pack-folder" />
            <Button
              onClick={async () => {
                const dir = await reportsApi.chooseFolder()
                if (dir) setForm({ ...form, outputDir: dir })
              }}
            >
              Choose…
            </Button>
          </div>
        </Field>
        <Checkbox label="Active (runs on its schedule)" checked={form.active ?? true} onChange={(active) => setForm({ ...form, active })} testId="input-pack-active" />
        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} data-testid="btn-pack-save">Save pack</Button>
        </div>
      </div>
    </Modal>
  )
}
