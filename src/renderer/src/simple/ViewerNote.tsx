import { useT } from '../lib/i18n'
import { useSession } from '../state/stores'

/** WP 10.8: may the signed-in user save entries? A viewer may not (main refuses it); a company
 *  without sign-ins has no viewer. WP 7.2: the user's `canPost` flag decides when the owner set
 *  one (a viewer granted it may, an accountant refused it may not); no flag = the role, as before. */
export const useCanSave = (): boolean =>
  useSession((s) => s.user == null || (typeof s.user.capabilities?.canPost === 'boolean' && s.user.role !== 'owner' ? s.user.capabilities.canPost : s.user.role !== 'viewer')) // i18n-technical

/** May the signed-in user do the non-posting writes a viewer may not (a backup …)? The role
 *  alone, as useCanSave was before WP 7.2's canPost flag. */
export const useCanWrite = (): boolean => useSession((s) => s.user == null || s.user.role !== 'viewer') // i18n-technical

/**
 * WP 10.8 — what a viewer sees where the Save buttons would be (the 9.2 / 9.3 review: a viewer was
 * shown Save and only learnt after pressing it that their sign-in can't save).
 */
export function ViewerNote({ top = false }: { top?: boolean } = {}): React.JSX.Element {
  const t = useT()
  // to-do §4 (shots-86): a form also says it at the TOP, before the viewer fills anything in.
  if (top) {
    return (
      <p role="note" className="mb-4 rounded-md border border-line bg-panel2 px-3 py-2 text-detail text-ink" data-testid="viewer-note-top">
        {t('simple.viewer.cantSave')}
      </p>
    )
  }
  return (
    <p role="note" className="max-w-md text-detail text-muted" data-testid="viewer-note">
      {t('simple.viewer.cantSave')}
    </p>
  )
}

/** to-do §4: where "Back up now" would be for a viewer (the sidebar, Home's backup nudge). */
export function ViewerBackupNote({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const t = useT()
  return (
    <p role="note" className={compact ? 'text-caption text-muted' : 'text-detail text-muted'} data-testid="viewer-backup-note">
      {t('simple.viewer.cantBackUp')}
    </p>
  )
}
