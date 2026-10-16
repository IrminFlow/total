import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, IpcError } from '../lib/client'
import { useT } from '../lib/i18n'
import { useCanSetMode } from '../lib/mode'
import { lockNow } from '../lib/sessionLock'
import { useToasts } from '../state/stores'
import { Button, Checkbox, Field, Page, Select, TextInput } from '../components/ui'
import { errorEntry } from '@shared/errors'
import { daysAgo } from '@shared/backupCheck'
import type { SecurityView } from '@shared/security'

/**
 * WP 7.2: Settings → Lock and safety — the passphrase lock (on, change, off; the recovery copy
 * after turning it on), the screen lock (auto-lock minutes, Lock now) and the backup checks, in
 * plain words. Owner only to change (anyone in a business without users), like the other
 * company-wide settings; everyone sees the state. Also the full app's Settings → Security tab.
 */
const QUERY_KEY = ['security'] as const // i18n-technical

export function SecuritySettings({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const t = useT()
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: api.security.get })
  const canEdit = useCanSetMode()
  const Wrap = embedded ? Plain : NarrowPage
  if (!data) return <Wrap>{null}</Wrap>
  return (
    <Wrap>
      <div data-testid="simple-security" data-encrypted={data.encrypted ? 'true' : 'false'}>
        <h1 className="mb-1 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.security.title')}</h1>
        <p className="mb-5 text-small text-muted">{t('simple.security.intro')}</p>
        <PassphraseCard view={data} canEdit={canEdit} />
        <ScreenLockCard view={data} canEdit={canEdit} />
        <BackupCheckCard view={data} />
        {!canEdit && <p className="mt-3 text-small text-muted">{t('simple.security.ownerOnly')}</p>}
      </div>
    </Wrap>
  )
}

