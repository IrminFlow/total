import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BackupInfo, type IntegrityResult } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, EmptyState, Field, Modal, Panel, SectionTitle, TextInput } from '../../components/ui'
import { toDisplayDate, toDisplayDateTime } from '@shared/dates'
import { Database, HardDrives, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import { passphraseSchema } from '@shared/schemas'
import { recordCohortEvent } from '../../lib/commercialOps'

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatMtime(mtime: number): string {
  return toDisplayDateTime(new Date(mtime))
}

interface RestoreResult {
  locked: boolean
  integrity: IntegrityResult
  dateLabel: string
}

export function BackupsSection(): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
  const destinations = useQuery({ queryKey: ['backup-destinations'], queryFn: api.backups.destinations })
  const drills = useQuery({ queryKey: ['backup-drills'], queryFn: api.backups.drills })
  const rotation = useQuery({ queryKey: ['backup-rotation'], queryFn: api.backups.rotation })
  const { user, setUser, setLocked, setIntegrityWarning } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [runningBackup, setRunningBackup] = useState(false)
  const [destinationName, setDestinationName] = useState('External backup')
  const rows = data ?? []
  // A company with no user rows is intentionally unlocked; its local operator has owner-level
  // access until they enable PIN users. Keep the visible controls aligned with the IPC policy.
  const isOwner = user == null || user.role === 'owner'
  const canBackup = user == null || user.role !== 'viewer'

  // Runs FULLY and UNCONDITIONALLY, synchronously with the restore response — nothing here is
  // deferred for later acknowledgment. A restore very often also flips `locked`, which unmounts
  // whatever's showing this screen (Settings) in the same render batch; any component-local
  // "wait for the user to dismiss a warning first" state would be discarded right along with it.
  // The integrity warning itself is pushed to the session store instead of shown inline — see
  // App.tsx, which renders it once, above both the locked and unlocked layouts, so no navigation
  // or unmount can make it disappear before it's dismissed.
  const commitRestore = async (result: RestoreResult): Promise<void> => {
    if (result.locked) {
      setUser(null)
      setLocked(true)
    }
    await queryClient.invalidateQueries()
    toast.push('success', 'Backup restored')
    if (!result.integrity.ok) {
      setIntegrityWarning({
        quickCheck: result.integrity.quickCheck,
        unbalancedVoucherIds: result.integrity.unbalancedVoucherIds,
        context: `restored from ${result.dateLabel}`
      })
    }
  }

  const backupNow = async (): Promise<void> => {
    setRunningBackup(true)
    try {
      await api.backups.run()
      recordCohortEvent(localStorage, 'first_backup_verified')
      await queryClient.invalidateQueries({ queryKey: ['backups'] })
      toast.push('success', 'Backup saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setRunningBackup(false)
    }
  }

  return (
    <div>
      <SectionTitle
        right={
          canBackup ? (
            <div className="flex gap-2">
              <Button disabled={runningBackup} onClick={() => void backupNow()}>
                {runningBackup ? 'Backing up…' : 'Back up now'}
              </Button>
              {isOwner && <Button onClick={() => setExporting(true)}>Export encrypted…</Button>}
            </div>
          ) : undefined
        }
      >
        Backups
      </SectionTitle>
      <Panel scroll={{ maxH: '60vh' }}>
        {rows.length === 0 ? (
          <EmptyState title="No backups yet" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>File</th>
                <th className="w-40">Date</th>
                <th className="w-24">Size</th>
                <th className="w-28">Tag</th>
                {isOwner && <th className="r w-24"></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.file}>
                  <td className="num text-[11.5px] text-muted">{b.file}</td>
                  <td className="num text-muted">{formatMtime(b.mtime)}</td>
                  <td className="num text-muted">{formatSize(b.sizeBytes)}</td>
                  <td>
                    <span className="rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-muted capitalize">
                      {b.tag.replace(/-/g, ' ')}
                    </span>
                  </td>
                  {isOwner && (
                    <td className="r">
                      <button className="text-[12px] text-blue hover:underline" onClick={() => setRestoring(b)}>
                        Restore…
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        Backups live in this company's data folder. A snapshot is also taken automatically on open and before risky
        operations (Tally imports, restores).
      </p>
      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <Panel className="px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-[12px] font-semibold">Backup destinations</p><p className="mt-1 text-[9.5px] leading-4 text-muted">Copy verified snapshots to an external disk or user-mounted cloud folder.</p></div>
            <Database size={18} className="shrink-0 text-amber" />
          </div>
          <div className="mt-3 grid gap-2">
            {destinations.data?.map((destination) => (
              <div key={destination.id} className="rounded-md border border-line bg-panel2 px-3 py-2">
                <div className="flex items-center justify-between gap-2"><p className="truncate text-[10.5px] font-semibold">{destination.name}</p><span className={`text-[8px] font-semibold uppercase ${destination.available && destination.writable ? 'text-dr' : 'text-cr'}`}>{destination.available && destination.writable ? 'Healthy' : 'Unavailable'}</span></div>
                <p className="mt-1 truncate font-mono text-[8.5px] text-muted">{destination.path}</p>
                <div className="mt-2 flex items-center justify-between"><p className="text-[8.5px] text-muted">{destination.warning ?? (destination.freeBytes == null ? destination.kind : `${formatSize(destination.freeBytes)} free`)}</p>{isOwner && <Button variant="ghost" className="!min-h-0 !py-0" onClick={async () => { try { await api.backups.setDestinationActive(destination.id, !destination.active); await queryClient.invalidateQueries({ queryKey: ['backup-destinations'] }) } catch (error) { toast.push('error', (error as Error).message) } }}>{destination.active ? 'Pause' : 'Resume'}</Button>}</div>
              </div>
            ))}
            {!destinations.data?.length && <p className="py-2 text-[9.5px] text-muted">Only the company-local backup folder is active.</p>}
          </div>
          {isOwner && <div className="mt-3 flex gap-2"><TextInput value={destinationName} onChange={(event) => setDestinationName(event.target.value)} aria-label="Destination name" /><Button onClick={async () => { try { const added = await api.backups.addDestination(destinationName); if (added) { await queryClient.invalidateQueries({ queryKey: ['backup-destinations'] }); toast.push('success', 'Backup destination added and health-checked') } } catch (error) { toast.push('error', (error as Error).message) } }}>Choose folder…</Button></div>}
        </Panel>
        <Panel className="px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-[12px] font-semibold">Recovery confidence</p><p className="mt-1 text-[9.5px] leading-4 text-muted">A drill opens a real backup read-only and verifies identity, schema, period and integrity.</p></div>
            {drills.data?.due ? <ShieldWarning size={19} className="shrink-0 text-amber" /> : <ShieldCheck size={19} className="shrink-0 text-dr" />}
          </div>
          <div className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2.5">
            <p className="text-[10px] font-semibold">{drills.data?.due ? 'Recovery drill due' : 'Recovery drill current'}</p>
            <p className="mt-1 text-[9px] text-muted">{drills.data?.rows[0] ? `${drills.data.rows[0].integrity.toUpperCase()} · ${toDisplayDateTime(new Date(drills.data.rows[0].verifiedAt))} · ${drills.data.rows[0].backupFile}` : 'No successful restore rehearsal has been recorded yet.'}</p>
          </div>
          {isOwner && <Button className="mt-3" onClick={async () => { try { const result = await api.backups.runDrill(); await queryClient.invalidateQueries({ queryKey: ['backup-drills'] }); toast.push(result.integrity === 'ok' ? 'success' : 'error', result.integrity === 'ok' ? 'Recovery drill passed' : result.detail) } catch (error) { toast.push('error', (error as Error).message) } }}>Verify latest backup</Button>}
          {rotation.data && <div className="mt-4 border-t border-line pt-3"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">Rotation forecast</p><p className="mt-1 text-[10px]">{rotation.data.forecast.projectedRetainedFiles} restore points · about {formatSize(rotation.data.forecast.projectedBytes)}</p><p className="mt-1 text-[8.5px] text-muted">{rotation.data.policy.dailyCount} daily · {rotation.data.policy.weeklyCount} weekly · {rotation.data.policy.monthlyCount} monthly · {rotation.data.policy.yearEndCount} year-end</p>{isOwner && <div className="mt-2 flex gap-1">{[{ label: 'Lean', value: { dailyCount: 7, weeklyCount: 4, monthlyCount: 6, yearEndCount: 5 } }, { label: 'Balanced', value: { dailyCount: 14, weeklyCount: 8, monthlyCount: 12, yearEndCount: 7 } }, { label: 'Deep', value: { dailyCount: 30, weeklyCount: 12, monthlyCount: 24, yearEndCount: 10 } }].map((preset) => <Button key={preset.label} variant="ghost" className="!min-h-0 !px-2 !py-1" onClick={async () => { try { await api.backups.setRotation(preset.value); await queryClient.invalidateQueries({ queryKey: ['backup-rotation'] }); toast.push('success', `${preset.label} rotation will apply to automatic backups`) } catch (error) { toast.push('error', (error as Error).message) } }}>{preset.label}</Button>)}</div>}</div>}
        </Panel>
      </div>
      {restoring && (
        <RestoreModal
          backup={restoring}
          onClose={() => setRestoring(null)}
          onRestored={(result) => {
            setRestoring(null)
            void commitRestore(result)
          }}
        />
      )}
      {exporting && <ExportEncryptedModal onClose={() => setExporting(false)} />}
    </div>
  )
}

function RestoreModal({
  backup,
  onClose,
  onRestored
}: {
  backup: BackupInfo
  onClose: () => void
  onRestored: (result: RestoreResult) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const dateLabel = formatMtime(backup.mtime)
  const { data: preview, isLoading, error: previewError } = useQuery({
    queryKey: ['backup-preview', backup.file],
    queryFn: () => api.backups.preview(backup.file),
    retry: false
  })

  const restore = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.backups.restore(backup.file)
      // Session-lock transition, query invalidation, and any integrity warning are all applied
      // synchronously by the parent's commitRestore — see there for why.
      onRestored({ locked: r.locked, integrity: r.integrity, dateLabel })
    } catch (err) {
      toast.push('error', (err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Restore from backup" onClose={onClose}>
      <div className="flex items-start gap-3 border-b border-line pb-4">
        <span className="rounded-md border border-line bg-panel2 p-2 text-blue"><HardDrives size={21} weight="duotone" /></span>
        <div><p className="text-[13px] font-semibold text-ink">Review the recovery point</p><p className="mt-0.5 text-[11.5px] text-muted">The selected file is opened read-only and verified before it can replace your books.</p></div>
      </div>
      {isLoading && <div className="py-6 text-center text-[12px] text-muted">Inspecting backup…</div>}
      {(previewError || (preview && !preview.valid)) && (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-cr/35 bg-cr/8 px-3.5 py-3 text-[12.5px]">
          <ShieldWarning size={20} weight="duotone" className="shrink-0 text-cr" />
          <div><b>Restore blocked.</b> {preview?.detail ?? (previewError as Error)?.message}</div>
        </div>
      )}
      {preview?.valid && preview.company && (
        <div className="mt-4 overflow-hidden rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-dr/7 px-3.5 py-2.5 text-[12px] text-dr">
            <ShieldCheck size={18} weight="duotone" /> <b>Integrity verified</b><span className="text-muted">· Read-only SQLite check passed</span>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-line">
            {[
              ['Company', preview.company.name],
              ['Books from', `FY ${preview.company.booksFrom}-${String(preview.company.booksFrom + 1).slice(-2)}`],
              ['Schema', `v${preview.schemaVersion ?? '—'}`],
              ['Voucher period', preview.firstVoucherDate ? `${toDisplayDate(preview.firstVoucherDate)} – ${toDisplayDate(preview.lastVoucherDate!)}` : 'No vouchers'],
              ['Vouchers', String(preview.voucherCount ?? 0)],
              ['Backup size', formatSize(preview.sizeBytes)]
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 px-3.5 py-3">
                <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">{label}</div>
                <div className="mt-1 text-[12.5px] font-medium text-ink">{value}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 text-[11px] text-muted"><Database size={15} /> Snapshot created {dateLabel}</div>
        </div>
      )}
      <p className="mt-4 text-[12px] text-muted">Restoring replaces the current books. Total first keeps a separate pre-restore safety copy for automatic rollback.</p>
      <div className="mt-4">
        <Field label="Type RESTORE to confirm">
          <TextInput value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={confirmText !== 'RESTORE' || busy || !preview?.valid} onClick={() => void restore()}>
          {busy ? 'Restoring…' : 'Restore'}
        </Button>
      </div>
    </Modal>
  )
}

function ExportEncryptedModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const strength = passphraseSchema.safeParse(pass1)
    if (!strength.success) return setError(strength.error.issues[0]?.message ?? 'Choose a stronger passphrase')
    if (pass1 !== pass2) return setError('Passphrases do not match')
    setBusy(true)
    try {
      await api.backups.exportEncrypted(pass1)
      toast.push('success', 'Encrypted backup saved — revealed in Finder. Keep the passphrase safe; it cannot be recovered.')
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Export encrypted backup" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Passphrase" error={error}>
          <TextInput
            type="password"
            value={pass1}
            onChange={(e) => {
              setPass1(e.target.value)
              setError(null)
            }}
            autoFocus
          />
        </Field>
        <p className="-mt-1 text-[9.5px] leading-4 text-muted">Use a long phrase you can store safely. Total cannot recover it, and another computer may need it during a real outage.</p>
        <Field label="Confirm passphrase">
          <TextInput
            type="password"
            value={pass2}
            onChange={(e) => {
              setPass2(e.target.value)
              setError(null)
            }}
          />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Encrypting…' : 'Export'}
        </Button>
      </div>
    </Modal>
  )
}
