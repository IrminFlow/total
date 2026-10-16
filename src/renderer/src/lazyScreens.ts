// Every screen App.tsx renders, except the ones the first paint needs (CompanySelect + the setup
// wizard, Gateway, SimpleHome, Shell, the lock screens — imported eagerly by App.tsx), is its own
// chunk, loaded on first visit (lib/lazyScreen.tsx) and warmed after Home is idle (Prefetch.tsx).
// Each export keeps the name of the component it stands for, so App.tsx reads as before.
import type { Screen } from './state/stores'
import { lazyScreen, type LazyComponent } from './lib/lazyScreen'

const load_simple_SimpleSection = () => import('./simple/SimpleSection')
export const SimpleSection = lazyScreen(load_simple_SimpleSection, 'SimpleSection')
const load_simple_SimpleLooks = () => import('./simple/SimpleLooks')
export const SimpleLooks = lazyScreen(load_simple_SimpleLooks, 'SimpleLooks')
const load_simple_SimpleBackups = () => import('./simple/SimpleBackups')
export const SimpleBackups = lazyScreen(load_simple_SimpleBackups, 'SimpleBackups')
const load_simple_SimpleFeatures = () => import('./simple/SimpleFeatures')
export const SimpleFeatures = lazyScreen(load_simple_SimpleFeatures, 'SimpleFeatures')
const load_simple_ai_AiHelper = () => import('./simple/ai/AiHelper')
export const AiHelper = lazyScreen(load_simple_ai_AiHelper, 'AiHelper')
const load_simple_Openings = () => import('./simple/Openings')
export const Openings = lazyScreen(load_simple_Openings, 'Openings')
const load_simple_money_MoneyIn = () => import('./simple/money/MoneyIn')
export const MoneyIn = lazyScreen(load_simple_money_MoneyIn, 'MoneyIn')
const load_simple_money_MoneyOut = () => import('./simple/money/MoneyOut')
export const MoneyOut = lazyScreen(load_simple_money_MoneyOut, 'MoneyOut')
const load_simple_money_MoveMoney = () => import('./simple/money/MoveMoney')
export const MoveMoney = lazyScreen(load_simple_money_MoveMoney, 'MoveMoney')
const load_simple_money_MoneyList = () => import('./simple/money/MoneyList')
export const MoneyList = lazyScreen(load_simple_money_MoneyList, 'MoneyList')
const load_simple_sell_MakeBill = () => import('./simple/sell/MakeBill')
export const MakeBill = lazyScreen(load_simple_sell_MakeBill, 'MakeBill')
const load_simple_sell_SalesList = () => import('./simple/sell/SalesList')
export const SalesList = lazyScreen(load_simple_sell_SalesList, 'SalesList')
const load_simple_sell_QuickBill = () => import('./simple/sell/QuickBill')
export const QuickBill = lazyScreen(load_simple_sell_QuickBill, 'QuickBill')
const load_simple_returns_ReturnSale = () => import('./simple/returns/ReturnSale')
export const ReturnSale = lazyScreen(load_simple_returns_ReturnSale, 'ReturnSale')
const load_simple_returns_ReturnPurchase = () => import('./simple/returns/ReturnPurchase')
export const ReturnPurchase = lazyScreen(load_simple_returns_ReturnPurchase, 'ReturnPurchase')
const load_simple_bank_BankScreen = () => import('./simple/bank/BankScreen')
export const BankScreen = lazyScreen(load_simple_bank_BankScreen, 'BankScreen')
const load_simple_buy_RecordPurchase = () => import('./simple/buy/RecordPurchase')
export const RecordPurchase = lazyScreen(load_simple_buy_RecordPurchase, 'RecordPurchase')
const load_simple_buy_PurchaseList = () => import('./simple/buy/PurchaseList')
export const PurchaseList = lazyScreen(load_simple_buy_PurchaseList, 'PurchaseList')
const load_simple_people_PeopleList = () => import('./simple/people/PeopleList')
export const PeopleList = lazyScreen(load_simple_people_PeopleList, 'PeopleList')
const load_simple_people_PersonView = () => import('./simple/people/PersonView')
export const PersonView = lazyScreen(load_simple_people_PersonView, 'PersonView')
const load_simple_stock_StockList = () => import('./simple/stock/StockList')
export const StockList = lazyScreen(load_simple_stock_StockList, 'StockList')
const load_simple_stock_StockCount = () => import('./simple/stock/StockCount')
export const StockCount = lazyScreen(load_simple_stock_StockCount, 'StockCount')
const load_simple_stock_SavedCount = () => import('./simple/stock/SavedCount')
export const SavedCount = lazyScreen(load_simple_stock_SavedCount, 'SavedCount')
const load_simple_stock_MadeGoods = () => import('./simple/stock/MadeGoods')
export const MadeGoods = lazyScreen(load_simple_stock_MadeGoods, 'MadeGoods')
const load_simple_reports_ReportsScreen = () => import('./simple/reports/ReportsScreen')
export const ReportsScreen = lazyScreen(load_simple_reports_ReportsScreen, 'ReportsScreen')
const load_simple_taxes_TaxesScreen = () => import('./simple/taxes/TaxesScreen')
export const TaxesScreen = lazyScreen(load_simple_taxes_TaxesScreen, 'TaxesScreen')
const load_screens_DayBook = () => import('./screens/DayBook')
export const DayBook = lazyScreen(load_screens_DayBook, 'DayBook')
const load_screens_ImportTally = () => import('./screens/ImportTally')
export const ImportTallyScreen = lazyScreen(load_screens_ImportTally, 'ImportTallyScreen')
const load_screens_ImportWizard = () => import('./screens/ImportWizard')
export const ImportWizardScreen = lazyScreen(load_screens_ImportWizard, 'ImportWizardScreen')
const load_screens_BooksExport = () => import('./screens/BooksExport')
export const BooksExportScreen = lazyScreen(load_screens_BooksExport, 'BooksExportScreen')
const load_screens_VoucherEntry = () => import('./screens/VoucherEntry')
export const VoucherEntry = lazyScreen(load_screens_VoucherEntry, 'VoucherEntry')
const load_screens_Masters = () => import('./screens/Masters')
export const Masters = lazyScreen(load_screens_Masters, 'Masters')
const load_screens_TrialBalance = () => import('./screens/TrialBalance')
export const TrialBalanceScreen = lazyScreen(load_screens_TrialBalance, 'TrialBalanceScreen')
const load_screens_ProfitLoss = () => import('./screens/ProfitLoss')
export const ProfitLossScreen = lazyScreen(load_screens_ProfitLoss, 'ProfitLossScreen')
const load_screens_BalanceSheet = () => import('./screens/BalanceSheet')
export const BalanceSheetScreen = lazyScreen(load_screens_BalanceSheet, 'BalanceSheetScreen')
const load_screens_CashFlow = () => import('./screens/CashFlow')
export const CashFlowScreen = lazyScreen(load_screens_CashFlow, 'CashFlowScreen')
const load_screens_Exceptions = () => import('./screens/Exceptions')
export const ExceptionsScreen = lazyScreen(load_screens_Exceptions, 'ExceptionsScreen')
const load_screens_StockSummary = () => import('./screens/StockSummary')
export const StockSummaryScreen = lazyScreen(load_screens_StockSummary, 'StockSummaryScreen')
const load_screens_Manufacture = () => import('./screens/Manufacture')
export const ManufactureScreen = lazyScreen(load_screens_Manufacture, 'ManufactureScreen')
const load_screens_CounterBilling = () => import('./screens/CounterBilling')
export const CounterBillingScreen = lazyScreen(load_screens_CounterBilling, 'CounterBillingScreen')
const load_screens_ManufactureRegister = () => import('./screens/ManufactureRegister')
export const ManufactureRegisterScreen = lazyScreen(load_screens_ManufactureRegister, 'ManufactureRegisterScreen')
const load_screens_ManufactureReports = () => import('./screens/ManufactureReports')
export const ManufactureReportsScreen = lazyScreen(load_screens_ManufactureReports, 'ManufactureReportsScreen')
const load_screens_FixedAssets = () => import('./screens/FixedAssets')
export const FixedAssetsScreen = lazyScreen(load_screens_FixedAssets, 'FixedAssetsScreen')
const load_screens_CashForecast = () => import('./screens/CashForecast')
export const CashForecastScreen = lazyScreen(load_screens_CashForecast, 'CashForecastScreen')
const load_screens_Loans = () => import('./screens/Loans')
export const LoansScreen = lazyScreen(load_screens_Loans, 'LoansScreen')
const load_screens_Forex = () => import('./screens/Forex')
export const ForexScreen = lazyScreen(load_screens_Forex, 'ForexScreen')
const load_screens_StockMovements = () => import('./screens/StockMovements')
export const StockMovementsScreen = lazyScreen(load_screens_StockMovements, 'StockMovementsScreen')
const load_screens_StockJournal = () => import('./screens/StockJournal')
export const StockJournalScreen = lazyScreen(load_screens_StockJournal, 'StockJournalScreen')
const load_screens_StockReports = () => import('./screens/StockReports')
export const StockReportsScreen = lazyScreen(load_screens_StockReports, 'StockReportsScreen')
const load_screens_LedgerStatement = () => import('./screens/LedgerStatement')
export const LedgerStatementScreen = lazyScreen(load_screens_LedgerStatement, 'LedgerStatementScreen')
const load_screens_GstReturns = () => import('./screens/GstReturns')
export const Gstr1Screen = lazyScreen(load_screens_GstReturns, 'Gstr1Screen')
export const Gstr3bScreen = lazyScreen(load_screens_GstReturns, 'Gstr3bScreen')
const load_screens_Gstr2b = () => import('./screens/Gstr2b')
export const Gstr2bScreen = lazyScreen(load_screens_Gstr2b, 'Gstr2bScreen')
const load_screens_gst_Gstr9Screen = () => import('./screens/gst/Gstr9Screen')
export const Gstr9Screen = lazyScreen(load_screens_gst_Gstr9Screen, 'Gstr9Screen')
const load_screens_gst_Itc04Screen = () => import('./screens/gst/Itc04Screen')
export const Itc04Screen = lazyScreen(load_screens_gst_Itc04Screen, 'Itc04Screen')
const load_screens_gst_ItcReversalScreen = () => import('./screens/gst/ItcReversalScreen')
export const ItcReversalScreen = lazyScreen(load_screens_gst_ItcReversalScreen, 'ItcReversalScreen')
const load_screens_CompanyInfo = () => import('./screens/CompanyInfo')
export const CompanyInfoScreen = lazyScreen(load_screens_CompanyInfo, 'CompanyInfoScreen')
const load_screens_Registers = () => import('./screens/Registers')
export const RegistersScreen = lazyScreen(load_screens_Registers, 'RegistersScreen')
const load_screens_Outstandings = () => import('./screens/Outstandings')
export const OutstandingsScreen = lazyScreen(load_screens_Outstandings, 'OutstandingsScreen')
const load_screens_Receivables = () => import('./screens/Receivables')
export const ReceivablesScreen = lazyScreen(load_screens_Receivables, 'ReceivablesScreen')
const load_screens_Payables = () => import('./screens/Payables')
export const PayablesScreen = lazyScreen(load_screens_Payables, 'PayablesScreen')
const load_screens_TradePending = () => import('./screens/TradePending')
export const TradePendingScreen = lazyScreen(load_screens_TradePending, 'TradePendingScreen')
const load_screens_TradeDocList = () => import('./screens/TradeDocList')
export const TradeDocListScreen = lazyScreen(load_screens_TradeDocList, 'TradeDocListScreen')
const load_screens_TradeDocEntry = () => import('./screens/TradeDocEntry')
export const TradeDocEntry = lazyScreen(load_screens_TradeDocEntry, 'TradeDocEntry')
const load_screens_TradeOrderReports = () => import('./screens/TradeOrderReports')
export const PendingOrdersScreen = lazyScreen(load_screens_TradeOrderReports, 'PendingOrdersScreen')
export const QuotationPipelineScreen = lazyScreen(load_screens_TradeOrderReports, 'QuotationPipelineScreen')
const load_screens_ThreeWayMatch = () => import('./screens/ThreeWayMatch')
export const ThreeWayMatchScreen = lazyScreen(load_screens_ThreeWayMatch, 'ThreeWayMatchScreen')
const load_screens_TradeAnalysis = () => import('./screens/TradeAnalysis')
export const ItemDemandScreen = lazyScreen(load_screens_TradeAnalysis, 'ItemDemandScreen')
export const OrderBookScreen = lazyScreen(load_screens_TradeAnalysis, 'OrderBookScreen')
const load_screens_TradeReturns = () => import('./screens/TradeReturns')
export const TradeReturnsScreen = lazyScreen(load_screens_TradeReturns, 'TradeReturnsScreen')
const load_screens_TradeUnbilled = () => import('./screens/TradeUnbilled')
export const StaleDocumentsScreen = lazyScreen(load_screens_TradeUnbilled, 'StaleDocumentsScreen')
export const UnbilledGoodsScreen = lazyScreen(load_screens_TradeUnbilled, 'UnbilledGoodsScreen')
const load_screens_Consolidated = () => import('./screens/Consolidated')
export const ConsolidatedScreen = lazyScreen(load_screens_Consolidated, 'ConsolidatedScreen')
const load_screens_consolidation_Consolidation = () => import('./screens/consolidation/Consolidation')
export const ConsolidationScreen = lazyScreen(load_screens_consolidation_Consolidation, 'ConsolidationScreen')
const load_screens_Capture = () => import('./screens/Capture')
export const CaptureScreen = lazyScreen(load_screens_Capture, 'CaptureScreen')
const load_screens_Banking = () => import('./screens/Banking')
export const BankingScreen = lazyScreen(load_screens_Banking, 'BankingScreen')
const load_screens_Edocs = () => import('./screens/Edocs')
export const EdocsScreen = lazyScreen(load_screens_Edocs, 'EdocsScreen')
const load_screens_Payroll = () => import('./screens/Payroll')
export const PayrollScreen = lazyScreen(load_screens_Payroll, 'PayrollScreen')
const load_screens_Tds = () => import('./screens/Tds')
export const TdsScreen = lazyScreen(load_screens_Tds, 'TdsScreen')
const load_screens_Tcs = () => import('./screens/Tcs')
export const TcsScreen = lazyScreen(load_screens_Tcs, 'TcsScreen')
const load_screens_CostCentres = () => import('./screens/CostCentres')
export const CostCentresScreen = lazyScreen(load_screens_CostCentres, 'CostCentresScreen')
const load_screens_Budgets = () => import('./screens/Budgets')
export const BudgetsScreen = lazyScreen(load_screens_Budgets, 'BudgetsScreen')
const load_screens_reportBuilder_ReportBuilder = () => import('./screens/reportBuilder/ReportBuilder')
export const ReportBuilderScreen = lazyScreen(load_screens_reportBuilder_ReportBuilder, 'ReportBuilderScreen')
const load_screens_assistants_Assistants = () => import('./screens/assistants/Assistants')
export const AssistantsScreen = lazyScreen(load_screens_assistants_Assistants, 'AssistantsScreen')
const load_screens_Ratios = () => import('./screens/Ratios')
export const RatiosScreen = lazyScreen(load_screens_Ratios, 'RatiosScreen')
const load_screens_YearEnd = () => import('./screens/YearEnd')
export const YearEndScreen = lazyScreen(load_screens_YearEnd, 'YearEndScreen')
const load_screens_Settings = () => import('./screens/Settings')
export const Settings = lazyScreen(load_screens_Settings, 'Settings')
const load_screens_EditLog = () => import('./screens/EditLog')
export const EditLogScreen = lazyScreen(load_screens_EditLog, 'EditLogScreen')
const load_screens_SearchResults = () => import('./screens/SearchResults')
export const SearchResultsScreen = lazyScreen(load_screens_SearchResults, 'SearchResultsScreen')
const load_simple_HelpSettings = () => import('./simple/HelpSettings')
export const HelpSettings = lazyScreen(load_simple_HelpSettings, 'HelpSettings')
const load_simple_SecuritySettings = () => import('./simple/SecuritySettings')
export const SecuritySettings = lazyScreen(load_simple_SecuritySettings, 'SecuritySettings')
const load_simple_PeopleRoles = () => import('./simple/PeopleRoles')
export const PeopleRoles = lazyScreen(load_simple_PeopleRoles, 'PeopleRoles')

