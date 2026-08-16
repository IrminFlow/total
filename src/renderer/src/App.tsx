import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNav, useScreen, useSession } from './state/stores'
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
import { CostCentresScreen } from './screens/CostCentres'
import { BudgetsScreen } from './screens/Budgets'
import { YearEndScreen } from './screens/YearEnd'
import { Settings } from './screens/Settings'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LockScreen } from './components/LockScreen'

export default function App(): React.JSX.Element {
  const { slug, locked, integrityWarning, setIntegrityWarning } = useSession()
  const screen = useScreen()
  const nav = useNav()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const queryClient = useQueryClient()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (paletteOpen) return
      if (e.key === 'Escape') {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          ;(e.target as HTMLElement).blur()
          return
        }
        nav.back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, nav])

  // Fresh data whenever the visible screen changes (vouchers affect every report).
  useEffect(() => {
    queryClient.invalidateQueries()
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
      <Toasts />
    </>
  )

  if (locked) return (
    <>
      <LockScreen />
      {integrityModal}
      <Toasts />
    </>
  )

  return (
    <>
      <Shell onOpenPalette={() => setPaletteOpen(true)}>
        <ErrorBoundary key={screen.name} screen={screen.name}>
          {screen.name === 'gateway' && <Gateway />}
          {screen.name === 'daybook' && <DayBook />}
          {screen.name === 'import-tally' && <ImportTallyScreen />}
          {screen.name === 'voucher-entry' && (
            <VoucherEntry
              key={screen.voucherId ?? (screen.draftId ? `draft-${screen.draftId}` : 'new')}
              voucherId={screen.voucherId}
              kindHint={screen.kindHint}
              draft={screen.draft}
            />
          )}
          {screen.name === 'masters' && <Masters tab={screen.tab} />}
          {screen.name === 'trial-balance' && <TrialBalanceScreen />}
          {screen.name === 'profit-loss' && <ProfitLossScreen />}
          {screen.name === 'balance-sheet' && <BalanceSheetScreen />}
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
          {screen.name === 'tds' && <TdsScreen />}
          {screen.name === 'cost-centres' && <CostCentresScreen />}
          {screen.name === 'budgets' && <BudgetsScreen />}
          {screen.name === 'year-end' && <YearEndScreen />}
          {screen.name === 'company-info' && <CompanyInfoScreen />}
          {screen.name === 'settings' && <Settings key={screen.tab ?? 'backups'} tab={screen.tab} />}
        </ErrorBoundary>
      </Shell>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {integrityModal}
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
      <p className="text-[13px] text-cr">
        Integrity check found an issue: {warning.quickCheck}
        {warning.unbalancedVoucherIds.length ? ` — ${warning.unbalancedVoucherIds.length} unbalanced voucher(s)` : ''}
      </p>
      <p className="mt-2 text-[12.5px] text-muted">
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
