import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { usePeriodPicker, useScreen, useSession, useTheme, useToasts, useNav } from '../state/stores'
import { Kbd } from '../components/ui'
import { fyOf, toMonthLabel, toPlainDate } from '@shared/dates'
import { ViewToggle } from './ViewToggle'
import { AssistantButton } from '../components/ai/AssistantButton'
import { useHelpPanel } from '../help/store'
import { helpKeyFor } from '../lib/screens'

// WP 10.5: chips never shrink or wrap (a two-line chip overflowed the 48 px header at 1024 px);
// the business name gives way instead (truncated, its full name in the accessible name), and the
// key hints (⌘J, ?, ⌘K) hide under 1200 px (app.css).
const CHIP = 'shrink-0 whitespace-nowrap rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink'

/**
 * WP 8.1: the simple shell's header — the business name (→ business details), the dates shown,
 * "Search ⌘K" (the palette), the light / dark switch, the per-screen "Accountant view" toggle and,
 * with users, who is signed in + Lock.
 */
const SHORT = 'short' as const // i18n-technical: month-name style

export function SimpleHeader({ onOpenPalette }: { onOpenPalette: () => void }): React.JSX.Element {
  const t = useT()
  // WP 10.4 review: in Hindi the period chip names its months in Hindi (01-Apr-26 was English).
  // WP 10.8: plain dates in every language; a whole financial year is said as its months
  // ("This year: Apr 2026 – Mar 2027"), never the accountant's 01-Apr-26 → 31-Mar-27.
  const periodDate = (d: string): string => toPlainDate(d, t.lang)
  const month = (d: string): string => `${toMonthLabel(d.slice(0, 7), SHORT, t.lang)} ${d.slice(0, 4)}`
  const nav = useNav()
  const screen = useScreen()
  const toast = useToasts()
  const { info, from, to, user, setUser, setLocked, workingDate } = useSession()
  const { theme, toggle } = useTheme()
  const setPeriodOpen = usePeriodPicker((s) => s.setOpen)
  const helpOpen = useHelpPanel((s) => s.open)
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
        className="min-w-0 truncate rounded-md font-serif text-subtitle font-semibold tracking-tight"
        onClick={openBusiness}
        aria-label={t('simple.shell.businessDetails', { name })}
      >
        {name}
      </button>
      <div className="min-w-2 flex-1" />
      <button
        type="button"
        className={`num ${CHIP}`}
        onClick={() => setPeriodOpen(true)}
        aria-label={t('simple.shell.period', { from: periodDate(from), to: periodDate(to) })}
        data-testid="btn-period"
      >
        {periodChip(from, to, workingDate, month, periodDate, t)}
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
      <button
        type="button"
        data-testid="btn-help"
        className={`flex items-center gap-2 ${CHIP}`}
        title={t('simple.shell.helpHint')}
        aria-expanded={helpOpen}
        onClick={() => useHelpPanel.getState().toggleForScreen(helpKeyFor(screen))}
      >
        {t('simple.shell.help')} <Kbd>{t('simple.shell.helpKey')}</Kbd>
      </button>
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
          <span className={`num max-w-48 truncate ${CHIP}`} title={t('simple.shell.user', { name: user.name, role: user.role })}>
            {t('simple.shell.user', { name: user.name, role: user.role })}
          </span>
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

/** WP 10.8: the period chip in plain words — the year that holds today, another whole year, or two dates. */
export function periodChip(
  from: string,
  to: string,
  today: string,
  month: (d: string) => string,
  date: (d: string) => string,
  t: ReturnType<typeof useT>
): string {
  const fy = fyOf(from)
  if (fy.from === from && fy.to === to) {
    const vars = { from: month(from), to: month(to) }
    return today >= from && today <= to ? t('simple.shell.periodThisYear', vars) : t('simple.shell.periodRange', vars)
  }
  return t('simple.shell.periodRange', { from: date(from), to: date(to) })
}
