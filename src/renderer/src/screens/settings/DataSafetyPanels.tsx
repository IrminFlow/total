/**
 * The panels under Settings → Backups that are about the books surviving things other than a
 * mistake: a copy somewhere else, an archived company, an open export, the folder itself, and
 * what to do when the database is damaged.
 *
 * Kept beside BackupsSection rather than inside it because that file is already the longest
 * settings screen, and these five are independent of the backup list they sit under.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { EXTERNAL_BACKUP_HOURS } from '@shared/backupSchedule'

/** Owner-gated exactly as the server is: a company with no user accounts has no auth at all. */
function useIsOwner(): boolean {
  const { user } = useSession()
  return user == null || user.role === 'owner'
}

/**
 * A copy of the books somewhere that is not this disk (roadmap #245, #253).
 *
 * Every backup the app already takes lives in the company folder, which survives a mistake and
 * nothing else — a dead disk, a stolen laptop and a wiped Documents folder take the books and
 * their backups together.
 */
export function ExternalBackupPanel(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['externalBackup'], queryFn: api.backups.externalGet })
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const isOwner = useIsOwner()

  const save = async (
    over: Partial<{ dir: string | null; everyHours: number; encrypt: boolean; keep: number }>
  ): Promise<void> => {
    if (!data) return
    setBusy(true)
    try {
      const next = { dir: data.dir, everyHours: data.everyHours, encrypt: data.encrypt, keep: data.keep, ...over }
      await api.backups.externalSet({ ...next, passphrase: passphrase || undefined })
      setPassphrase('')
      await queryClient.invalidateQueries({ queryKey: ['externalBackup'] })
      toast.push('success', next.dir ? 'Copies will be written to that folder' : 'Copies elsewhere turned off')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const choose = async (): Promise<void> => {
    const picked = await api.backups.externalChoose()
    if (!picked) return
    if (!picked.verdict.ok) {
      toast.push('error', picked.verdict.error)
      return
    }
    if (picked.verdict.warning) toast.push('info', picked.verdict.warning)
    await save({ dir: picked.dir })
  }

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const run = await api.backups.externalRunNow()
      await queryClient.invalidateQueries({ queryKey: ['externalBackup'] })
      toast.push('success', run.path ? 'Copy written' : 'Nothing to copy')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="mt-4 p-4">
      <SectionTitle>A copy somewhere else</SectionTitle>
      <p className="mb-3 text-hint text-muted" data-testid="external-backup-description">
        {data?.description ?? 'Loading…'}
      </p>
      {data?.lastError && (
        <div
          className="mb-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr"
          data-testid="external-backup-error"
        >
          Last attempt failed: {data.lastError}
        </div>
      )}
      <div className="flex flex-col gap-3">
        <Field label="Folder" hint="An external drive, or a synced folder if you turn the passphrase on.">
          <div className="flex items-center gap-2">
            <span className="num flex-1 truncate text-hint text-muted" data-testid="external-backup-dir">
              {data?.dir ?? 'Not set'}
            </span>
            <Button disabled={!isOwner || busy} data-testid="btn-external-choose" onClick={() => void choose()}>
              Choose…
            </Button>
            {data?.dir && (
              <Button disabled={!isOwner || busy} data-testid="btn-external-off" onClick={() => void save({ dir: null })}>
                Turn off
              </Button>
            )}
          </div>
        </Field>
        {data?.dir && (
          <>
            <Field label="How often">
              <Select
                data-testid="select-external-hours"
                className="w-44"
                value={data.everyHours}
                disabled={!isOwner || busy}
                onChange={(e) => void save({ everyHours: Number(e.target.value) })}
              >
                {EXTERNAL_BACKUP_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h === 1 ? 'Every hour' : h === 24 ? 'Once a day' : h === 168 ? 'Once a week' : `Every ${h} hours`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Passphrase"
              hint={
                data.encrypt
                  ? 'Copies are encrypted. Nobody can recover this passphrase — keep it somewhere other than this machine.'
                  : 'Required before copies may be written into a folder that syncs to the cloud.'
              }
            >
              <div className="flex items-center gap-2">
                <TextInput
                  type="password"
                  data-testid="input-external-passphrase"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={data.hasPassphrase ? 'Stored in this machine’s keychain' : 'At least 8 characters'}
                  disabled={!isOwner || busy}
                />
                <Button
                  disabled={!isOwner || busy}
                  data-testid="btn-external-encrypt"
                  onClick={() => void save({ encrypt: !data.encrypt })}
                >
                  {data.encrypt ? 'Turn encryption off' : 'Turn encryption on'}
                </Button>
              </div>
            </Field>
            <div className="flex justify-end">
              <Button disabled={!isOwner || busy} data-testid="btn-external-run-now" onClick={() => void runNow()}>
                Copy now
              </Button>
            </div>
          </>
        )}
      </div>
    </Panel>
  )
}

/** Books that may be read and not changed (roadmap #257). */
export function ArchivePanel(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['companyArchive'], queryFn: api.company.archiveGet })
  const [note, setNote] = useState('')
  const isOwner = useIsOwner()

  const set = async (archived: boolean): Promise<void> => {
    try {
      await api.company.archiveSet(archived, archived ? note.trim() || null : null)
      await queryClient.invalidateQueries()
      toast.push('success', archived ? 'These books are now read-only' : 'These books can be posted to again')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="mt-4 p-4">
      <SectionTitle>Archived</SectionTitle>
      <p className="mb-3 text-hint text-muted">
        A books-lock date closes a period; this closes the company. Reading, printing, exporting and backing up carry on
        working — archived books nobody can get data out of would be a hostage rather than a record.
      </p>
      {data?.archived ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-body-sm text-ink" data-testid="archive-state">
            Read-only{data.note ? ` — ${data.note}` : ''}
            {data.by ? ` (${data.by})` : ''}
          </span>
          <Button disabled={!isOwner} data-testid="btn-archive-off" onClick={() => void set(false)}>
            Allow posting again
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Why (optional)">
              <TextInput
                data-testid="input-archive-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="FY 2023-24, filed and assessed"
                disabled={!isOwner}
              />
            </Field>
          </div>
          <Button disabled={!isOwner} data-testid="btn-archive-on" onClick={() => void set(true)}>
            Make read-only
          </Button>
        </div>
      )}
    </Panel>
  )
}

