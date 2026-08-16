import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BackupInfo, type IntegrityResult } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, EmptyState, Field, Modal, Panel, SectionTitle, TextInput } from '../../components/ui'
import { toDisplayDate } from '@shared/dates'

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatMtime(mtime: number): string {
  const d = new Date(mtime)
  const iso = d.toISOString().slice(0, 10)
  return `${toDisplayDate(iso)} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

interface RestoreResult {
  locked: boolean
  integrity: IntegrityResult
  dateLabel: string
}

export function BackupsSection(): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
  const { user, setUser, setLocked, setIntegrityWarning } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [runningBackup, setRunningBackup] = useState(false)
  const rows = data ?? []
  const isOwner = user?.role === 'owner'
  const canBackup = user?.role !== 'viewer'

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
      <p className="text-[13px] text-ink">
        This replaces the current books with the backup from {dateLabel}. A pre-restore copy is kept.
      </p>
      <div className="mt-4">
        <Field label="Type RESTORE to confirm">
          <TextInput value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={confirmText !== 'RESTORE' || busy} onClick={() => void restore()}>
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
    if (pass1.length < 8) return setError('Passphrase must be at least 8 characters')
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
