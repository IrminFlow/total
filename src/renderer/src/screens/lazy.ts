import { lazy } from 'react'

/**
 * The screens that are code-split out of the startup chunk (roadmap K#226).
 *
 * The split is not "biggest files first". It is by whether a screen is on the path a person walks
 * every day: the Gateway they land on, the Day Book, voucher entry and Masters stay in the entry
 * chunk, because a lazy chunk on those would trade startup for a stutter on the busiest keys in
 * the app. Everything below is a screen a given business may never open at all — a services firm
 * has no godowns, a trader runs no payroll, and nobody opens Year end in July.
 *
 * Vite gives each of these its own chunk because the import is dynamic. They load from the app's
 * own asar on first navigation, which is a local file read and not a network round trip.
 *
 * Written one line per screen rather than through a helper so that the component types survive:
 * `lazy()` keeps the props of what the factory resolves to, and App.tsx is still type-checked
 * against each screen's real signature. A generic loader would erase that and the first wrong
 * prop would be found by a user.
 *
 * Adding a screen here is safe. Moving one OUT of here needs a reason, because the entry chunk is
 * parsed and evaluated before anything at all is on screen.
 */

export const TrialBalanceScreen = lazy(async () => ({
  default: (await import('./TrialBalance')).TrialBalanceScreen
}))
export const ProfitLossScreen = lazy(async () => ({ default: (await import('./ProfitLoss')).ProfitLossScreen }))
export const BalanceSheetScreen = lazy(async () => ({
  default: (await import('./BalanceSheet')).BalanceSheetScreen
}))
export const CashFlowScreen = lazy(async () => ({ default: (await import('./CashFlow')).CashFlowScreen }))
export const ExceptionsScreen = lazy(async () => ({ default: (await import('./Exceptions')).ExceptionsScreen }))
export const StockSummaryScreen = lazy(async () => ({
  default: (await import('./StockSummary')).StockSummaryScreen
}))
export const LedgerStatementScreen = lazy(async () => ({
  default: (await import('./LedgerStatement')).LedgerStatementScreen
}))
export const Gstr1Screen = lazy(async () => ({ default: (await import('./GstReturns')).Gstr1Screen }))
export const Gstr3bScreen = lazy(async () => ({ default: (await import('./GstReturns')).Gstr3bScreen }))
export const Gstr2bScreen = lazy(async () => ({ default: (await import('./Gstr2b')).Gstr2bScreen }))
export const EdocsScreen = lazy(async () => ({ default: (await import('./Edocs')).EdocsScreen }))
export const RegistersScreen = lazy(async () => ({ default: (await import('./Registers')).RegistersScreen }))
export const OutstandingsScreen = lazy(async () => ({
  default: (await import('./Outstandings')).OutstandingsScreen
}))
export const ConsolidatedScreen = lazy(async () => ({
  default: (await import('./Consolidated')).ConsolidatedScreen
}))
export const RecurringScreen = lazy(async () => ({ default: (await import('./Recurring')).RecurringScreen }))
export const BankingScreen = lazy(async () => ({ default: (await import('./Banking')).BankingScreen }))
export const PayrollScreen = lazy(async () => ({ default: (await import('./Payroll')).PayrollScreen }))
export const KhataScreen = lazy(async () => ({ default: (await import('./Khata')).KhataScreen }))
export const CollectionsScreen = lazy(async () => ({
  default: (await import('./Collections')).CollectionsScreen
}))
export const AssetsScreen = lazy(async () => ({ default: (await import('./Assets')).AssetsScreen }))
export const CounterScreen = lazy(async () => ({ default: (await import('./Counter')).CounterScreen }))
export const SalesChainScreen = lazy(async () => ({ default: (await import('./SalesChain')).SalesChainScreen }))
export const BorrowingScreen = lazy(async () => ({ default: (await import('./Borrowing')).BorrowingScreen }))
export const DisclosureScreen = lazy(async () => ({ default: (await import('./Disclosure')).DisclosureScreen }))
export const FilingsScreen = lazy(async () => ({ default: (await import('./Filings')).FilingsScreen }))
export const CompositionScreen = lazy(async () => ({
  default: (await import('./Composition')).CompositionScreen
}))
export const TdsScreen = lazy(async () => ({ default: (await import('./Tds')).TdsScreen }))
export const CostCentresScreen = lazy(async () => ({ default: (await import('./CostCentres')).CostCentresScreen }))
export const BudgetsScreen = lazy(async () => ({ default: (await import('./Budgets')).BudgetsScreen }))
export const YearEndScreen = lazy(async () => ({ default: (await import('./YearEnd')).YearEndScreen }))
export const CompanyInfoScreen = lazy(async () => ({
  default: (await import('./CompanyInfo')).CompanyInfoScreen
}))
export const Settings = lazy(async () => ({ default: (await import('./Settings')).Settings }))
export const ImportTallyScreen = lazy(async () => ({
  default: (await import('./ImportTally')).ImportTallyScreen
}))
export const JobWorkScreen = lazy(async () => ({ default: (await import('./JobWork')).JobWorkScreen }))
