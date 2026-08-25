import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIsFetching } from '@tanstack/react-query'
import { THEME_LABEL, THEME_ORDER, useNav, useScreen, useSession, useTheme, useToasts } from '../state/stores'
import { api } from '../lib/client'
import { useAutoLock } from '../lib/useAutoLock'
import { useStickyNumber } from '../lib/useStickyTab'
import { Accel, Button, DateInput, Kbd, Modal } from './ui'
import { SupportLink } from './SupportLink'
import { HintBar } from './HintBar'
import { AskDrawer } from './AskDrawer'
import { isPlainKey, isTypingTarget, useKeyLayer } from '../lib/keyboard'
import { toDisplayDate, todayISO } from '@shared/dates'
import { matchingPreset, periodPresets, type PeriodPreset } from '@shared/periodPresets'
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
  /**
   * ⌘⇧P opens the working-period picker from anywhere (roadmap A13).
   *
   * A chord rather than a bare letter because every letter navigates somewhere, and P is the
   * Profit & Loss screen. ⌘P is Print in the application menu and ⌘⇧P was the only free shift
   * chord next to it — the two things one asks of a report on the way out.
   */
  useKeyLayer('nav', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'p') return false
    e.preventDefault()
    setPeriodOpen(true)
    return true
  })
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
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:border-accent focus:bg-panel focus:px-3 focus:py-1.5 focus:text-detail"
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
          data-testid="btn-period"
          className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-accent/60 hover:text-ink"
          onClick={() => setPeriodOpen(true)}
          title="Change the working period — ⌘⇧P"
        >
          {toDisplayDate(from)} → {toDisplayDate(to)}
        </button>
        <button
          data-testid="btn-theme"
          className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-accent/60 hover:text-ink"
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
          className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-accent/60 hover:text-ink"
          onClick={onOpenPalette}
        >
          Anywhere <Kbd>⌘K</Kbd>
        </button>
        <AuditorPill />
        {user && (
          <>
            <span className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted capitalize">
              {user.name} · {user.role}
            </span>
            <button
              data-testid="btn-lock"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-accent/60 hover:text-ink"
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
                      active ? 'bg-accentbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
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

/**
 * The working-period picker — fully keyboard-operable (roadmap A13).
 *
 * Opened by ⌘⇧P or by the pill in the header. Inside: one key per quick-pick preset, ↑↓ to walk
 * them, Enter to commit, Esc to cancel (the Modal's own opaque layer), and the two date fields
 * on Tab with the usual Tally shorthand.
 *
 * Moving the highlight writes the preset into the two fields immediately rather than waiting for
 * Enter, so the dates are visible before they are committed — otherwise the dialog is six
 * phrases whose meaning ("this quarter", read in February) the reader has to work out unaided.
 */
function PeriodModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { from, to, setPeriod } = useSession()
  const [f, setF] = useState(from)
  const [t, setT] = useState(to)
  // Fixed at open: a dialog whose "this month" moves under the reader at midnight is a stranger
  // bug than one that is a day stale, and it is on screen for seconds.
  const presets = useMemo(() => periodPresets(todayISO()), [])
  const [cursor, setCursor] = useState(() => {
    const match = matchingPreset(presets, from, to)
    return match ? presets.indexOf(match) : -1
  })
  const listRef = useRef<HTMLDivElement>(null)

  const pick = (i: number): void => {
    const p = presets[i]
    if (!p) return
    setCursor(i)
    setF(p.from)
    setT(p.to)
    // Roving tabindex: the highlighted option is the one Tab lands on, so the six presets are a
    // single stop in the tab order rather than six.
    listRef.current?.querySelector<HTMLElement>(`[data-preset-index="${i}"]`)?.focus()
  }

  const commit = (): void => {
    setPeriod(f, t)
    onClose()
  }

  /**
   * Pushed by PeriodModal, which is the PARENT of <Modal>: React runs a child's effects before
   * its parent's, so this layer lands ABOVE the Modal's opaque Esc layer and actually sees these
   * keys. Pushed from inside the Modal it would sit underneath and never fire.
   */
  useKeyLayer('list', (e) => {
    if (isTypingTarget(e) || !isPlainKey(e)) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next =
        cursor < 0 ? (step === 1 ? 0 : presets.length - 1) : (cursor + step + presets.length) % presets.length
      pick(next)
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      return true
    }
    const i = presets.findIndex((p) => p.key.toLowerCase() === e.key.toLowerCase())
    if (i >= 0) {
      e.preventDefault()
      pick(i)
      return true
    }
    return false
  })

  // Focus the presets rather than the ✕ the focus trap would otherwise land on: the arrows and
  // Enter are the point of this dialog, and a caret parked on Close makes Enter mean "cancel".
  useEffect(() => {
    const list = listRef.current
    const index = cursor < 0 ? 0 : cursor
    ;(list?.querySelector<HTMLElement>(`[data-preset-index="${index}"]`) ?? list)?.focus()
    // Once, on open — every later focus move belongs to whatever the user pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal title="Working period" onClose={onClose}>
      <div ref={listRef} role="listbox" aria-label="Quick periods" className="grid grid-cols-2 gap-1.5">
        {presets.map((p, i) => (
          <PresetOption
            key={p.id}
            preset={p}
            index={i}
            selected={i === cursor}
            // With a hand-typed range nothing is selected, and a listbox where every option is
            // tabIndex -1 is a listbox Tab cannot reach at all — so the first option holds the
            // stop until a preset is chosen.
            tabStop={i === (cursor < 0 ? 0 : cursor)}
            onPick={() => pick(i)}
          />
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <div className="flex-1">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">From</span>
          <DateInput
            value={f}
            context={f}
            onChange={(v) => {
              setF(v)
              // A hand-typed date is no longer any of the presets, and leaving one highlighted
              // would say it was.
              setCursor(-1)
            }}
            testId="input-period-from"
          />
        </div>
        <div className="flex-1">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">To</span>
          <DateInput
            value={t}
            context={t}
            onChange={(v) => {
              setT(v)
              setCursor(-1)
            }}
            testId="input-period-to"
          />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        <p className="text-hint text-muted">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> choose · <Kbd>↵</Kbd> apply · <Kbd>Esc</Kbd> cancel
        </p>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-apply-period" onClick={commit}>
            Apply period
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * One quick-pick period.
 *
 * `role="option"` on a div rather than a <button>, deliberately: Enter commits the whole dialog,
 * and a button would also fire its own activation on that same keypress — so one Enter would
 * pick a preset AND apply the range that was showing before it.
 */
function PresetOption({
  preset,
  index,
  selected,
  tabStop,
  onPick
}: {
  preset: PeriodPreset
  index: number
  selected: boolean
  tabStop: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-preset-index={index}
      data-testid={`preset-${preset.id}`}
      onClick={onPick}
      className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-detail outline-none ${
        selected ? 'border-accentbar bg-accent/10 text-ink' : 'border-line text-muted hover:border-accent/60 hover:text-ink'
      }`}
    >
      <span>{preset.label}</span>
      <Kbd>{preset.key}</Kbd>
    </div>
  )
}


/**
 * "You are an auditor, and this ends at 4:20."
 *
 * A read-only session with nothing on screen to say so is a session somebody forgets they are in
 * — and then reports the app as broken when a save is refused. The countdown is the other half:
 * an auditor who can see the clock asks for more time rather than being cut off mid-sentence.
 *
 * Absent entirely when no session is open, which is almost always, so it costs nothing to look at.
 */
function AuditorPill(): React.JSX.Element | null {
  const { slug, locked } = useSession()
  const { data } = useQuery({
    queryKey: ['auditorStatus'],
    queryFn: () => api.auditor.status(),
    enabled: !!slug && !locked,
    refetchInterval: 60_000
  })
  if (!data?.active) return null
  return (
    <span
      data-testid="pill-auditor-session"
      className="rounded-md border border-accent/60 bg-accent/15 px-2.5 py-1 text-small text-accent"
      title={data.grantedBy ? `Let in by ${data.grantedBy}` : undefined}
    >
      Auditor · read only · {data.timeLeft}
    </span>
  )
}
