// Banking → Import (WP 4.1): pick a statement (CSV/TXT, XLSX, MT940, CAMT.053) or paste text
// copied from a PDF, check / adjust the column mapping (remembered per bank account), import the
// new lines (duplicates skipped), then work the statement: confirm proposed matches in bulk,
// create vouchers in bulk from suggested ledgers, match / create / ignore line by line, and undo
// the last import.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ImportProfile } from '@shared/bankFormats/types'
import { DATE_FORMATS } from '@shared/bankFormats/types'
import { toDisplayDate } from '@shared/dates'
import { bankingApi, type StatementPreview, type StatementSource, type WorkspaceEntry, type WorkspaceLine } from '../../lib/bankingClient'
import { DataTable, defineColumns } from '../../components/table'
import { Badge, Banner, Button, Checkbox, EmptyState, Field, Modal, Money, Panel, Segmented, Select, StatGrid, StatTile, Textarea } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { LedgerPicker } from '../../components/pickers'
import { VoucherLink } from '../../components/links'
import { useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { DIRECTION_OPTIONS, MODAL_TABLE_FEATURES, evidenceText, pct, rupees, type MatchSettings } from './shared'

const signedRupees = (paise: number): string => `${paise < 0 ? '−' : '+'}${rupees(Math.abs(paise))}`

const FORMAT_LABEL: Record<string, string> = { csv: 'CSV / TXT', xlsx: 'Excel', mt940: 'MT940', camt053: 'CAMT.053', pasted: 'Pasted text' }

type PreviewLine = StatementPreview['lines'][number]

const PREVIEW_COLUMNS = defineColumns<PreviewLine>([
  { id: 'date', header: 'Date', kind: 'date', value: (l) => l.date, className: 'text-muted' },
  { id: 'description', header: 'Narration', kind: 'text', value: (l) => l.description, hideable: false, minWidth: 220 },
  { id: 'reference', header: 'Reference', kind: 'text', value: (l) => l.reference, width: 150, className: 'num text-muted' },
  { id: 'withdrawal', header: 'Withdrawal', kind: 'money', value: (l) => l.withdrawal, aggregate: 'sum', width: 130 },
  { id: 'deposit', header: 'Deposit', kind: 'money', value: (l) => l.deposit, aggregate: 'sum', width: 130 },
  { id: 'balance', header: 'Balance', kind: 'money', value: (l) => l.balance, width: 140, defaultHidden: true },
  {
    id: 'dup',
    header: 'Status',
    kind: 'enum',
    value: (l) => (l.duplicate ? 'duplicate' : 'new'),
    options: [{ value: 'new', label: 'New' }, { value: 'duplicate', label: 'Already imported' }],
    width: 150,
    cell: (l) => (l.duplicate ? <Badge tone="neutral">Already imported</Badge> : <Badge tone="info">New</Badge>)
  }
])

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'matched', label: 'Matched' },
  { value: 'ignored', label: 'Ignored' }
]

function entriesLabel(entries: WorkspaceEntry[]): string {
  return entries.map((e) => `${e.voucherType} ${e.number}`).join(', ')
}

