import { Suspense, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNav, useRecentScreens, useScreen, useSession } from './state/stores'
import { isPlainKey, isTypingTarget, useKeyLayer } from './lib/keyboard'
import { NAV_ACCEL, NAV_ORDER } from './lib/accel'
import { api } from './lib/client'
import { useMenuCommands } from './lib/menuCommands'
import { useFeatures } from './lib/useFeatures'
import { Button, LiveAnnouncer, Modal, Toasts } from './components/ui'
import { CompanySelect } from './screens/CompanySelect'
import { Shell } from './components/Shell'
import { Gateway } from './screens/Gateway'
import { DayBook } from './screens/DayBook'
import { VoucherEntry } from './screens/VoucherEntry'
import { Masters } from './screens/Masters'
// Everything else is code-split — see screens/lazy.ts for what is in the entry chunk and why.
import * as Lazy from './screens/lazy'
import { CommandPalette, SCREEN_SEARCH_SCOPE } from './components/CommandPalette'
import { ShortcutHelp } from './components/ShortcutHelp'
import { RecentRing } from './components/RecentRing'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LockScreen } from './components/LockScreen'
import { DialogHost } from './components/dialogs'
import { invalidationFamilies } from './lib/screens'
import type { SearchHit } from '@shared/search'

export default function App(): React.JSX.Element {
  const { slug, locked, integrityWarning, setIntegrityWarning } = useSession()
  const screen = useScreen()
  const nav = useNav()
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Non-null while the palette is open in ⌘⇧F "search this screen" mode. */
  const [paletteScope, setPaletteScope] = useState<SearchHit['kind'][] | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const features = useFeatures()
  const queryClient = useQueryClient()

  // The application menu sends command ids rather than binding accelerators of its own, so the
  // menu and the keyboard run the same actions. Navigation ids are handled inside the hook.
  useMenuCommands({
    palette: () => {
      if (!integrityWarning) {
        setPaletteScope(null)
        setPaletteOpen(true)
      }
    },
    shortcuts: () => setHelpOpen(true)
  })

  /**
   * The bottom `nav` layer: the registry accelerators plus the three app-wide keys. Everything
   * above it (a screen's own letters, a list's arrows, a modal) gets first refusal, so this is
   * reached only when nothing more specific wanted the key.
   */
  useKeyLayer('nav', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      // A blocking integrity warning must be resolved (or dismissed) before anything else is
      // reachable — opening the palette over it would let the user navigate around it.
      if (integrityWarning) return true
      setPaletteScope(null)
      setPaletteOpen((v) => !v)
      return true
    }
    // ⌘⇧F — the same palette, narrowed to what this screen is about. Checked before ⌘F below,
    // which explicitly declines when Shift is held.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      if (integrityWarning) return true
      setPaletteScope(SCREEN_SEARCH_SCOPE[screen.name] ?? null)
      setPaletteOpen(true)
      return true
    }
    // ⌘F focuses this screen's filter box, wherever it happens to be. Screens opt in with
    // `data-filter-box` rather than the nav layer knowing their layout; a screen with no filter
    // declines the key and it falls through.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      const box = document.querySelector<HTMLInputElement>('[data-filter-box]')
      if (!box) return false
      e.preventDefault()
      box.focus()
      box.select()
      return true
    }
    // ⌘[ and ⌘] walk the nav stack, the way a browser's back and forward do. Escape already
    // goes back; this pairs it with a forward, which nothing offered before.
    if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
      e.preventDefault()
      if (e.key === '[') nav.back()
      else nav.forwardTo()
      return true
    }
    // ⌘1–⌘9 jump to the first nine sidebar entries, positionally.
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const target = NAV_ORDER[Number(e.key) - 1]
      if (!target?.screen) return false
      if (target.feature && !features[target.feature]) return false
      e.preventDefault()
      if (target.name === 'gateway') nav.home()
      else nav.go(target.screen)
      return true
    }
    if (e.key === 'Escape') {
      // Esc in a field means "leave the field", not "leave the screen".
      if (isTypingTarget(e)) {
        ;(e.target as HTMLElement).blur()
        return true
      }
      nav.back()
      return true
    }
    if (e.key === '?') {
      if (isTypingTarget(e)) return false
      // Without this the '?' lands in the overlay's own search box: the keydown opens the modal
      // synchronously, React focuses the search input before the browser inserts the character,
      // and the reference opens filtered to the one shortcut that IS '?'.
      e.preventDefault()
      setHelpOpen(true)
      // One of the two checklist steps that is a preference rather than a book fact: whether the
      // user has seen what the red letters are. Fire-and-forget — a failed write costs a tick on
      // a checklist, and must never interrupt opening the help.
      void api.app.checklistDone('sawShortcuts').catch(() => undefined)
      return true
    }
    // Registry accelerators — pressing V opens voucher entry from anywhere, not just the Gateway.
    if (!isPlainKey(e) || isTypingTarget(e)) return false
    const target = NAV_ACCEL.get(e.key.toUpperCase())
    if (!target?.screen) return false
    if (target.feature && !features[target.feature]) return false
    e.preventDefault()
    if (target.name === 'gateway') nav.home()
    else nav.go(target.screen)
    return true
  })

  // The MRU ring behind ⌘` (see RecentRing). Fed from the same place the invalidation is, so a
  // screen cannot appear in the ring without having actually been rendered.
  const visit = useRecentScreens((s) => s.visit)
  useEffect(() => {
    visit(screen)
  }, [screen, visit])

  // Fresh data whenever the visible screen changes — scoped to that screen's query-key
  // families (see the registry) instead of nuking the whole cache on every navigation.
  useEffect(() => {
    for (const family of invalidationFamilies(screen.name)) {
      void queryClient.invalidateQueries({ queryKey: [family] })
    }
  }, [screen.name, queryClient])

  // Rendered once, below, regardless of which of the three layouts is active — so it survives
  // any navigation or lock-state flip that would otherwise unmount whatever triggered it (see
  // the session store's `integrityWarning` doc comment).
  const integrityModal = integrityWarning && (
    <IntegrityWarningModal warning={integrityWarning} onClose={() => setIntegrityWarning(null)} />
  )

  if (!slug) return (
    <>
      <CompanySelect />
      {integrityModal}
      <DialogHost />
      <Toasts />
      <LiveAnnouncer />
    </>
  )

  if (locked) return (
    <>
      <LockScreen />
      {integrityModal}
      <DialogHost />
      <Toasts />
      <LiveAnnouncer />
    </>
  )

  return (
    <>
      <Shell
        onOpenPalette={() => {
          setPaletteScope(null)
          setPaletteOpen(true)
        }}
      >
        <ErrorBoundary key={screen.name} screen={screen.name}>
          {/* The fallback deliberately renders NOTHING — no `data-screen` marker and no spinner.
              Every screen reports its own readiness through `data-screen`/`data-loading`, and a
              placeholder that carried either would tell the harness (and a screen reader) that a
              screen had arrived before it had. These chunks come off local disk in single-digit
              milliseconds, so what a person sees is the previous screen for one frame. */}
          <Suspense fallback={null}>
          {screen.name === 'gateway' && <Gateway />}
          {screen.name === 'daybook' && <DayBook span={screen.span} kind={screen.kind} />}
          {screen.name === 'import-tally' && <Lazy.ImportTallyScreen />}
          {screen.name === 'voucher-entry' && (
            <VoucherEntry
              key={screen.voucherId ?? (screen.draftId ? `draft-${screen.draftId}` : 'new')}
              voucherId={screen.voucherId}
              kindHint={screen.kindHint}
              draft={screen.draft}
            />
          )}
          {screen.name === 'masters' && <Masters key={screen.tab ?? 'ledgers'} tab={screen.tab} />}
          {screen.name === 'trial-balance' && <Lazy.TrialBalanceScreen />}
          {screen.name === 'profit-loss' && <Lazy.ProfitLossScreen />}
          {screen.name === 'balance-sheet' && <Lazy.BalanceSheetScreen />}
          {screen.name === 'cash-flow' && <Lazy.CashFlowScreen />}
          {screen.name === 'exceptions' && <Lazy.ExceptionsScreen />}
          {screen.name === 'stock-summary' && <Lazy.StockSummaryScreen />}
          {screen.name === 'ledger-statement' && <Lazy.LedgerStatementScreen ledgerId={screen.ledgerId} />}
          {screen.name === 'gstr1' && <Lazy.Gstr1Screen />}
          {screen.name === 'gstr3b' && <Lazy.Gstr3bScreen />}
          {screen.name === 'gstr2b' && <Lazy.Gstr2bScreen />}
          {screen.name === 'edocs' && <Lazy.EdocsScreen />}
          {screen.name === 'registers' && <Lazy.RegistersScreen />}
          {screen.name === 'outstandings' && <Lazy.OutstandingsScreen />}
          {screen.name === 'consolidated' && <Lazy.ConsolidatedScreen />}
          {screen.name === 'recurring' && <Lazy.RecurringScreen />}
          {screen.name === 'banking' && <Lazy.BankingScreen />}
          {screen.name === 'payroll' && <Lazy.PayrollScreen />}
          {screen.name === 'khata' && <Lazy.KhataScreen />}
          {screen.name === 'collections' && <Lazy.CollectionsScreen />}
          {screen.name === 'assets' && <Lazy.AssetsScreen />}
          {screen.name === 'counter' && <Lazy.CounterScreen />}
          {screen.name === 'sales-chain' && <Lazy.SalesChainScreen />}
          {screen.name === 'borrowing' && <Lazy.BorrowingScreen />}
          {screen.name === 'disclosure' && <Lazy.DisclosureScreen />}
          {screen.name === 'filings' && <Lazy.FilingsScreen />}
          {screen.name === 'job-work' && <Lazy.JobWorkScreen />}
          {screen.name === 'composition' && <Lazy.CompositionScreen />}
          {screen.name === 'tds' && <Lazy.TdsScreen />}
          {screen.name === 'cost-centres' && <Lazy.CostCentresScreen />}
          {screen.name === 'budgets' && <Lazy.BudgetsScreen />}
          {screen.name === 'year-end' && <Lazy.YearEndScreen />}
          {screen.name === 'company-info' && <Lazy.CompanyInfoScreen />}
          {screen.name === 'settings' && <Lazy.Settings key={screen.tab ?? 'backups'} tab={screen.tab} />}
          </Suspense>
        </ErrorBoundary>
      </Shell>
      {paletteOpen && <CommandPalette scope={paletteScope ?? undefined} onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      <RecentRing />
      {integrityModal}
      <DialogHost />
      <Toasts />
      <LiveAnnouncer />
    </>
  )
}

function IntegrityWarningModal({
  warning,
  onClose
}: {
  warning: { quickCheck: string; unbalancedVoucherIds: number[]; context: string }
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal title="Integrity warning" onClose={onClose}>
      <p className="text-detail text-cr">
        Integrity check found an issue: {warning.quickCheck}
        {warning.unbalancedVoucherIds.length ? ` — ${warning.unbalancedVoucherIds.length} unbalanced voucher(s)` : ''}
      </p>
      <p className="mt-2 text-body-sm text-muted">
        The books were {warning.context}. Review the Day Book and Trial Balance carefully before continuing.
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Continue
        </Button>
      </div>
    </Modal>
  )
}
