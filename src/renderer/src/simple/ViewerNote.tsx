import { useT } from '../lib/i18n'
import { useSession } from '../state/stores'

/** WP 10.8: may the signed-in user save entries? A viewer may not (main refuses it); a company
 *  without sign-ins has no viewer. */
export const useCanSave = (): boolean => useSession((s) => s.user == null || s.user.role !== 'viewer') // i18n-technical

/**
 * WP 10.8 — what a viewer sees where the Save buttons would be (the 9.2 / 9.3 review: a viewer was
 * shown Save and only learnt after pressing it that their sign-in can't save).
 */
export function ViewerNote(): React.JSX.Element {
  const t = useT()
  return (
    <p role="note" className="max-w-md text-detail text-muted" data-testid="viewer-note">
      {t('simple.viewer.cantSave')}
    </p>
  )
}