function workspaceColumns(): ReturnType<typeof defineColumns<WorkspaceLine>> {
  return defineColumns<WorkspaceLine>([
    { id: 'date', header: 'Date', kind: 'date', value: (l) => l.date, className: 'text-muted', width: 104 },
    { id: 'description', header: 'Narration', kind: 'text', value: (l) => l.description, hideable: false, minWidth: 200 },
    { id: 'reference', header: 'Reference', kind: 'text', value: (l) => l.reference, width: 130, defaultHidden: true, className: 'num text-muted' },
    { id: 'side', header: 'Direction', kind: 'enum', value: (l) => l.side, options: DIRECTION_OPTIONS, defaultHidden: true, width: 120 },
    { id: 'withdrawal', header: 'Withdrawal', kind: 'money', value: (l) => (l.side === 'withdrawal' ? l.amount : 0), aggregate: 'sum', width: 122 },
    { id: 'deposit', header: 'Deposit', kind: 'money', value: (l) => (l.side === 'deposit' ? l.amount : 0), aggregate: 'sum', width: 122 },
    {
      id: 'match',
      header: 'Match / suggestion',
      kind: 'text',
      minWidth: 240,
      value: (l) =>
        l.status === 'matched'
          ? entriesLabel(l.matched)
          : l.proposal
            ? entriesLabel(l.proposal.entries)
            : l.suggestion
              ? l.suggestion.ledgerName
              : '',
      cell: (l) => {
        if (l.status === 'matched') {
          return (
            <span className="flex flex-wrap items-center gap-1" data-testid="cell-banking-matched">
              {l.matched.map((m) => (
                <VoucherLink key={m.voucherId} voucherId={m.voucherId} label={`${m.voucherType} ${m.number}`} className="text-small" />
              ))}
              {l.matched.some((m) => m.created) && <Badge tone="neutral">Created here</Badge>}
            </span>
          )
        }
        if (l.status === 'ignored') return <span className="text-hint text-muted">Ignored</span>
        if (l.proposal) {
          return (
            <span className="flex flex-col gap-0.5" data-testid="cell-banking-proposal" title={l.proposal.reasons.join(' · ')}>
              <span className="flex flex-wrap items-center gap-1">
                {l.proposal.entries.map((e) => (
                  <VoucherLink key={e.voucherId} voucherId={e.voucherId} label={`${e.voucherType} ${e.number}`} className="text-small" />
                ))}
                <Badge tone={l.proposal.ambiguous ? 'warning' : l.proposal.score >= 0.75 ? 'success' : 'info'}>
                  {l.proposal.ambiguous ? 'Check' : pct(l.proposal.score)}
                </Badge>
              </span>
              <span className="truncate text-hint text-muted">
                {l.proposal.kind === 'one_to_one' ? l.proposal.entries[0]?.particulars : l.proposal.reasons[0]}
              </span>
            </span>
          )
        }
        if (l.suggestion) {
          return (
            <span className="flex flex-col gap-0.5" data-testid="cell-banking-suggestion">
              <span className="flex flex-wrap items-center gap-1">
                <span className="rounded bg-blue/10 px-1.5 py-0.5 text-label text-blue">{l.suggestion.ledgerName}</span>
                {l.suggestion.status === 'accepted' && <Badge tone="success">Rule</Badge>}
              </span>
              <span className="text-hint text-muted" data-testid="text-banking-evidence">{evidenceText(l.suggestion)}</span>
            </span>
          )
        }
        return <span className="text-hint text-muted">No match — create or match it</span>
      }
    },
    {
      id: 'status',
      header: 'Status',
      kind: 'enum',
      value: (l) => l.status,
      options: STATUS_OPTIONS,
      width: 110,
      defaultHidden: true
    }
  ])
}

const defaultProfile = (): ImportProfile => ({
  delimiter: 'auto', encoding: 'utf-8', headerRow: 1, dateFormat: 'auto', dateCol: 0, valueDateCol: null, descCols: [1], refCol: null,
  amountMode: 'split', debitCol: 2, creditCol: 3, amountCol: null, flagCol: null, balanceCol: null, signedNegativeIsDeposit: false
})

