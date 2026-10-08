import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BackupInfo, type IntegrityResult } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Modal, Panel, SectionTitle, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { toDisplayDateTime } from '@shared/dates'
import { AttachmentsSettings } from './AttachmentsSettings'

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatMtime(mtime: number): string {
  return toDisplayDateTime(new Date(mtime))
}

const tagLabel = (tag: string): string => {
  const t = tag.replace(/-/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const BACKUP_COLUMNS = defineColumns<BackupInfo>([
  { id: 'file', header: 'File', kind: 'text', value: (b) => b.file, className: 'num text-hint text-muted', hideable: false, groupable: false, minWidth: 220 },
  // mtime is epoch ms — sorts numerically, reads as a local date-time.
  { id: 'date', header: 'Date', kind: 'number', value: (b) => b.mtime, text: (b) => formatMtime(b.mtime), align: 'left', className: 'text-muted', width: 170 },
  { id: 'size', header: 'Size', kind: 'number', value: (b) => b.sizeBytes, text: (b) => formatSize(b.sizeBytes), align: 'left', className: 'text-muted', width: 100 },
  {
    id: 'tag',
    header: 'Tag',
    kind: 'text',
    value: (b) => b.tag,
    text: (b) => tagLabel(b.tag),
    groupable: true,
    width: 150,
    cell: (b) => (
      <span className="rounded-full border border-line bg-panel2 px-2 py-0.5 text-caption text-muted">{tagLabel(b.tag)}</span>
    )
  }
])

interface RestoreResult {
  locked: boolean
  integrity: IntegrityResult
  dateLabel: string
}

export function BackupsSection(): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
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
      <Panel>
        <DataTable
          viewId="settings-backups"
          testId="settings-backups"
          ariaLabel="Backups"
          columns={BACKUP_COLUMNS}
          rows={rows}
          rowKey={(b) => b.file}
          loading={isLoading}
          maxHeight="60vh"
          empty={{ title: 'No backups yet' }}
          trailingWidth={96}
          trailing={
            isOwner
              ? (b) => (
                  <button className="text-small text-blue hover:underline" onClick={() => setRestoring(b)}>
                    Restore…
                  </button>
                )
              : undefined
          }
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Backups live in this company's data folder, with the attached files. A snapshot is also taken automatically on open and before risky
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
      <AttachmentsSettings />
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
      <p className="text-detail text-ink">
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
