import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNav, useScreen, useSession } from './state/stores'
import { Toasts } from './components/ui'
import { CompanySelect } from './screens/CompanySelect'
import { Shell } from './components/Shell'
import { Gateway } from './screens/Gateway'
import { DayBook } from './screens/DayBook'
import { VoucherEntry } from './screens/VoucherEntry'
import { Masters } from './screens/Masters'
import { TrialBalanceScreen } from './screens/TrialBalance'
import { ProfitLossScreen } from './screens/ProfitLoss'
import { BalanceSheetScreen } from './screens/BalanceSheet'
import { StockSummaryScreen } from './screens/StockSummary'
import { LedgerStatementScreen } from './screens/LedgerStatement'
import { Gstr1Screen, Gstr3bScreen } from './screens/GstReturns'
import { CompanyInfoScreen } from './screens/CompanyInfo'
import { RegistersScreen } from './screens/Registers'
import { OutstandingsScreen } from './screens/Outstandings'
import { BankingScreen } from './screens/Banking'
import { EdocsScreen } from './screens/Edocs'
import { PayrollScreen } from './screens/Payroll'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'

export default function App(): React.JSX.Element {
  const { slug } = useSession()
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

  if (!slug) return (
    <>
      <CompanySelect />
      <Toasts />
    </>
  )

  return (
    <>
      <Shell onOpenPalette={() => setPaletteOpen(true)}>
        <ErrorBoundary key={screen.name} screen={screen.name}>
          {screen.name === 'gateway' && <Gateway />}
          {screen.name === 'daybook' && <DayBook />}
          {screen.name === 'voucher-entry' && <VoucherEntry key={screen.voucherId ?? 'new'} voucherId={screen.voucherId} kindHint={screen.kindHint} />}
          {screen.name === 'masters' && <Masters tab={screen.tab} />}
          {screen.name === 'trial-balance' && <TrialBalanceScreen />}
          {screen.name === 'profit-loss' && <ProfitLossScreen />}
          {screen.name === 'balance-sheet' && <BalanceSheetScreen />}
          {screen.name === 'stock-summary' && <StockSummaryScreen />}
          {screen.name === 'ledger-statement' && <LedgerStatementScreen ledgerId={screen.ledgerId} />}
          {screen.name === 'gstr1' && <Gstr1Screen />}
          {screen.name === 'gstr3b' && <Gstr3bScreen />}
          {screen.name === 'edocs' && <EdocsScreen />}
          {screen.name === 'registers' && <RegistersScreen />}
          {screen.name === 'outstandings' && <OutstandingsScreen />}
          {screen.name === 'banking' && <BankingScreen />}
          {screen.name === 'payroll' && <PayrollScreen />}
          {screen.name === 'company-info' && <CompanyInfoScreen />}
        </ErrorBoundary>
      </Shell>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <Toasts />
    </>
  )
}
