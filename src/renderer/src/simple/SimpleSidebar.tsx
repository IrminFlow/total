import { useState, type FocusEvent, type MouseEvent } from 'react'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { SIMPLE_SECTIONS, simpleSectionOf } from '../lib/screens'
import { useFeatures } from '../lib/useFeatures'
import { useSimpleNavCollapsed } from '../lib/simpleLayout'
import { useNav, useScreen, useSession, useToasts, type Screen } from '../state/stores'
import { SupportLink } from '../components/SupportLink'
import { TotalLogo } from '../components/TotalLogo'
import { PlainIcon } from './icons'
import type { SimpleSectionId } from '@shared/simple/uiMode'

const HOME: Screen = { name: 'gateway' } // i18n-technical

const target = (id: SimpleSectionId): Screen => (id === 'home' ? HOME : { name: 'simple-section', section: id })

/** WP 10.5: each section's icon (simple/icons.tsx) — alone in the narrow sidebar. */
const SECTION_ICON: Record<SimpleSectionId, string> = {
  home: 'home', // i18n-technical: icon ids
  sell: 'receipt', // i18n-technical
  buy: 'cart', // i18n-technical
  money: 'wallet', // i18n-technical
  stock: 'box', // i18n-technical
  people: 'users', // i18n-technical
  reports: 'chart', // i18n-technical
  taxes: 'percent', // i18n-technical
  settings: 'gear' // i18n-technical
}

/**
 * WP 8.1: the simple shell's sidebar (plan §2.2) — at most ten entries: Home, Sell, Buy, Money,
 * Stock (with inventory on), People, Reports, Taxes, Settings; Back up now and Switch business at
 * the foot. Every word comes from t().
 *
 * WP 10.5: under 1200 px (lib/simpleLayout) it shrinks to icons. Each button keeps its label as
 * its accessible name (aria-label) and shows it beside the icon on hover or keyboard focus.
 */
export function SimpleSidebar(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const screen = useScreen()
  const toast = useToasts()
  const features = useFeatures()
  const collapsed = useSimpleNavCollapsed()
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null)
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
  /** Hover / focus props: the label beside a narrow-sidebar button. */
  const tipFor = (label: string) =>
    collapsed
      ? {
          'aria-label': label,
          onMouseEnter: (e: MouseEvent<HTMLElement>) => show(label, e.currentTarget),
          onFocus: (e: FocusEvent<HTMLElement>) => show(label, e.currentTarget),
          onMouseLeave: () => setTip(null),
          onBlur: () => setTip(null)
        }
      : {}
  const show = (label: string, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setTip({ label, top: r.top + r.height / 2, left: r.right + 8 })
  }
  const btn = (on: boolean): string =>
    `flex w-full items-center gap-2.5 rounded-md py-2 text-left text-body ${collapsed ? 'justify-center px-0' : 'px-3'} ${
      on ? 'bg-amberbar/20 font-semibold text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
    }`
  const foot = `flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-body-sm text-muted hover:bg-panel2 hover:text-ink ${collapsed ? 'justify-center px-0' : 'px-3'}`

  return (
    <nav
      aria-label={t('simple.shell.nav')}
      data-testid="simple-nav"
      data-collapsed={collapsed ? 'true' : undefined}
      className={`flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-panel p-2 ${collapsed ? 'w-16' : 'w-52'}`}
    >
      <div className={`mb-2 flex items-center gap-2 py-2 ${collapsed ? 'justify-center' : 'px-2'}`}>
        <TotalLogo size={28} />
        {!collapsed && <span className="font-serif text-brand font-semibold tracking-tight">{t('common.appName')}</span>}
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
            {...tipFor(label)}
          >
            {collapsed && <PlainIcon id={SECTION_ICON[s.id]} />}
            {!collapsed && label}
          </button>
        )
      })}
      <div className="flex-1" />
      <button type="button" data-testid="btn-backup-now" className={foot} onClick={() => void backup()} {...tipFor(t('simple.nav.backupNow'))}>
        {collapsed ? <PlainIcon id="save" /> : t('simple.nav.backupNow')}
      </button>
      <button type="button" data-testid="btn-switch-company" className={foot} onClick={() => void switchCompany()} {...tipFor(t('simple.nav.switchCompany'))}>
        {collapsed ? <PlainIcon id="swap" /> : t('simple.nav.switchCompany')}
      </button>
      <div className={`mt-2 border-t border-line pt-2 ${collapsed ? 'flex justify-center' : ''}`}>
        <SupportLink compact={collapsed} />
      </div>
      {tip && (
        <span
          aria-hidden="true"
          data-testid="simple-nav-tip"
          style={{ top: tip.top, left: tip.left }}
          className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md border border-line bg-raised px-2.5 py-1 text-detail whitespace-nowrap text-ink shadow-elev-2"
        >
          {tip.label}
        </span>
      )}
    </nav>
  )
}