/** The chunks each registry screen renders (App.tsx's switch) — what prefetching warms. */
export const SCREEN_CHUNKS: { readonly [N in Screen['name']]?: readonly LazyComponent<never>[] } = {
  'simple-section': [SimpleSection],
  'simple-looks': [SimpleLooks],
  'simple-backups': [SimpleBackups],
  'simple-features': [SimpleFeatures],
  'simple-security': [SecuritySettings],
  'simple-people-roles': [PeopleRoles],
  'simple-ai': [AiHelper],
  'simple-help': [HelpSettings],
  'simple-openings': [Openings],
  'simple-money-in': [MoneyIn],
  'simple-money-out': [MoneyOut],
  'simple-move-money': [MoveMoney],
  'simple-money': [MoneyList],
  'simple-sell': [MakeBill],
  'simple-sales': [SalesList],
  'simple-quick-bill': [QuickBill],
  'simple-return-sale': [ReturnSale],
  'simple-return-purchase': [ReturnPurchase],
  'simple-bank': [BankScreen],
  'simple-buy': [RecordPurchase],
  'simple-purchases': [PurchaseList],
  'simple-people': [PeopleList],
  'simple-person': [PersonView],
  'simple-stock': [StockList],
  'simple-stock-count': [SavedCount, StockCount],
  'simple-made-goods': [MadeGoods],
  'simple-reports': [ReportsScreen],
  'simple-taxes': [TaxesScreen],
  'daybook': [DayBook],
  'import-tally': [ImportTallyScreen],
  'data-import': [ImportWizardScreen],
  'data-export': [BooksExportScreen],
  'voucher-entry': [VoucherEntry],
  'masters': [Masters],
  'search': [SearchResultsScreen],
  'trial-balance': [TrialBalanceScreen],
  'profit-loss': [ProfitLossScreen],
  'balance-sheet': [BalanceSheetScreen],
  'cash-flow': [CashFlowScreen],
  'exceptions': [ExceptionsScreen],
  'stock-summary': [StockSummaryScreen],
  'manufacture': [ManufactureScreen],
  'counter-billing': [CounterBillingScreen],
  'manufacture-register': [ManufactureRegisterScreen],
  'manufacture-reports': [ManufactureReportsScreen],
  'fixed-assets': [FixedAssetsScreen],
  'stock-movements': [StockMovementsScreen],
  'stock-journal': [StockJournalScreen],
  'stock-reports': [StockReportsScreen],
  'ledger-statement': [LedgerStatementScreen],
  'gstr1': [Gstr1Screen],
  'gstr3b': [Gstr3bScreen],
  'gstr2b': [Gstr2bScreen],
  'edocs': [EdocsScreen],
  'gstr9': [Gstr9Screen],
  'itc04': [Itc04Screen],
  'itc-reversal': [ItcReversalScreen],
  'registers': [RegistersScreen],
  'outstandings': [OutstandingsScreen],
  'receivables': [ReceivablesScreen],
  'payables': [PayablesScreen],
  'pending-challans': [TradePendingScreen],
  'pending-grns': [TradePendingScreen],
  'quotations': [TradeDocListScreen],
  'sales-orders': [TradeDocListScreen],
  'purchase-orders': [TradeDocListScreen],
  'trade-doc': [TradeDocEntry],
  'pending-sales-orders': [PendingOrdersScreen],
  'pending-purchase-orders': [PendingOrdersScreen],
  'quotation-pipeline': [QuotationPipelineScreen],
  'three-way-match': [ThreeWayMatchScreen],
  'order-book': [OrderBookScreen],
  'item-demand': [ItemDemandScreen],
  'trade-returns': [TradeReturnsScreen],
  'unbilled-goods': [UnbilledGoodsScreen],
  'stale-documents': [StaleDocumentsScreen],
  'consolidated': [ConsolidatedScreen],
  'consolidation': [ConsolidationScreen],
  'banking': [BankingScreen],
  'capture': [CaptureScreen],
  'payroll': [PayrollScreen],
  'tds': [TdsScreen],
  'tcs': [TcsScreen],
  'cost-centres': [CostCentresScreen],
  'budgets': [BudgetsScreen],
  'report-builder': [ReportBuilderScreen],
  'assistants': [AssistantsScreen],
  'ratios': [RatiosScreen],
  'cash-forecast': [CashForecastScreen],
  'loans': [LoansScreen],
  'forex': [ForexScreen],
  'year-end': [YearEndScreen],
  'company-info': [CompanyInfoScreen],
  'audit-trail': [EditLogScreen],
  'settings': [Settings],
}

