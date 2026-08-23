import { useState, type ReactNode } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { useNav, useScreen, useSession, useTheme, useToasts } from '../state/stores'
import { api } from '../lib/client'
import { Button, DateInput, Kbd, Modal } from './ui'
import { SupportLink } from './SupportLink'
import { toDisplayDate, fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { useFeatures } from '../lib/useFeatures'
import { NAV_SECTIONS, SCREENS } from '../lib/screens'

/** Sidebar derived from the single screen registry (lib/screens.ts). */
const NAV = NAV_SECTIONS.map((section) => ({
  ...section,
  items: SCREENS.filter((s) => s.navSection === section.id && s.screen != null).map((s) => ({
    label: s.navLabel ?? s.title,
    screen: s.screen!,
    feature: s.feature
  }))
}))

export function Shell({ children, onOpenPalette }: { children: ReactNode; onOpenPalette: () => void }): React.JSX.Element {
  const { info, from, to, clearCompany, user, setUser, setLocked } = useSession()
  const screen = useScreen()
  const nav = useNav()
  const toast = useToasts()
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
      <header
        className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel pr-4 panel-shadow ${
          window.total.platform === 'darwin' ? 'pl-24' : 'pl-4'
        }`}
      >
        <button className="flex items-baseline gap-2" onClick={() => nav.go({ name: 'company-info' })} title="Company details">
          <span className="font-serif text-[15px] font-semibold tracking-tight">{info?.name}</span>
          {info?.gstin && <span className="num text-[10.5px] text-muted">{info.gstin}</span>}
        </button>
        <div className="flex-1" />
        <button
          className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
          onClick={() => setPeriodOpen(true)}
          title="Change period"
        >
          {toDisplayDate(from)} → {toDisplayDate(to)}
        </button>
        <button
          data-testid="btn-theme"
          className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
          onClick={toggle}
          title="Switch theme"
        >
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
        <button
          className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
          onClick={onOpenPalette}
        >
          Anywhere <Kbd>⌘K</Kbd>
        </button>
        {user && (
          <>
            <span className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted capitalize">
              {user.name} · {user.role}
            </span>
            <button
              data-testid="btn-lock"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
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
                <p className="mt-3 mb-1 px-2.5 text-[10px] font-semibold tracking-[0.1em] text-muted/80 uppercase">
                  {section.title}
                </p>
              )}
              {section.items.map((item) => {
                const active = screen.name === item.screen.name
                return (
                  <button
                    key={item.label}
                    data-testid={`nav-${item.screen.name}`}
                    onClick={() => nav.go(item.screen)}
                    className={`block w-full rounded-md px-2.5 py-[5px] text-left text-[13px] transition-colors ${
                      active ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          ))}
          <div className="flex-1" />
          <button
            className="rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel2 hover:text-ink"
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
            className="rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel2 hover:text-ink"
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
          <div className="mt-2 border-t border-line pt-2">
            <SupportLink />
          </div>
        </aside>

        {/* data-screen + data-loading: the E2E harness's navigation/idle markers (lib/testids.ts). */}
        <main
          data-screen={screen.name}
          data-loading={fetching > 0 ? 'true' : 'false'}
          className="min-h-0 flex-1 overflow-auto p-5"
        >
          {children}
        </main>
      </div>

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
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">From</span>
          <DateInput value={f} context={f} onChange={setF} testId="input-period-from" />
        </div>
        <div className="flex-1">
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">To</span>
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
