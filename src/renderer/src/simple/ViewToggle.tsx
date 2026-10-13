import { useT } from '../lib/i18n'
import { useScreenView } from '../lib/mode'
import { screenDef, simpleSectionOf } from '../lib/screens'
import { useNav, type Screen } from '../state/stores'

const HOME: Screen = { name: 'gateway' } // i18n-technical

/**
 * WP 8.1: the per-screen view switch, in a SIMPLE company only (renders nothing in an accountant
 * company, so the accountant header is unchanged). On a simple screen: "Accountant view" — the
 * same screen in the full shell, same nav state, remembered for this screen and user. On the
 * full screen: "Back to simple" — clears that choice, or (for an accountant-only screen) goes to
 * the screen's simple section.
 */
export function ViewToggle({ screen, className }: { screen: Screen; className: string }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  const { view, companyMode, override, setAccountantView } = useScreenView(screen.name)
  // Simple-only screens (section pages, How Total looks) have no full-app counterpart.
  if (companyMode !== 'simple' || !screenDef(screen.name)?.modes.includes('accountant')) return null
  const backToSimple = (): void => {
    if (override) {
      setAccountantView(false)
      return
    }
    const section = simpleSectionOf(screen)
    nav.go(section && section !== 'home' ? { name: 'simple-section', section } : HOME)
  }
  if (view === 'simple') {
    return (
      <button
        type="button"
        data-testid="btn-accountant-view"
        className={className}
        title={t('simple.shell.accountantViewHint')}
        onClick={() => setAccountantView(true)}
      >
        {t('common.accountantView')}
      </button>
    )
  }
  return (
    <button
      type="button"
      data-testid="btn-back-to-simple"
      className={className}
      title={t('simple.shell.backToSimpleHint')}
      onClick={backToSimple}
    >
      {t('common.backToSimple')}
    </button>
  )
}
