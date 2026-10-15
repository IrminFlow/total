import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { daysAgo } from '@shared/backupCheck'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useNav, useToasts } from '../state/stores'
import { Button, Page } from '../components/ui'
import { useCanSave, ViewerNote } from './ViewerNote'

const BACKUPS_KEY = ['backups'] as const // i18n-technical: query key
/** The full Settings → Backups tab (every backup, restore, encrypted copies). */
const FULL = { name: 'settings', tab: 'backups' } as const // i18n-technical

/** The backup's file name (the main side reveals only a file of this company's backups folder). */
const fileOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

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
  // WP 7.2: the newest restore check (a backup you take is checked at once, automatic ones daily).
  const { data: checks } = useQuery({ queryKey: [...BACKUPS_KEY, 'checks'], queryFn: () => api.backups.checks() }) // i18n-technical
  const check = checks?.[0] ?? null
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const newest = (backups ?? []).reduce<number | null>((m, b) => (m == null || b.mtime > m ? b.mtime : m), null)
  const newestFile = (backups ?? []).reduce<{ file: string; mtime: number } | null>((m, b) => (m == null || b.mtime > m.mtime ? b : m), null)?.file
  const reveal = async (file?: string): Promise<void> => {
    try {
      await api.backups.reveal(file)
    } catch {
      /* Finder could not be opened — nothing to undo */
    }
  }

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
        {check && (
          <p className={`mt-1 text-detail ${check.ok ? 'text-ink' : 'text-cr'}`} data-testid="simple-backups-check" data-ok={check.ok ? 'true' : 'false'}>
            {check.ok ? t('simple.security.backup.ok', { days: daysAgo(check.checkedAt) }) : t('simple.security.backup.failed', { days: daysAgo(check.checkedAt) })}
          </p>
        )}
        {canSave ? (
          <Button className="mt-4" variant="primary" disabled={busy} data-testid="btn-simple-backup-now" onClick={() => void run()}>
            {t('simple.nav.backupNow')}
          </Button>
        ) : (
          <div className="mt-4">
            <ViewerNote />
          </div>
        )}
        {/* Gate polish: where the file went in words (never the raw path), and Show in Finder. */}
        {saved && (
          <p className="mt-3 text-detail text-ink" role="status" data-testid="simple-backups-saved">
            {t('simple.backups.savedWhere')}{' '}
            <button type="button" className="text-blue hover:underline" data-testid="btn-simple-backups-reveal-saved" onClick={() => void reveal(fileOf(saved))}>
              {t('simple.backups.showInFinder')}
            </button>
          </p>
        )}
        <p className="mt-3 text-small text-muted">{t('simple.backups.copyHint')}</p>
        <p className="mt-1 text-small text-muted">{t('simple.backups.whereHint')}</p>
        {backups && backups.length > 0 && (
          <Button className="mt-2" variant="secondary" size="sm" data-testid="btn-simple-backups-reveal" onClick={() => void reveal(newestFile)}>
            {t('simple.backups.showInFinder')}
          </Button>
        )}
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
