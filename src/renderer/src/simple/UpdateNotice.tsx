import { useEffect, useState } from 'react'
import { api, onUpdateEvent } from '../lib/client'
import { useT } from '../lib/i18n'
import { useToasts } from '../state/stores'
import { useUpdatesCanSet } from '../lib/updatesGate'
import { confirmDialog } from '../lib/dialogs'
import { Button } from '../components/ui'
import type { UpdateAction, UpdateNotice as Notice } from '@shared/updates'

const DOWNLOAD: UpdateAction = 'download' // i18n-technical
const SKIP: UpdateAction = 'skip' // i18n-technical
const INSTALL: UpdateAction = 'install' // i18n-technical
const ON_QUIT: UpdateAction = 'installOnQuit' // i18n-technical

/** Notices hidden with "Later" this session (`phase:version`). Module-level, not component state: the
 *  notice is mounted once per App layout (company select / shell / simple shell), so opening a company
 *  re-mounts it — "Later" must still hold until Total restarts. */
const hiddenThisSession = new Set<string>()

/** Test hook: a fresh session. */
export function resetUpdateNoticeSession(): void {
  hiddenThisSession.clear()
}

/** The notice main last pushed (null = none), kept in step with `app:updates:get` and the push channel. */
export function useUpdateNotice(): Notice | null {
  const [notice, setNotice] = useState<Notice | null>(null)
  useEffect(() => {
    let live = true
    api.app.updates().then(
      (v) => live && setNotice(v.notice),
      () => {}
    )
    const off = onUpdateEvent((n) => live && setNotice(n))
    return () => {
      live = false
      off()
    }
  }, [])
  return notice
}

/**
 * The update notice, shown over every screen in both modes (plain words through t()). Total never
 * downloads on its own: "Download now" starts it, "Skip this version" is remembered, "Later" only hides
 * the notice for this session. A finished download offers "Restart to update" / "Install when I quit".
 */
export function UpdateNotice(): React.JSX.Element | null {
  const t = useT()
  const toast = useToasts()
  const notice = useUpdateNotice()
  // Owner-only in main where the business has users: a non-owner gets the news and "Later", not buttons that refuse.
  const gate = useUpdatesCanSet()
  const canAct = gate.allowed
  const [, setHidden] = useState(0)
  const [busy, setBusy] = useState(false)

  if (!notice) return null
  const key = `${notice.phase}:${notice.version}`
  if (hiddenThisSession.has(key)) return null
  const later = (): void => {
    hiddenThisSession.add(key)
    setHidden((n) => n + 1)
  }

  const act = async (action: UpdateAction): Promise<void> => {
    let confirmed = false
    if (gate.reason === 'needs_confirmation') {
      confirmed = await confirmDialog({ title: t('simple.updates.confirmTitle'), message: t('simple.updates.confirmBody'), confirmLabel: t('simple.updates.confirmButton') })
      if (!confirmed) return
    }
    setBusy(true)
    try {
      await api.app.updateAction(action, confirmed)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t('simple.updates.title')}
      data-testid="update-notice"
      className="fixed bottom-4 left-4 z-50 w-96 rounded-lg border border-line bg-raised p-4 shadow-elev-2"
    >
      {notice.phase === 'available' && (
        <>
          <p className="text-detail font-medium text-ink">{t('simple.updates.available', { version: notice.version })}</p>
          <p className="mt-1 text-hint text-muted">{t('simple.updates.availableHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canAct && (
              <Button variant="primary" disabled={busy} onClick={() => void act(DOWNLOAD)} data-testid="btn-update-download">
                {t('simple.updates.download')}
              </Button>
            )}
            <Button disabled={busy} onClick={later} data-testid="btn-update-later">
              {t('simple.updates.later')}
            </Button>
            {canAct && (
              <Button disabled={busy} onClick={() => void act(SKIP)} data-testid="btn-update-skip">
                {t('simple.updates.skip')}
              </Button>
            )}
          </div>
        </>
      )}
      {notice.phase === 'downloading' && (
        <>
          <p className="text-detail text-ink" data-testid="update-downloading">
            {t('simple.updates.downloading', { version: notice.version })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={later} data-testid="btn-update-later">
              {t('simple.updates.later')}
            </Button>
          </div>
        </>
      )}
      {!canAct && notice.phase !== 'downloading' && (
        <p className="mt-2 text-hint text-muted" data-testid="update-ask-owner">
          {gate.reason === 'other_company_has_users' ? t('simple.updates.otherCompany') : t('simple.updates.askOwner')}
        </p>
      )}
      {notice.phase === 'ready' && (
        <>
          <p className="text-detail font-medium text-ink">{t('simple.updates.ready', { version: notice.version })}</p>
          <p className="mt-1 text-hint text-muted">{t('simple.updates.readyHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canAct && (
              <>
                <Button variant="primary" disabled={busy} onClick={() => void act(INSTALL)} data-testid="btn-update-restart">
                  {t('simple.updates.restart')}
                </Button>
                <Button disabled={busy} onClick={() => void act(ON_QUIT)} data-testid="btn-update-onquit">
                  {t('simple.updates.onQuit')}
                </Button>
              </>
            )}
            <Button disabled={busy} onClick={later} data-testid="btn-update-later">
              {t('simple.updates.later')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
