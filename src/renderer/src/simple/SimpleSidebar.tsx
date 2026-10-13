import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { SIMPLE_SECTIONS, simpleSectionOf } from '../lib/screens'
import { useFeatures } from '../lib/useFeatures'
import { useNav, useScreen, useSession, useToasts, type Screen } from '../state/stores'
import { SupportLink } from '../components/SupportLink'
import { TotalLogo } from '../components/TotalLogo'
import type { SimpleSectionId } from '@shared/simple/uiMode'

const HOME: Screen = { name: 'gateway' } // i18n-technical

const target = (id: SimpleSectionId): Screen => (id === 'home' ? HOME : { name: 'simple-section', section: id })

/**
 * WP 8.1: the simple shell's sidebar (plan §2.2) — at most ten entries: Home, Sell, Buy, Money,
 * Stock (with inventory on), People, Reports, Taxes, Settings; Back up now and Switch business at
 * the foot. Every word comes from t().
 */
export function SimpleSidebar(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const screen = useScreen()
  const toast = useToasts()
  const features = useFeatures()
  const clearCompany = useSession((s) => s.clearCompany)
  const active = simpleSectionOf(screen)
  const sections = SIMPLE_SECTIONS.filter((s) => !s.feature || features[s.feature])
  const backup = async (): Promise<void> => {
    try {
      await api.company.backup()
      toast.push('success', t('simple.shell.backupSaved'))
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const switchCompany = async (): Promise<void> => {
    try {
      await api.company.close()
      clearCompany()
      nav.home()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const btn = (on: boolean): string =>
    `block w-full rounded-md px-3 py-2 text-left text-body ${
      on ? 'bg-amberbar/20 font-semibold text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
    }`

  return (
    <nav aria-label={t('simple.shell.nav')} data-testid="simple-nav" className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-panel p-2">
      <div className="mb-2 flex items-center gap-2 px-2 py-2">
        <TotalLogo size={28} />
        <span className="font-serif text-brand font-semibold tracking-tight">{t('common.appName')}</span>
      </div>
      {sections.map((s) => {
        const label = t(s.label) // i18n-technical: registry key (simple.nav.*), checked in simpleRegistry.test
        return (
          <button
            type="button"
            key={s.id}
            data-testid={`simple-nav-${s.id}`}
            aria-current={active === s.id ? 'page' : undefined}
            onClick={() => nav.go(target(s.id))}
            className={btn(active === s.id)}
          >
            {label}
          </button>
        )
      })}
      <div className="flex-1" />
      <button
        type="button"
        data-testid="btn-backup-now"
        className="rounded-md px-3 py-1.5 text-left text-body-sm text-muted hover:bg-panel2 hover:text-ink"
        onClick={() => void backup()}
      >
        {t('simple.nav.backupNow')}
      </button>
      <button
        type="button"
        data-testid="btn-switch-company"
        className="rounded-md px-3 py-1.5 text-left text-body-sm text-muted hover:bg-panel2 hover:text-ink"
        onClick={() => void switchCompany()}
      >
        {t('simple.nav.switchCompany')}
      </button>
      <div className="mt-2 border-t border-line pt-2">
        <SupportLink />
      </div>
    </nav>
  )
}
