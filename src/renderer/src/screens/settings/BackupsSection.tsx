import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BackupInfo } from '../../lib/client'
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

export function BackupsSection(): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
  const { user } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [runningBackup, setRunningBackup] = useState(false)
  const rows = data ?? []
  const isOwner = user?.role === 'owner'
  const canBackup = user?.role !== 'viewer'

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
      <Panel>
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
      {restoring && <RestoreModal backup={restoring} onClose={() => setRestoring(null)} />}
      {exporting && <ExportEncryptedModal onClose={() => setExporting(false)} />}
    </div>
  )
}

function RestoreModal({ backup, onClose }: { backup: BackupInfo; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { setUser, setLocked } = useSession()
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [integrityIssue, setIntegrityIssue] = useState<string | null>(null)
  const dateLabel = formatMtime(backup.mtime)

  const restore = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.backups.restore(backup.file)
      // Books changed underneath every screen — invalidate everything, not just ['backups'].
      await queryClient.invalidateQueries()
      if (r.locked) {
        setUser(null)
        setLocked(true)
      }
      if (!r.integrity.ok) {
        setIntegrityIssue(
          `${r.integrity.quickCheck}${
            r.integrity.unbalancedVoucherIds.length ? ` — ${r.integrity.unbalancedVoucherIds.length} unbalanced voucher(s)` : ''
          }`
        )
      } else {
        toast.push('success', `Restored from ${dateLabel}`)
        onClose()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (integrityIssue) {
    return (
      <Modal title="Restored — integrity warning" onClose={onClose}>
        <p className="text-[13px] text-cr">Integrity check found an issue: {integrityIssue}</p>
        <p className="mt-2 text-[12.5px] text-muted">
          The books were restored anyway. Review the Day Book and Trial Balance carefully before continuing.
        </p>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={onClose}>
            OK
          </Button>
        </div>
      </Modal>
    )
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
