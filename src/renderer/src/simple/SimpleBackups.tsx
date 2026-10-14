import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useNav, useToasts } from '../state/stores'
import { Button, Page } from '../components/ui'
import { useCanSave, ViewerNote } from './ViewerNote'

const BACKUPS_KEY = ['backups'] as const // i18n-technical: query key
/** The full Settings → Backups tab (every backup, restore, encrypted copies). */
const FULL = { name: 'settings', tab: 'backups' } as const // i18n-technical

const localDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * WP 10.8 — Settings → Backups in the simple shell (the Phase 9 gate's first-run finding: the
 * entry opened the full Backups tab, which speaks of vouchers, ledgers and SHA-256). One button,
 * the last backup in a sentence, where the file went, and what going back to a backup means; the
 * full list and restore stay behind "All backups and restore".
 */
export function SimpleBackups(): React.JSX.Element {
  const t = useT()
  // WP 10.8 review: Back up now is accountant+ (as the full tab shows it); a viewer gets the note.
  const canSave = useCanSave()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: backups } = useQuery({ queryKey: BACKUPS_KEY, queryFn: () => api.backups.list() })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const newest = (backups ?? []).reduce<number | null>((m, b) => (m == null || b.mtime > m ? b.mtime : m), null)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.backups.run()
      setSaved(r.path)
      await queryClient.invalidateQueries({ queryKey: BACKUPS_KEY })
    } catch (e) {
      toast.push('error', t('simple.backups.failed', { reason: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page width="narrow" data-testid="simple-backups">
      <h1 className="mb-2 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.settings.backups')}</h1>
      <p className="mb-5 text-detail text-muted">{t('simple.backups.intro')}</p>
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <p className="text-body text-ink" data-testid="simple-backups-last">
          {newest == null ? t('simple.backups.none') : t('simple.backups.last', { date: toPlainDate(localDay(newest), t.lang) })}
        </p>
        {backups && backups.length > 0 && <p className="mt-1 text-detail text-muted">{t('simple.backups.count', { count: backups.length })}</p>}
        {canSave ? (
          <Button className="mt-4" variant="primary" disabled={busy} data-testid="btn-simple-backup-now" onClick={() => void run()}>
            {t('simple.nav.backupNow')}
          </Button>
        ) : (
          <div className="mt-4">
            <ViewerNote />
          </div>
        )}
        {saved && (
          <p className="mt-3 text-detail text-ink" role="status" data-testid="simple-backups-saved">
            {t('simple.backups.saved')} <span className="break-all font-mono text-small">{saved}</span>
          </p>
        )}
        <p className="mt-3 text-small text-muted">{t('simple.backups.copyHint')}</p>
      </section>
      <section className="mt-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <h2 className="text-subtitle font-semibold text-ink">{t('simple.backups.restoreTitle')}</h2>
        <p className="mt-1 text-detail text-muted">{t('simple.backups.restore')}</p>
        <Button className="mt-3" data-testid="btn-simple-backups-all" onClick={() => nav.go(FULL)}>
          {t('simple.backups.all')}
        </Button>
      </section>
    </Page>
  )
}