/** WP 8.1 `simpleView` (a file under simple/, lib/screens.ts) → its lazy component. SimpleHome is
 *  eager (it is the first screen of a simple company). lazyScreens.test.ts checks the registry. */
export const SIMPLE_VIEW_CHUNKS: Readonly<Record<string, LazyComponent<never>>> = {
  'SimpleSection': SimpleSection,
  'SimpleLooks': SimpleLooks,
  'SimpleBackups': SimpleBackups,
  'SimpleFeatures': SimpleFeatures,
  'ai/AiHelper': AiHelper,
  'Openings': Openings,
  'money/MoneyIn': MoneyIn,
  'money/MoneyOut': MoneyOut,
  'money/MoveMoney': MoveMoney,
  'money/MoneyList': MoneyList,
  'sell/MakeBill': MakeBill,
  'sell/SalesList': SalesList,
  'sell/QuickBill': QuickBill,
  'returns/ReturnSale': ReturnSale,
  'returns/ReturnPurchase': ReturnPurchase,
  'bank/BankScreen': BankScreen,
  'buy/RecordPurchase': RecordPurchase,
  'buy/PurchaseList': PurchaseList,
  'people/PeopleList': PeopleList,
  'people/PersonView': PersonView,
  'stock/StockList': StockList,
  'stock/StockCount': StockCount,
  'stock/SavedCount': SavedCount,
  'stock/MadeGoods': MadeGoods,
  'reports/ReportsScreen': ReportsScreen,
  'taxes/TaxesScreen': TaxesScreen,
  'HelpSettings': HelpSettings,
  'SecuritySettings': SecuritySettings,
  'PeopleRoles': PeopleRoles,
}
