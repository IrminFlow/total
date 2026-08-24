import { useState, type ReactNode } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { THEME_LABEL, THEME_ORDER, useNav, useScreen, useSession, useTheme, useToasts } from '../state/stores'
import { api } from '../lib/client'
import { useAutoLock } from '../lib/useAutoLock'
import { useStickyNumber } from '../lib/useStickyTab'
import { Accel, Button, DateInput, Kbd, Modal } from './ui'
import { SupportLink } from './SupportLink'
import { HintBar } from './HintBar'
import { AskDrawer } from './AskDrawer'
import { useKeyLayer } from '../lib/keyboard'
import { toDisplayDate, fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { useFeatures } from '../lib/useFeatures'
import { NAV_SECTIONS, SCREENS } from '../lib/screens'
import { useShadowedAccels } from '../lib/screenAccels'

/** Sidebar derived from the single screen registry (lib/screens.ts). */
const NAV = NAV_SECTIONS.map((section) => ({
  ...section,
  items: SCREENS.filter((s) => s.navSection === section.id && s.screen != null).map((s) => ({
    name: s.name,
    label: s.navLabel ?? s.title,
    screen: s.screen!,
    feature: s.feature,
    accel: s.accel
  }))
}))

export function Shell({ children, onOpenPalette }: { children: ReactNode; onOpenPalette: () => void }): React.JSX.Element {
  const { info, from, to, clearCompany, user, setUser, setLocked } = useSession()
  // A machine-level preference, not a company one: it is about the desk this app is open on,
  // and a user with two companies wants the same answer for both.
  const [autoLockMinutes] = useStickyNumber('auto-lock-minutes', 0)
  useAutoLock(autoLockMinutes)
  const screen = useScreen()
  const nav = useNav()
  const toast = useToasts()
  // Letters the active screen has taken over render grey rather than red, so a shadowed
  // shortcut is visible instead of being discovered by pressing it and going nowhere.
  const shadowed = useShadowedAccels()
  const [askOpen, setAskOpen] = useState(false)
  // ⌘J from anywhere. Registered on the nav layer, so a dialog or a screen action still wins.
  useKeyLayer('nav', (e) => {
    if (!features.ai) return false
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'j') return false
    e.preventDefault()
    setAskOpen((v) => !v)
    return true
  })
  const { theme, toggle } = useTheme()
  const [periodOpen, setPeriodOpen] = useState(false)
  const fetching = useIsFetching()
  const features = useFeatures()
  const visibleNav = NAV.filter((s) => !s.feature || features[s.feature]).map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.feature || features[i.feature])
  }))

  return (
    <div className="flex h-full flex-col">
      {/* Visible only when focused. The sidebar is twenty-odd links, and tabbing past all of
          them to reach the report you just opened is the difference between a keyboard-first app
          and one that merely has shortcuts. */}
      <a
        href="#main-content"
        data-testid="skip-to-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:border-amber focus:bg-panel focus:px-3 focus:py-1.5 focus:text-detail"
        onClick={(e) => {
          // Anchor navigation in a hash-less renderer does nothing on its own, so move focus
          // explicitly — the point of the link is where the caret lands, not the URL.
          e.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to content
      </a>
      <header
        className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel pr-4 panel-shadow ${
          window.total.platform === 'darwin' ? 'pl-24' : 'pl-4'
        }`}
      >
        <button className="flex items-baseline gap-2" onClick={() => nav.go({ name: 'company-info' })} title="Company details">
          <span className="font-serif text-lead font-semibold tracking-tight">{info?.name}</span>
          {info?.gstin && <span className="num text-label text-muted">{info.gstin}</span>}
        </button>
        <div className="flex-1" />
        <button
          className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
          onClick={() => setPeriodOpen(true)}
          title="Change period"
        >
          {toDisplayDate(from)} → {toDisplayDate(to)}
        </button>
        <button
          data-testid="btn-theme"
          className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
          onClick={toggle}
          // The button names where it goes, not where it is — three themes make "Light/Dark" as
          // a state label ambiguous, and a control that reads as its own destination is the one
          // people press without thinking.
          title={`Switch theme — currently ${THEME_LABEL[theme].toLowerCase()}`}
        >
          {THEME_LABEL[THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!]}
        </button>
        <SupportLink variant="pill" />
        <button
          className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
          onClick={onOpenPalette}
        >
          Anywhere <Kbd>⌘K</Kbd>
        </button>
        {user && (
          <>
            <span className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted capitalize">
              {user.name} · {user.role}
            </span>
            <button
              data-testid="btn-lock"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
              onClick={async () => {
                try {
                  await api.auth.logout()
                  setUser(null)
                  setLocked(true)
                } catch (err) {
                  toast.push('error', (err as Error).message)
                }
              }}
            >
              Lock
            </button>
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel p-2">
          {visibleNav.map((section) => (
            <div key={section.title ?? 'top'}>
              {section.title && (
                <p className="mt-3 mb-1 px-2.5 text-label font-semibold tracking-[0.1em] text-muted/80 uppercase">
                  {section.title}
                </p>
              )}
              {section.items.map((item) => {
                const active = screen.name === item.screen.name
                return (
                  <button
                    key={item.label}
                    data-testid={`nav-${item.screen.name}`}
                    data-nav-accel={item.accel}
                    onClick={() => nav.go(item.screen)}
                    className={`block w-full rounded-md px-2.5 py-[5px] text-left text-detail transition-colors ${
                      active ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
                    }`}
                  >
                    <Accel label={item.label} accel={item.accel} muted={shadowed.has(item.accel ?? '')} />
                  </button>
                )
              })}
            </div>
          ))}
          <div className="flex-1" />
          <button
            className="rounded-md px-2.5 py-1.5 text-left text-body-sm text-muted hover:bg-panel2 hover:text-ink"
            onClick={async () => {
              try {
                await api.company.backup()
                toast.push('success', 'Backup saved')
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            Back up now
          </button>
          <button
            data-testid="btn-switch-company"
            className="rounded-md px-2.5 py-1.5 text-left text-body-sm text-muted hover:bg-panel2 hover:text-ink"
            onClick={async () => {
              try {
                await api.company.close()
                clearCompany()
                nav.home()
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            Switch company
          </button>
        </aside>

        {/* data-screen + data-loading: the E2E harness's navigation/idle markers (lib/testids.ts). */}
        <main
          id="main-content"
          tabIndex={-1}
          data-screen={screen.name}
          data-loading={fetching > 0 ? 'true' : 'false'}
          className="min-h-0 flex-1 overflow-auto p-5"
        >
          {children}
        </main>
        {/* Only rendered when the company has the assistant switched on — the drawer, its hook
            and its IPC surface are all invisible otherwise. */}
        {features.ai && askOpen && <AskDrawer onClose={() => setAskOpen(false)} />}
      </div>
      <HintBar />

      {periodOpen && <PeriodModal onClose={() => setPeriodOpen(false)} />}
    </div>
  )
}

function PeriodModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { from, to, setPeriod, info } = useSession()
  const [f, setF] = useState(from)
  const [t, setT] = useState(to)
  const currentFy = fyOf(todayISO())
  const years: number[] = []
  for (let y = info?.booksFrom ?? currentFy.startYear; y <= currentFy.startYear; y++) years.push(y)

  return (
    <Modal title="Working period" onClose={onClose}>
      <div className="flex gap-3">
        <div className="flex-1">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">From</span>
          <DateInput value={f} context={f} onChange={setF} testId="input-period-from" />
        </div>
        <div className="flex-1">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">To</span>
          <DateInput value={t} context={t} onChange={setT} testId="input-period-to" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {years.reverse().map((y) => {
          const fy = fyFromStartYear(y)
          return (
            <Button key={y} onClick={() => { setF(fy.from); setT(fy.to) }}>
              FY {fy.label}
            </Button>
          )
        })}
        <Button
          onClick={() => {
            const today = todayISO()
            setF(today.slice(0, 8) + '01')
            setT(today)
          }}
        >
          This month
        </Button>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-apply-period"
          onClick={() => {
            setPeriod(f, t)
            onClose()
          }}
        >
          Apply period
        </Button>
      </div>
    </Modal>
  )
}
