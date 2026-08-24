import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNav, useScreen, useSession } from './state/stores'
import { isPlainKey, isTypingTarget, useKeyLayer } from './lib/keyboard'
import { NAV_ACCEL, NAV_ORDER } from './lib/accel'
import { useMenuCommands } from './lib/menuCommands'
import { useFeatures } from './lib/useFeatures'
import { Button, Modal, Toasts } from './components/ui'
import { CompanySelect } from './screens/CompanySelect'
import { Shell } from './components/Shell'
import { Gateway } from './screens/Gateway'
import { DayBook } from './screens/DayBook'
import { ImportTallyScreen } from './screens/ImportTally'
import { VoucherEntry } from './screens/VoucherEntry'
import { Masters } from './screens/Masters'
import { TrialBalanceScreen } from './screens/TrialBalance'
import { ProfitLossScreen } from './screens/ProfitLoss'
import { BalanceSheetScreen } from './screens/BalanceSheet'
import { CashFlowScreen } from './screens/CashFlow'
import { ExceptionsScreen } from './screens/Exceptions'
import { StockSummaryScreen } from './screens/StockSummary'
import { LedgerStatementScreen } from './screens/LedgerStatement'
import { Gstr1Screen, Gstr3bScreen } from './screens/GstReturns'
import { Gstr2bScreen } from './screens/Gstr2b'
import { CompanyInfoScreen } from './screens/CompanyInfo'
import { RegistersScreen } from './screens/Registers'
import { OutstandingsScreen } from './screens/Outstandings'
import { ConsolidatedScreen } from './screens/Consolidated'
import { RecurringScreen } from './screens/Recurring'
import { BankingScreen } from './screens/Banking'
import { EdocsScreen } from './screens/Edocs'
import { PayrollScreen } from './screens/Payroll'
import { TdsScreen } from './screens/Tds'
import { CompositionScreen } from './screens/Composition'
import { FilingsScreen } from './screens/Filings'
import { CostCentresScreen } from './screens/CostCentres'
import { BudgetsScreen } from './screens/Budgets'
import { YearEndScreen } from './screens/YearEnd'
import { Settings } from './screens/Settings'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutHelp } from './components/ShortcutHelp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LockScreen } from './components/LockScreen'
import { DialogHost } from './components/dialogs'
import { invalidationFamilies } from './lib/screens'

export default function App(): React.JSX.Element {
  const { slug, locked, integrityWarning, setIntegrityWarning } = useSession()
  const screen = useScreen()
  const nav = useNav()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const features = useFeatures()
  const queryClient = useQueryClient()

  // The application menu sends command ids rather than binding accelerators of its own, so the
  // menu and the keyboard run the same actions. Navigation ids are handled inside the hook.
  useMenuCommands({
    palette: () => {
      if (!integrityWarning) setPaletteOpen(true)
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
      setPaletteOpen((v) => !v)
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
      setHelpOpen(true)
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
    </>
  )

  if (locked) return (
    <>
      <LockScreen />
      {integrityModal}
      <DialogHost />
      <Toasts />
    </>
  )

  return (
    <>
      <Shell onOpenPalette={() => setPaletteOpen(true)}>
        <ErrorBoundary key={screen.name} screen={screen.name}>
          {screen.name === 'gateway' && <Gateway />}
          {screen.name === 'daybook' && <DayBook span={screen.span} kind={screen.kind} />}
          {screen.name === 'import-tally' && <ImportTallyScreen />}
          {screen.name === 'voucher-entry' && (
            <VoucherEntry
              key={screen.voucherId ?? (screen.draftId ? `draft-${screen.draftId}` : 'new')}
              voucherId={screen.voucherId}
              kindHint={screen.kindHint}
              draft={screen.draft}
            />
          )}
          {screen.name === 'masters' && <Masters key={screen.tab ?? 'ledgers'} tab={screen.tab} />}
          {screen.name === 'trial-balance' && <TrialBalanceScreen />}
          {screen.name === 'profit-loss' && <ProfitLossScreen />}
          {screen.name === 'balance-sheet' && <BalanceSheetScreen />}
          {screen.name === 'cash-flow' && <CashFlowScreen />}
          {screen.name === 'exceptions' && <ExceptionsScreen />}
          {screen.name === 'stock-summary' && <StockSummaryScreen />}
          {screen.name === 'ledger-statement' && <LedgerStatementScreen ledgerId={screen.ledgerId} />}
          {screen.name === 'gstr1' && <Gstr1Screen />}
          {screen.name === 'gstr3b' && <Gstr3bScreen />}
          {screen.name === 'gstr2b' && <Gstr2bScreen />}
          {screen.name === 'edocs' && <EdocsScreen />}
          {screen.name === 'registers' && <RegistersScreen />}
          {screen.name === 'outstandings' && <OutstandingsScreen />}
          {screen.name === 'consolidated' && <ConsolidatedScreen />}
          {screen.name === 'recurring' && <RecurringScreen />}
          {screen.name === 'banking' && <BankingScreen />}
          {screen.name === 'payroll' && <PayrollScreen />}
          {screen.name === 'filings' && <FilingsScreen />}
          {screen.name === 'composition' && <CompositionScreen />}
          {screen.name === 'tds' && <TdsScreen />}
          {screen.name === 'cost-centres' && <CostCentresScreen />}
          {screen.name === 'budgets' && <BudgetsScreen />}
          {screen.name === 'year-end' && <YearEndScreen />}
          {screen.name === 'company-info' && <CompanyInfoScreen />}
          {screen.name === 'settings' && <Settings key={screen.tab ?? 'backups'} tab={screen.tab} />}
        </ErrorBoundary>
      </Shell>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {integrityModal}
      <DialogHost />
      <Toasts />
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
