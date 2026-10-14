import { useT } from '../lib/i18n'
import { useScreenView } from '../lib/mode'
import { useBackToSimple } from '../lib/handoff'
import { screenDef } from '../lib/screens'
import type { Screen } from '../state/stores'
import { AccountantViewButton } from './AccountantViewButton'

/**
 * WP 8.1: the per-screen view switch, in a SIMPLE company only (renders nothing in an accountant
 * company, so the accountant header is unchanged). On a screen with both views (Home): "Accountant
 * view" — the same screen in the full shell, same nav state; WP 9.10: just this time, unless
 * "Always open the full app for this" is picked from its menu (then remembered for this screen and
 * user). On a full screen: "Back to simple" — clears that choice, or (a full-app screen) goes to
 * the matching simple screen with the same object (lib/handoff.ts `simpleTargetFor`).
 */
export function ViewToggle({ screen, className }: { screen: Screen; className: string }): React.JSX.Element | null {
  const t = useT()
  const { view, companyMode, override, setAccountantView } = useScreenView(screen.name)
  const backToSimple = useBackToSimple()
  // Simple-only screens (section pages, How Total looks) have no full-app counterpart.
  if (companyMode !== 'simple' || !screenDef(screen.name)?.modes.includes('accountant')) return null
  if (view === 'simple') {
    return (
      <AccountantViewButton
        testId="btn-accountant-view"
        chipClassName={className}
        title={t('simple.shell.accountantViewHint')}
        onOpen={(always) => setAccountantView(true, always)}
      />
    )
  }
  return (
    <button
      type="button"
      data-testid="btn-back-to-simple"
      className={className}
      title={t('simple.shell.backToSimpleHint')}
      onClick={() => (override ? setAccountantView(false) : void backToSimple())}
    >
      {t('common.backToSimple')}
    </button>
  )
}
