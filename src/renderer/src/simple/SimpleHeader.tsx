import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { usePeriodPicker, useScreen, useSession, useTheme, useToasts, useNav } from '../state/stores'
import { Kbd } from '../components/ui'
import { toDisplayDate } from '@shared/dates'
import { ViewToggle } from './ViewToggle'
import { AssistantButton } from '../components/ai/AssistantButton'

const CHIP = 'rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink'

/**
 * WP 8.1: the simple shell's header — the business name (→ business details), the dates shown,
 * "Search ⌘K" (the palette), the light / dark switch, the per-screen "Accountant view" toggle and,
 * with users, who is signed in + Lock.
 */
export function SimpleHeader({ onOpenPalette }: { onOpenPalette: () => void }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const screen = useScreen()
  const toast = useToasts()
  const { info, from, to, user, setUser, setLocked } = useSession()
  const { theme, toggle } = useTheme()
  const setPeriodOpen = usePeriodPicker((s) => s.setOpen)
  const name = info?.name ?? ''
  const openBusiness = (): void => nav.go({ name: 'company-info' })
  const lock = async (): Promise<void> => {
    try {
      await api.auth.logout()
      setUser(null)
      setLocked(true)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <header
      data-testid="simple-header"
      className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel pr-4 panel-shadow ${
        window.total.platform === 'darwin' ? 'pl-24' : 'pl-4'
      }`}
    >
      <button
        type="button"
        className="rounded-md font-serif text-subtitle font-semibold tracking-tight"
        onClick={openBusiness}
        aria-label={t('simple.shell.businessDetails', { name })}
      >
        {name}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        className={`num ${CHIP}`}
        onClick={() => setPeriodOpen(true)}
        aria-label={t('simple.shell.period', { from: toDisplayDate(from), to: toDisplayDate(to) })}
        data-testid="btn-period"
      >
        {toDisplayDate(from)} → {toDisplayDate(to)}
      </button>
      <ViewToggle screen={screen} className={CHIP} />
      <AssistantButton
        label={t('simple.shell.assistant')}
        shortcut={t('simple.shell.assistantKey')}
        title={t('simple.shell.assistantHint')}
        openLabel={t('simple.shell.assistantOpen')}
        closeLabel={t('simple.shell.assistantClose')}
        className={CHIP}
      />
      <button type="button" data-testid="btn-theme" className={CHIP} onClick={toggle} aria-label={t('simple.shell.themeHint', { theme })}>
        {t('simple.shell.theme', { theme })}
      </button>
      <button
        type="button"
        data-testid="btn-search"
        className={`flex items-center gap-2 ${CHIP}`}
        onClick={onOpenPalette}
        title={t('simple.nav.searchHint')}
      >
        {t('simple.nav.search')} <Kbd>{t('simple.shell.searchKey')}</Kbd>
      </button>
      {user && (
        <>
          <span className={`num ${CHIP}`}>{t('simple.shell.user', { name: user.name, role: user.role })}</span>
          <button
            type="button"
            data-testid="btn-lock"
            title={t('simple.shell.lockHint')}
            className={CHIP}
            onClick={() => void lock()}
          >
            {t('simple.shell.lock')}
          </button>
        </>
      )}
    </header>
  )
}