/** The simple screen's page, or nothing extra inside the full app's Settings tab. */
export function NarrowPage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Page width="narrow">{children}</Page>
}
export function Plain({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>
}

const cardCls = 'mb-4 rounded-lg border border-line bg-panel px-panel py-4 shadow-elev-1'

/** The plain message for a failed call (the technical wording stays in the log). */
function usePlain(): (err: unknown) => string {
  const t = useT()
  return (err) => {
    const entry = err instanceof IpcError && err.code ? errorEntry(err.code, err.field) : null
    return entry ? t(entry.key) : t('errors.generic') // i18n-technical: the plain errors.* key of the code
  }
}

function PassphraseCard({ view, canEdit }: { view: SecurityView; canEdit: boolean }): React.JSX.Element {
  const t = useT()
  const plain = usePlain()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [current, setCurrent] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState<'on' | 'off' | 'change' | 'recovery' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The passphrase just set, kept only until the recovery copy is saved (or the screen closes).
  const [recoveryPass, setRecoveryPass] = useState<string | null>(null)

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  const reset = (): void => {
    setPass('')
    setConfirm('')
    setCurrent('')
    setUnderstood(false)
    setError(null)
  }

  const turnOn = async (): Promise<void> => {
    setBusy('on')
    setError(null)
    try {
      const r = await api.security.passphraseOn(pass, confirm)
      toast.push('success', t('simple.security.passphrase.done', { count: r.backupsConverted }))
      if (r.backupsFailed.length) toast.push('warning', t('simple.security.passphrase.someBackupsLeft', { count: r.backupsFailed.length }))
      setRecoveryPass(pass)
      reset()
      await refresh()
    } catch (err) {
      setError(plain(err))
    } finally {
      setBusy(null)
    }
  }

  const saveRecovery = async (): Promise<void> => {
    if (!recoveryPass) return
    setBusy('recovery') // i18n-technical
    try {
      await api.backups.exportEncrypted(recoveryPass)
      setRecoveryPass(null)
      toast.push('success', t('simple.security.recovery.saved'))
    } catch (err) {
      toast.push('error', plain(err))
    } finally {
      setBusy(null)
    }
  }

  const change = async (): Promise<void> => {
    setBusy('change')
    setError(null)
    try {
      await api.security.passphraseChange(current, pass, confirm)
      toast.push('success', t('simple.security.change.done'))
      reset()
      await refresh()
    } catch (err) {
      setError(plain(err))
    } finally {
      setBusy(null)
    }
  }

  const turnOff = async (): Promise<void> => {
    setBusy('off')
    setError(null)
    try {
      await api.security.passphraseOff(current)
      toast.push('success', t('simple.security.off.done'))
      reset()
      await refresh()
    } catch (err) {
      setError(plain(err))
    } finally {
      setBusy(null)
    }
  }

  const errorLine = error && (
    <p className="mt-2 text-small text-cr" role="alert" data-testid="security-error">
      {error}
    </p>
  )

  return (
    <section className={cardCls} data-testid="security-passphrase">
      <h2 className="text-title font-semibold text-ink">{t('simple.security.passphrase.title')}</h2>
      {!view.encrypted ? (
        <>
          <p className="mt-1 text-detail text-ink">{t('simple.security.passphrase.offText')}</p>
          <p className="mt-2 rounded-md bg-amberbar/15 px-3 py-2 text-detail text-ink" data-testid="security-warning">
            {t('simple.security.passphrase.warning')}
          </p>
          {canEdit && (
            <div className="mt-3 flex flex-col gap-3">
              <Field label={t('simple.security.passphrase.new')}>
                <TextInput type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} data-testid="input-new-passphrase" />
              </Field>
              <Field label={t('simple.security.passphrase.confirm')}>
                <TextInput type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="input-confirm-passphrase" />
              </Field>
              <Checkbox label={t('simple.security.passphrase.understand')} checked={understood} onChange={setUnderstood} testId="check-passphrase-understood" />
              <div>
                <Button
                  variant="primary"
                  disabled={busy !== null || !understood || pass.length < 8 || !confirm}
                  onClick={() => void turnOn()}
                  data-testid="btn-security-lock-on"
                >
                  {busy === 'on' ? t('simple.security.passphrase.working') : t('simple.security.passphrase.turnOn')}
                </Button>
              </div>
              {errorLine}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-detail text-ink" data-testid="security-locked-text">
            {t('simple.security.passphrase.onText')}
          </p>
          {recoveryPass && (
            <div className="mt-3 rounded-md bg-panel2 px-3 py-2" data-testid="security-recovery">
              <p className="text-detail font-medium text-ink">{t('simple.security.recovery.title')}</p>
              <p className="mt-0.5 text-small text-muted">{t('simple.security.recovery.text')}</p>
              <Button className="mt-2" variant="secondary" disabled={busy !== null} onClick={() => void saveRecovery()} data-testid="btn-security-recovery">
                {t('simple.security.recovery.save')}
              </Button>
            </div>
          )}
          {canEdit && (
            <div className="mt-3 flex flex-col gap-3">
              <Field label={t('simple.security.change.current')}>
                <TextInput type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="input-current-passphrase" />
              </Field>
              <p className="text-small text-muted">{t('simple.security.change.title')}</p>
              <Field label={t('simple.security.passphrase.new')}>
                <TextInput type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} data-testid="input-new-passphrase" />
              </Field>
              <Field label={t('simple.security.passphrase.confirm')}>
                <TextInput type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="input-confirm-passphrase" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy !== null || !current || pass.length < 8 || !confirm} onClick={() => void change()} data-testid="btn-security-change">
                  {t('simple.security.change.save')}
                </Button>
                <Button variant="ghost" disabled={busy !== null || !current} onClick={() => void turnOff()} data-testid="btn-security-lock-off">
                  {t('simple.security.off.button')}
                </Button>
              </div>
              <p className="text-small text-muted">{t('simple.security.off.text')}</p>
              {errorLine}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ScreenLockCard({ view, canEdit }: { view: SecurityView; canEdit: boolean }): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const set = async (raw: string): Promise<void> => {
    try {
      await api.security.setAutoLock(raw === '' ? null : Number(raw))
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.push('success', t('simple.security.screen.saved'))
    } catch (err) {
      toast.push('error', err instanceof IpcError && err.code === 'lock_needs_people' ? t('errors.security.lockPrivacyOnly') : t('errors.generic'))
    }
  }
  return (
    <section className={cardCls} data-testid="security-screen-lock">
      <h2 className="text-title font-semibold text-ink">{t('simple.security.screen.title')}</h2>
      <p className="mt-1 text-detail text-ink">{t('simple.security.screen.text')}</p>
      {/* WP 7.2 follow-up: without people the lock is a privacy screen (the passphrase, when the
          business has one, still guards it) — said before the choice, never hidden. */}
      {!view.usersExist && (
        <p className="mt-2 text-small text-muted" data-testid="security-needs-people">
          {t('errors.security.lockPrivacyOnly')}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label={t('simple.security.screen.after')}>
          <Select value={view.autoLockMinutes ?? ''} disabled={!canEdit} onChange={(e) => void set(e.target.value)} data-testid="select-autolock">
            <option value="">{t('simple.security.screen.off')}</option>
            {view.autoLockChoices.map((m) => (
              <option key={m} value={m}>
                {t('simple.security.screen.minutes', { n: m })}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" onClick={() => void lockNow(() => {})} data-testid="btn-lock-now">
          {t('simple.security.screen.lockNow')}
        </Button>
      </div>
    </section>
  )
}

function BackupCheckCard({ view }: { view: SecurityView }): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const check = view.lastCheck
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.backups.check()
      toast.push(r.ok ? 'success' : 'warning', r.ok ? t('simple.security.backup.ok', { days: 0 }) : t('simple.security.backup.failed', { days: 0 }))
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    } catch {
      toast.push('error', t('simple.security.backup.noBackup'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={cardCls} data-testid="security-backup-check">
      <h2 className="text-title font-semibold text-ink">{t('simple.security.backup.title')}</h2>
      <p className="mt-1 text-detail text-ink">{t('simple.security.backup.text')}</p>
      <p className={`mt-2 text-detail ${check && !check.ok ? 'text-cr' : 'text-ink'}`} data-testid="security-backup-status" data-ok={check ? (check.ok ? 'true' : 'false') : 'none'}>
        {!check ? t('simple.security.backup.none') : check.ok ? t('simple.security.backup.ok', { days: daysAgo(check.checkedAt) }) : t('simple.security.backup.failed', { days: daysAgo(check.checkedAt) })}
      </p>
      <Button className="mt-2" variant="secondary" disabled={busy} onClick={() => void run()} data-testid="btn-backup-check">
        {busy ? t('simple.security.backup.checking') : t('simple.security.backup.checkNow')}
      </Button>
    </section>
  )
}