export function ImportTab({ bankLedgerId, bankName, settings }: { bankLedgerId: number; bankName: string; settings: MatchSettings }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [source, setSource] = useState<StatementSource | null>(null)
  const [preview, setPreview] = useState<StatementPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [createFor, setCreateFor] = useState<WorkspaceLine[] | null>(null)
  const [matchFor, setMatchFor] = useState<WorkspaceLine | null>(null)

  const wsKey = ['bankWorkspace', bankLedgerId, showDone, settings.tolerancePaise, settings.dateWindowDays, settings.minSuggest]
  const { data: ws, isLoading } = useQuery({
    queryKey: wsKey,
    queryFn: () =>
      bankingApi.import.workspace(bankLedgerId, {
        includeDone: showDone,
        options: { amountTolerance: settings.tolerancePaise, dateWindowDays: settings.dateWindowDays },
        minSuggestScore: settings.minSuggest
      })
  })
  const columns = useMemo(() => workspaceColumns(), [])

  // Pre-select confident proposals each time the workspace changes.
  const lastWs = useRef<typeof ws>(undefined)
  useEffect(() => {
    if (!ws || lastWs.current === ws) return
    lastWs.current = ws
    setPicked(new Set(ws.lines.filter((l) => l.status === 'open' && l.proposal && !l.proposal.ambiguous && l.proposal.score >= settings.autoSelect).map((l) => l.id)))
  }, [ws, settings.autoSelect])

  const refresh = (): Promise<unknown> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['bankWorkspace'] }),
      queryClient.invalidateQueries({ queryKey: ['bankRecon'] }),
      queryClient.invalidateQueries({ queryKey: ['brs'] }),
      queryClient.invalidateQueries({ queryKey: ['bankLearned'] })
    ])

  const runPreview = async (src: StatementSource): Promise<void> => {
    setBusy(true)
    try {
      const p = await bankingApi.import.preview(bankLedgerId, src)
      setSource(src)
      setPreview(p)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async (): Promise<void> => {
    try {
      const f = await bankingApi.import.pickFile()
      if (!f) return
      await runPreview({ fileName: f.fileName, base64: f.base64 })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const commit = async (): Promise<void> => {
    if (!source || !preview) return
    setBusy(true)
    try {
      const res = await bankingApi.import.commit(bankLedgerId, { ...source, format: preview.format, profile: preview.profile })
      toast.push(res.inserted > 0 ? 'success' : 'warning', `${res.inserted} new statement ${res.inserted === 1 ? 'line' : 'lines'} imported${res.duplicates ? ` · ${res.duplicates} already imported, skipped` : ''}`)
      setPreview(null)
      setSource(null)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const lines = ws?.lines ?? []
  const open = lines.filter((l) => l.status === 'open')
  const selected = lines.filter((l) => picked.has(l.id))
  const toConfirm = selected.filter((l) => l.status === 'open' && l.proposal)
  const toCreate = selected.filter((l) => l.status === 'open' && !l.proposal && l.suggestion)

  const confirmSelected = async (): Promise<void> => {
    // Group proposals that span several lines are confirmed once.
    const seen = new Set<string>()
    const groups = toConfirm.flatMap((l) => {
      const key = l.proposal!.lineIds.join(',')
      if (seen.has(key)) return []
      seen.add(key)
      return [{ lineIds: l.proposal!.lineIds, voucherIds: l.proposal!.entries.map((e) => e.voucherId) }]
    })
    try {
      const r = await bankingApi.import.confirm(bankLedgerId, groups, settings.tolerancePaise)
      toast.push('success', `${r.confirmed} statement ${r.confirmed === 1 ? 'line' : 'lines'} reconciled`)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const createSelected = async (): Promise<void> => {
    try {
      const r = await bankingApi.import.createVouchers(
        bankLedgerId,
        toCreate.map((l) => ({
          lineId: l.id,
          ledgerId: l.suggestion!.ledgerId,
          partyLedgerId: l.suggestion!.partyLedgerId,
          narration: l.suggestion!.narration,
          source: { kind: l.suggestion!.source, ruleId: l.suggestion!.ruleId }
        }))
      )
      if (r.created.length) toast.push('success', `${r.created.length} ${r.created.length === 1 ? 'voucher' : 'vouchers'} created and reconciled`)
      if (r.failed.length) toast.push('error', `${r.failed.length} could not be created: ${r.failed[0]!.error}`)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const ignore = async (l: WorkspaceLine, ignored: boolean): Promise<void> => {
    try {
      await bankingApi.import.ignore(bankLedgerId, l.id, ignored)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const unmatch = async (l: WorkspaceLine): Promise<void> => {
    try {
      await bankingApi.import.unmatch(bankLedgerId, l.id)
      toast.push('success', 'Match undone — the bank date is back to what it was')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const latest = ws?.imports[0]
  const undo = async (): Promise<void> => {
    if (!latest) return
    const ok = await confirmDialog({
      title: 'Undo last import',
      message: `Remove the ${latest.lineCount} lines of “${latest.fileName || 'the last statement'}” (imported ${latest.importedAt.slice(0, 16)})? ${latest.created} ${latest.created === 1 ? 'voucher' : 'vouchers'} created from it go to the bin and ${latest.matched - latest.created} confirmed ${latest.matched - latest.created === 1 ? 'match is' : 'matches are'} undone.`,
      confirmLabel: 'Undo import',
      danger: true
    })
    if (!ok) return
    try {
      const r = await bankingApi.import.undo(bankLedgerId, latest.id)
      toast.push('success', `Import undone: ${r.removedLines} lines removed, ${r.binned} vouchers binned, ${r.unmatched} matches undone`)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (preview && source) {
    return (
      <PreviewPanel
        bankName={bankName}
        preview={preview}
        busy={busy}
        onRemap={(profile) => void runPreview({ ...source, format: preview.format, profile })}
        onCancel={() => {
          setPreview(null)
          setSource(null)
        }}
        onCommit={() => void commit()}
      />
    )
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" data-testid="btn-banking-pick-statement" disabled={busy} onClick={() => void pickFile()}>
          Choose statement file…
        </Button>
        <Button data-testid="btn-banking-paste-statement" onClick={() => setPasteOpen(true)}>
          Paste text from a PDF…
        </Button>
        <span className="text-hint text-muted">CSV / TXT, Excel (.xlsx), MT940, CAMT.053 — the column mapping is remembered for {bankName}.</span>
        <span className="flex-1" />
        {latest && (
          <Button variant="ghost" data-testid="btn-banking-undo-import" onClick={() => void undo()}>
            Undo last import
          </Button>
        )}
      </div>

      <StatGrid className="mb-3">
        <StatTile label="Open statement lines" value={String(open.length)} />
        <StatTile label="Proposed matches" value={String(open.filter((l) => l.proposal).length)} />
        <StatTile label="With a suggested ledger" value={String(open.filter((l) => !l.proposal && l.suggestion).length)} />
        <StatTile label="Imports" value={String(ws?.imports.length ?? 0)} hint={latest ? `Last: ${latest.fileName || '—'}` : undefined} />
      </StatGrid>

      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="banking-statement-actions">
        <span className="text-detail text-muted">{selected.length ? `${selected.length} ticked` : 'Tick lines to act on them together'}</span>
        <span className="flex-1" />
        <Button size="sm" variant="primary" disabled={toConfirm.length === 0} data-testid="btn-banking-confirm-matches" onClick={() => void confirmSelected()}>
          Confirm {toConfirm.length || ''} {toConfirm.length === 1 ? 'match' : 'matches'}
        </Button>
        <Button size="sm" disabled={toCreate.length === 0} data-testid="btn-banking-create-vouchers" onClick={() => void createSelected()}>
          Create {toCreate.length || ''} suggested {toCreate.length === 1 ? 'voucher' : 'vouchers'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={open.filter((l) => !l.proposal).length === 0}
          data-testid="btn-banking-create-picked"
          onClick={() => setCreateFor(selected.filter((l) => l.status === 'open' && !l.proposal).length ? selected.filter((l) => l.status === 'open' && !l.proposal) : open.filter((l) => !l.proposal))}
        >
          Create with a ledger…
        </Button>
      </div>
      <Panel>
        <DataTable
          viewId="banking-statement"
          testId="banking-statement"
          ariaLabel="Statement lines"
          columns={columns}
          rows={lines}
          rowKey={(l) => l.id}
          rowAttrs={(l) => ({ 'data-row-id': l.id, 'data-status': l.status, 'data-has-proposal': l.proposal ? '1' : '0', 'data-has-suggestion': l.suggestion ? '1' : '0' })}
          rowClassName={(l) => (l.status !== 'open' ? 'text-muted' : '')}
          loading={isLoading}
          maxHeight="56vh"
          empty={{
            title: showDone ? 'No statement lines yet' : 'Nothing left to reconcile',
            hint: 'Choose a statement file (or paste text from a PDF) to import its lines'
          }}
          leadingWidth={40}
          leading={(l) =>
            l.status === 'open' && (l.proposal || l.suggestion) ? (
              <input
                type="checkbox"
                aria-label={`Select statement line ${l.description}`}
                data-testid="input-banking-line-pick"
                checked={picked.has(l.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(l.id)
                    else next.delete(l.id)
                    return next
                  })
                }
              />
            ) : null
          }
          trailingWidth={64}
          trailing={(l) => (
            <MenuButton
              label={`Actions for ${l.description}`}
              testId={`banking-line-actions-${l.id}`}
              className="px-1.5 text-muted hover:text-ink"
              items={
                l.status === 'matched'
                  ? [{ label: 'Undo match', onSelect: () => void unmatch(l), testId: 'banking-line-unmatch' }]
                  : l.status === 'ignored'
                    ? [{ label: 'Restore', onSelect: () => void ignore(l, false), testId: 'banking-line-restore' }]
                    : [
                        { label: 'Match to book entries…', onSelect: () => setMatchFor(l), testId: 'banking-line-match' },
                        { label: 'Create voucher…', onSelect: () => setCreateFor([l]), testId: 'banking-line-create' },
                        { label: 'Ignore (bank-only line)', onSelect: () => void ignore(l, true), testId: 'banking-line-ignore' }
                      ]
              }
            >
              ⋯
            </MenuButton>
          )}
          toolbarStart={
            <label className="flex items-center gap-2 text-small text-muted">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} data-testid="input-banking-show-done" />
              Show matched &amp; ignored
            </label>
          }
          exportOptions={{ title: `Bank statement lines — ${bankName}`, periodLabel: toDisplayDate(new Date().toISOString().slice(0, 10)), filename: 'bank-statement-lines' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Ticked rows: proposals are confirmed (bank date set on the voucher); suggestions become vouchers through the normal voucher checks. Every confirmed match teaches the suggestions.
      </p>

      {pasteOpen && (
        <PasteModal
          onClose={() => setPasteOpen(false)}
          onPreview={(text) => {
            setPasteOpen(false)
            void runPreview({ fileName: 'Pasted from PDF', text, format: 'pasted' })
          }}
        />
      )}
      {createFor && (
        <CreateModal
          bankLedgerId={bankLedgerId}
          lines={createFor}
          onClose={() => setCreateFor(null)}
          onDone={() => {
            setCreateFor(null)
            void refresh()
          }}
        />
      )}
      {matchFor && ws && (
        <MatchModal
          bankLedgerId={bankLedgerId}
          line={matchFor}
          entries={ws.openEntries}
          tolerance={settings.tolerancePaise}
          onClose={() => setMatchFor(null)}
          onDone={() => {
            setMatchFor(null)
            void refresh()
          }}
        />
      )}
    </>
  )
}

// ---------- preview + mapping ----------

function PreviewPanel({
  bankName,
  preview,
  busy,
  onRemap,
  onCancel,
  onCommit
}: {
  bankName: string
  preview: StatementPreview
  busy: boolean
  onRemap: (p: ImportProfile) => void
  onCancel: () => void
  onCommit: () => void
}): React.JSX.Element {
  const tabular = preview.format === 'csv' || preview.format === 'xlsx'
  const [profile, setProfile] = useState<ImportProfile>(preview.profile ?? defaultProfile())
  useEffect(() => setProfile(preview.profile ?? defaultProfile()), [preview])
  const grid = preview.grid ?? []
  const width = Math.max(0, ...grid.map((r) => r.length))
  const colOptions = Array.from({ length: width }, (_, i) => {
    const head = profile.headerRow > 0 ? (grid[profile.headerRow - 1]?.[i] ?? '').trim() : ''
    return { value: String(i), label: `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}${head ? ` · ${head.slice(0, 24)}` : ''}` }
  })
  const set = <K extends keyof ImportProfile>(k: K, v: ImportProfile[K]): void => setProfile((p) => ({ ...p, [k]: v }))
  const colSelect = (label: string, key: 'dateCol' | 'valueDateCol' | 'refCol' | 'debitCol' | 'creditCol' | 'amountCol' | 'flagCol' | 'balanceCol', optional: boolean): React.JSX.Element => (
    <Field label={label}>
      <Select
        value={profile[key] == null ? '' : String(profile[key])}
        data-testid={`input-banking-map-${key}`}
        onChange={(e) => set(key, (e.target.value === '' ? null : Number(e.target.value)) as never)}
      >
        {optional && <option value="">—</option>}
        {colOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  )
  const dirty = JSON.stringify(profile) !== JSON.stringify(preview.profile ?? null)

  return (
    <div className="flex flex-col gap-3" data-testid="banking-import-preview">
      <Panel className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold text-ink">{preview.fileName}</span>
          <Badge tone="info">{FORMAT_LABEL[preview.format] ?? preview.format}</Badge>
          {preview.profileSource === 'saved' && <Badge tone="success" testId="chip-banking-profile-saved">Saved mapping for {bankName}</Badge>}
          {preview.profileSource === 'detected' && <Badge tone="neutral">Mapping detected</Badge>}
          {preview.account && <span className="text-hint text-muted">Account {preview.account}</span>}
        </div>
        {preview.warnings.map((w) => (
          <Banner key={w} tone="warning" className="mb-2">
            {w}
          </Banner>
        ))}
        {preview.format === 'pasted' && (
          <Banner tone="info" className="mb-2">
            Read from copied text: dates start a line, the last amounts are the transaction and the running balance. Check the directions below before importing.
          </Banner>
        )}

        {tabular && (
          <>
            <div className="mb-3 overflow-x-auto rounded-md border border-line" data-testid="banking-import-grid">
              <table className="w-full text-caption">
                <thead>
                  <tr className="bg-panel2 text-muted">
                    <th className="px-2 py-1 text-left">Row</th>
                    {colOptions.map((o) => (
                      <th key={o.value} className="px-2 py-1 text-left font-medium">
                        {o.label.split(' · ')[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.slice(0, 10).map((r, i) => (
                    <tr key={i} className={i + 1 === profile.headerRow ? 'bg-amberbar/10 font-medium' : 'border-t border-line/50'}>
                      <td className="num px-2 py-0.5 text-muted">{i + 1}</td>
                      {colOptions.map((o) => (
                        <td key={o.value} className="max-w-[180px] truncate px-2 py-0.5 text-ink" title={r[Number(o.value)] ?? ''}>
                          {r[Number(o.value)] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-6 gap-3">
              <Field label="Header row">
                <Select value={String(profile.headerRow)} data-testid="input-banking-map-headerRow" onChange={(e) => set('headerRow', Number(e.target.value))}>
                  <option value="0">No header</option>
                  {grid.slice(0, 30).map((_, i) => (
                    <option key={i} value={String(i + 1)}>
                      Row {i + 1}
                    </option>
                  ))}
                </Select>
              </Field>
              {colSelect('Date', 'dateCol', false)}
              <Field label="Date format">
                <Select value={profile.dateFormat} data-testid="input-banking-map-dateFormat" onChange={(e) => set('dateFormat', e.target.value as ImportProfile['dateFormat'])}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'auto' ? 'Auto (day first)' : f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Narration">
                <Select
                  value={profile.descCols[0] == null ? '' : String(profile.descCols[0])}
                  data-testid="input-banking-map-descCol"
                  onChange={(e) => set('descCols', e.target.value === '' ? [] : [Number(e.target.value), ...profile.descCols.slice(1)])}
                >
                  <option value="">—</option>
                  {colOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {colSelect('Reference / cheque', 'refCol', true)}
              {colSelect('Balance', 'balanceCol', true)}
            </div>
            <div className="mt-3 grid grid-cols-6 items-end gap-3">
              <div className="col-span-2">
                <Field label="Amounts">
                  <Segmented
                    label="Amount columns"
                    testId="input-banking-map-amountMode"
                    size="sm"
                    value={profile.amountMode}
                    options={[
                      { value: 'split', label: 'Debit + credit' },
                      { value: 'signed', label: 'One signed' },
                      { value: 'flag', label: 'Amount + Dr/Cr' }
                    ]}
                    onChange={(v) => set('amountMode', v)}
                  />
                </Field>
              </div>
              {profile.amountMode === 'split' ? (
                <>
                  {colSelect('Withdrawal (debit)', 'debitCol', true)}
                  {colSelect('Deposit (credit)', 'creditCol', true)}
                </>
              ) : (
                <>
                  {colSelect('Amount', 'amountCol', true)}
                  {profile.amountMode === 'flag' ? (
                    colSelect('Dr / Cr column', 'flagCol', true)
                  ) : (
                    <Checkbox label="Negative = deposit" checked={profile.signedNegativeIsDeposit} onChange={(v) => set('signedNegativeIsDeposit', v)} />
                  )}
                </>
              )}
              {preview.format === 'csv' && (
                <>
                  <Field label="Delimiter">
                    <Select value={profile.delimiter} onChange={(e) => set('delimiter', e.target.value as ImportProfile['delimiter'])}>
                      <option value="auto">Automatic</option>
                      <option value=",">Comma</option>
                      <option value=";">Semicolon</option>
                      <option value={'\t'}>Tab</option>
                      <option value="|">Pipe</option>
                    </Select>
                  </Field>
                  <Field label="Encoding">
                    <Select value={profile.encoding} onChange={(e) => set('encoding', e.target.value as ImportProfile['encoding'])}>
                      <option value="utf-8">UTF-8</option>
                      <option value="utf-16le">UTF-16</option>
                      <option value="windows-1252">Windows-1252</option>
                    </Select>
                  </Field>
                </>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="sm" disabled={!dirty || busy} data-testid="btn-banking-apply-mapping" onClick={() => onRemap(profile)}>
                Apply mapping
              </Button>
            </div>
          </>
        )}
      </Panel>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="New lines" value={String(preview.newCount)} />
        <StatTile label="Already imported" value={String(preview.duplicateCount)} hint="Same date, amount and narration as a line imported before" />
        <StatTile label="Net (deposits − withdrawals)" value={signedRupees(preview.lines.reduce((s, l) => s + l.deposit - l.withdrawal, 0))} />
      </div>

      <Panel>
        <DataTable
          testId="banking-import-lines"
          ariaLabel="Statement lines to import"
          columns={PREVIEW_COLUMNS}
          rows={preview.lines}
          rowKey={(l) => l.lineNo}
          rowClassName={(l) => (l.duplicate ? 'text-muted' : '')}
          toolbarFeatures={MODAL_TABLE_FEATURES}
          maxHeight="40vh"
          empty={{ title: 'No statement lines read', hint: tabular ? 'Adjust the mapping above' : 'Check the file' }}
        />
      </Panel>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={busy || preview.newCount === 0 || dirty} data-testid="btn-banking-commit-import" onClick={onCommit}>
          {dirty ? 'Apply the mapping first' : preview.newCount === 0 ? 'Nothing new to import' : `Import ${preview.newCount} ${preview.newCount === 1 ? 'line' : 'lines'}`}
        </Button>
      </div>
    </div>
  )
}

function PasteModal({ onClose, onPreview }: { onClose: () => void; onPreview: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste text from a PDF statement" onClose={onClose} wide dirty={text.trim().length > 0}>
      <div className="flex flex-col gap-3">
        <p className="text-hint text-muted">
          Open the statement PDF, select the transaction rows, copy, and paste them here. Scanned (image-only) PDFs have no text to copy — ask the bank for a CSV or Excel download instead.
        </p>
        <Textarea
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="input-banking-paste"
          placeholder={'02/08/26  NEFT CR-ACME TRADERS  25,000.00  1,75,000.00\n03/08/26  UPI-RAVI KUMAR-RENT  18,000.00  1,57,000.00'}
          className="num text-small"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} data-testid="btn-banking-paste-preview" onClick={() => onPreview(text)}>
            Preview
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function CreateModal({
  bankLedgerId,
  lines,
  onClose,
  onDone
}: {
  bankLedgerId: number
  lines: WorkspaceLine[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [ledgerId, setLedgerId] = useState<number | null>(lines.length === 1 ? (lines[0]!.suggestion?.ledgerId ?? null) : null)
  const [narration, setNarration] = useState(lines.length === 1 ? (lines[0]!.suggestion?.narration ?? lines[0]!.description) : '')
  const [saving, setSaving] = useState(false)
  const total = lines.reduce((s, l) => s + (l.side === 'deposit' ? l.amount : -l.amount), 0)
  const save = async (): Promise<void> => {
    if (ledgerId == null) return void toast.push('error', 'Pick the ledger for the other side')
    setSaving(true)
    try {
      const r = await bankingApi.import.createVouchers(
        bankLedgerId,
        lines.map((l) => ({
          lineId: l.id,
          ledgerId,
          narration: lines.length === 1 ? narration : null,
          source: l.suggestion && l.suggestion.ledgerId === ledgerId ? { kind: l.suggestion.source, ruleId: l.suggestion.ruleId } : null
        }))
      )
      if (r.failed.length) toast.push('error', `${r.failed.length} not created: ${r.failed[0]!.error}`)
      if (r.created.length) toast.push('success', `${r.created.length} ${r.created.length === 1 ? 'voucher' : 'vouchers'} created and reconciled`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }
  return (
    <Modal title={lines.length === 1 ? 'Create voucher from statement line' : `Create ${lines.length} vouchers`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-detail text-ink">
          {lines.length === 1 ? (
            <>
              {toDisplayDate(lines[0]!.date)} · {lines[0]!.description} · <Money paise={lines[0]!.amount} />
            </>
          ) : (
            <>
              {lines.length} lines, net <Money paise={total} signed />
            </>
          )}
        </p>
        <Field label="Other side (ledger)" hint="Payment for a withdrawal, receipt for a deposit, contra when it is another bank or cash account.">
          <LedgerPicker value={ledgerId} onPick={setLedgerId} testId="picker-banking-create-ledger" />
        </Field>
        {lines.length === 1 && (
          <Field label="Narration">
            <Textarea rows={2} value={narration} onChange={(e) => setNarration(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-banking-create-save" onClick={() => void save()}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const ENTRY_COLUMNS = defineColumns<WorkspaceEntry>([
  { id: 'date', header: 'Date', kind: 'date', value: (e) => e.date, className: 'text-muted' },
  { id: 'number', header: 'Voucher', kind: 'text', value: (e) => `${e.voucherType} ${e.number}`, width: 150 },
  { id: 'particulars', header: 'Particulars', kind: 'text', value: (e) => e.particulars, minWidth: 160 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (e) => e.amount, width: 130 }
])

function MatchModal({
  bankLedgerId,
  line,
  entries,
  tolerance,
  onClose,
  onDone
}: {
  bankLedgerId: number
  line: WorkspaceLine
  entries: WorkspaceEntry[]
  tolerance: number
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const sideEntries = useMemo(
    () =>
      entries.filter(
        (e) => e.side === line.side && Math.abs(Date.parse(e.date) - Date.parse(line.date)) <= 45 * 86_400_000
      ),
    [entries, line]
  )
  const sum = sideEntries.filter((e) => chosen.has(e.voucherId)).reduce((s, e) => s + e.amount, 0)
  const diff = line.amount - sum
  const save = async (): Promise<void> => {
    try {
      await bankingApi.import.confirm(bankLedgerId, [{ lineIds: [line.id], voucherIds: [...chosen] }], tolerance)
      toast.push('success', 'Matched and reconciled')
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title="Match statement line to book entries" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <p className="text-detail text-ink">
          {toDisplayDate(line.date)} · {line.description} · <Money paise={line.amount} /> {line.side === 'deposit' ? 'deposit' : 'withdrawal'}
        </p>
        <div className="overflow-hidden rounded-md border border-line">
          <DataTable
            testId="banking-match-entries"
            ariaLabel="Open book entries"
            columns={ENTRY_COLUMNS}
            rows={sideEntries}
            rowKey={(e) => e.voucherId}
            toolbarFeatures={MODAL_TABLE_FEATURES}
            maxHeight="40vh"
            empty={{ title: 'No open entries on this side within 45 days', hint: 'Create a voucher from the line instead' }}
            leadingWidth={40}
            leading={(e) => (
              <input
                type="checkbox"
                aria-label={`Select ${e.voucherType} ${e.number}`}
                data-testid="input-banking-entry-pick"
                checked={chosen.has(e.voucherId)}
                onClick={(ev) => ev.stopPropagation()}
                onChange={(ev) =>
                  setChosen((s) => {
                    const next = new Set(s)
                    if (ev.target.checked) next.add(e.voucherId)
                    else next.delete(e.voucherId)
                    return next
                  })
                }
              />
            )}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-detail ${Math.abs(diff) <= tolerance ? 'text-success' : 'text-muted'}`} data-testid="text-banking-match-diff">
            Selected {rupees(sum)} · {diff === 0 ? 'amounts agree' : `difference ${rupees(Math.abs(diff))}`}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={chosen.size === 0 || Math.abs(diff) > tolerance} data-testid="btn-banking-match-save" onClick={() => void save()}>
              Match
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

export function ImportEmpty(): React.JSX.Element {
  return <EmptyState title="Pick a bank account" hint="Statements are imported per bank account" />
}
