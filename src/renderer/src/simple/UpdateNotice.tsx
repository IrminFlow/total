import { useEffect, useState } from 'react'
import { api, onUpdateEvent } from '../lib/client'
import { useT } from '../lib/i18n'
import { useToasts } from '../state/stores'
import { Button } from '../components/ui'
import type { UpdateAction, UpdateNotice as Notice } from '@shared/updates'

const DOWNLOAD: UpdateAction = 'download' // i18n-technical
const SKIP: UpdateAction = 'skip' // i18n-technical
const INSTALL: UpdateAction = 'install' // i18n-technical
const ON_QUIT: UpdateAction = 'installOnQuit' // i18n-technical

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
  const [later, setLater] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!notice) return null
  const key = `${notice.phase}:${notice.version}`
  if (later === key) return null

  const act = async (action: UpdateAction): Promise<void> => {
    setBusy(true)
    try {
      await api.app.updateAction(action)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="alertdialog"
      aria-label={t('simple.updates.title')}
      data-testid="update-notice"
      className="fixed bottom-4 left-4 z-50 w-96 rounded-lg border border-line bg-raised p-4 shadow-elev-2"
    >
      {notice.phase === 'available' && (
        <>
          <p className="text-detail font-medium text-ink">{t('simple.updates.available', { version: notice.version })}</p>
          <p className="mt-1 text-hint text-muted">{t('simple.updates.availableHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void act(DOWNLOAD)} data-testid="btn-update-download">
              {t('simple.updates.download')}
            </Button>
            <Button disabled={busy} onClick={() => setLater(key)} data-testid="btn-update-later">
              {t('simple.updates.later')}
            </Button>
            <Button disabled={busy} onClick={() => void act(SKIP)} data-testid="btn-update-skip">
              {t('simple.updates.skip')}
            </Button>
          </div>
        </>
      )}
      {notice.phase === 'downloading' && (
        <p className="text-detail text-ink" data-testid="update-downloading">
          {t('simple.updates.downloading', { version: notice.version })}
        </p>
      )}
      {notice.phase === 'ready' && (
        <>
          <p className="text-detail font-medium text-ink">{t('simple.updates.ready', { version: notice.version })}</p>
          <p className="mt-1 text-hint text-muted">{t('simple.updates.readyHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void act(INSTALL)} data-testid="btn-update-restart">
              {t('simple.updates.restart')}
            </Button>
            <Button disabled={busy} onClick={() => void act(ON_QUIT)} data-testid="btn-update-onquit">
              {t('simple.updates.onQuit')}
            </Button>
            <Button disabled={busy} onClick={() => setLater(key)} data-testid="btn-update-later">
              {t('simple.updates.later')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