/** The books in a format that is not this app's (roadmap #254). */
export function PortablePanel(): React.JSX.Element {
  const toast = useToasts()
  const [busy, setBusy] = useState(false)

  const exportNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.portable.export()
      toast.push('success', `${result.vouchers.toLocaleString('en-IN')} vouchers written as open JSON`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="mt-4 p-4">
      <SectionTitle
        right={
          <Button disabled={busy} data-testid="btn-export-portable" onClick={() => void exportNow()}>
            Export…
          </Button>
        }
      >
        Open export
      </SectionTitle>
      <p className="text-hint text-muted">
        Plain JSON, documented in docs/export-format.md, and guaranteed to come back in unchanged: masters, opening
        balances, vouchers and stock lines, with money still in whole paise. A backup keeps your books safe from a bad
        day; this keeps them readable without Total at all.
      </p>
    </Panel>
  )
}

/** Moving the data folder out of a synced one (roadmap #244). */
export function DataFolderPanel(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['dataFolder'], queryFn: api.dataFolder.get })
  const [busy, setBusy] = useState(false)
  const isOwner = useIsOwner()

  const move = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.dataFolder.move()
      if (!result) return
      await queryClient.invalidateQueries()
      toast.push(
        'success',
        `Copied ${result.companies} compan${result.companies === 1 ? 'y' : 'ies'} to ${result.to}. The old folder is untouched — remove it yourself once you are happy.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="mt-4 p-4">
      <SectionTitle>Data folder</SectionTitle>
      <p className="num mb-2 text-hint text-muted" data-testid="data-folder-path">
        {data?.root ?? '…'}
      </p>
      {data?.chosenMissing && (
        <div
          className="mb-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr"
          data-testid="data-folder-missing"
        >
          The folder you moved your books to is not there — an unplugged drive, or a folder that has been renamed.
          Total is showing the default folder instead. Reconnect it and reopen Total rather than starting again here.
        </div>
      )}
      {data?.syncedBy && (
        <div
          className="mb-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr"
          data-testid="data-folder-synced"
        >
          This folder is synced by {data.syncedBy}. A live database edited on two machines at once, or synced mid-write,
          can be corrupted. Moving it somewhere local is strongly recommended.
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-hint text-muted">
          Moving copies everything, checks every company still opens, and only then switches over. Nothing is deleted.
        </span>
        <Button disabled={!isOwner || busy} data-testid="btn-move-data-folder" onClick={() => void move()}>
          {busy ? 'Moving…' : 'Move…'}
        </Button>
      </div>
    </Panel>
  )
}

/**
 * What to do when the database is damaged (roadmap #248).
 *
 * Shown always, not only when something is wrong: the steps are worth reading before they are
 * needed, and a panel that appears only in a crisis is a panel nobody has ever seen.
 */
export function RecoveryPanel(): React.JSX.Element | null {
  const { data } = useQuery({ queryKey: ['recovery'], queryFn: api.backups.recovery })
  if (!data) return null
  const { guidance } = data
  const tone =
    guidance.severity === 'file'
      ? 'border-cr/40 bg-cr/5 text-cr'
      : guidance.severity === 'books'
        ? 'border-accent/40 bg-accent/5 text-ink'
        : 'border-line bg-panel2 text-muted'

  return (
    <Panel className="mt-4 p-4">
      <SectionTitle>If something is wrong with this database</SectionTitle>
      <div className={`rounded-md border px-3.5 py-2.5 text-body-sm ${tone}`} data-testid="recovery-headline">
        {guidance.headline}
      </div>
      <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5" data-testid="recovery-steps">
        {guidance.steps.map((step) => (
          <li key={step.title} className="text-detail text-ink">
            <b>{step.title}.</b> <span className="text-muted">{step.detail}</span>
          </li>
        ))}
      </ol>
    </Panel>
  )
}
