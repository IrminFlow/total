import { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNav, useScreen, useSession } from "./state/stores";
import { Button, Modal, Toasts } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DialogHost } from "./components/dialogs";
import { isAnyModalOpen } from "./components/modalRegistry";
import { invalidationFamilies } from "./lib/screens";
import { rememberRecentRecord } from "./lib/recentRecords";
import { coreApi } from "./lib/coreClient";
import {
  markReleaseNotesSeen,
  releaseNotesDue,
} from "./lib/productEducation";
import { readProductFlags } from "./lib/productFlags";

const CompanySelect = lazy(async () => ({
  default: (await import("./screens/CompanySelect")).CompanySelect,
}));
const Shell = lazy(async () => ({
  default: (await import("./components/Shell")).Shell,
}));
const LockScreen = lazy(async () => ({
  default: (await import("./components/LockScreen")).LockScreen,
}));

/** Global overlays must never bypass a blocking integrity decision or mounted modal. */
export function commandPaletteShortcutAllowed(integrityWarning: unknown): boolean {
  return !integrityWarning && !isAnyModalOpen();
}

const Gateway = lazy(async () => ({
  default: (await import("./screens/Gateway")).Gateway,
}));
const ActionCentreScreen = lazy(async () => ({
  default: (await import("./screens/ActionCentre")).ActionCentreScreen,
}));
const ControlRoomScreen = lazy(async () => ({
  default: (await import("./screens/ControlRoom")).ControlRoomScreen,
}));
const AssistScreen = lazy(async () => ({
  default: (await import("./screens/Assist")).AssistScreen,
}));
const TaskInboxScreen = lazy(async () => ({
  default: (await import("./screens/TaskInbox")).TaskInboxScreen,
}));
const DayBook = lazy(async () => ({
  default: (await import("./screens/DayBook")).DayBook,
}));
const ImportTallyScreen = lazy(async () => ({
  default: (await import("./screens/ImportTally")).ImportTallyScreen,
}));
const VoucherEntry = lazy(async () => ({
  default: (await import("./screens/VoucherEntry")).VoucherEntry,
}));
const VoucherDraftsScreen = lazy(async () => ({
  default: (await import("./screens/VoucherDrafts")).VoucherDraftsScreen,
}));
const EntryTemplatesScreen = lazy(async () => ({
  default: (await import("./screens/EntryTemplates")).EntryTemplatesScreen,
}));
const SalesDocumentsScreen = lazy(async () => ({
  default: (await import("./screens/SalesDocuments")).SalesDocumentsScreen,
}));
const CommunicationsScreen = lazy(async () => ({
  default: (await import("./screens/Communications")).CommunicationsScreen,
}));
const Masters = lazy(async () => ({
  default: (await import("./screens/Masters")).Masters,
}));
const TrialBalanceScreen = lazy(async () => ({
  default: (await import("./screens/TrialBalance")).TrialBalanceScreen,
}));
const ProfitLossScreen = lazy(async () => ({
  default: (await import("./screens/ProfitLoss")).ProfitLossScreen,
}));
const BalanceSheetScreen = lazy(async () => ({
  default: (await import("./screens/BalanceSheet")).BalanceSheetScreen,
}));
const CashFlowScreen = lazy(async () => ({
  default: (await import("./screens/CashFlow")).CashFlowScreen,
}));
const ExceptionsScreen = lazy(async () => ({
  default: (await import("./screens/Exceptions")).ExceptionsScreen,
}));
const StockSummaryScreen = lazy(async () => ({
  default: (await import("./screens/StockSummary")).StockSummaryScreen,
}));
const InventoryControlScreen = lazy(async () => ({
  default: (await import("./screens/InventoryControl")).InventoryControlScreen,
}));
const LedgerStatementScreen = lazy(async () => ({
  default: (await import("./screens/LedgerStatement")).LedgerStatementScreen,
}));
const Gstr1Screen = lazy(async () => ({
  default: (await import("./screens/GstReturns")).Gstr1Screen,
}));
const Gstr3bScreen = lazy(async () => ({
  default: (await import("./screens/GstReturns")).Gstr3bScreen,
}));
const Gstr2bScreen = lazy(async () => ({
  default: (await import("./screens/Gstr2b")).Gstr2bScreen,
}));
const CompanyInfoScreen = lazy(async () => ({
  default: (await import("./screens/CompanyInfo")).CompanyInfoScreen,
}));
const RegistersScreen = lazy(async () => ({
  default: (await import("./screens/Registers")).RegistersScreen,
}));
const OutstandingsScreen = lazy(async () => ({
  default: (await import("./screens/Outstandings")).OutstandingsScreen,
}));
const CollectionsScreen = lazy(async () => ({
  default: (await import("./screens/Collections")).CollectionsScreen,
}));
const SupplierDuesScreen = lazy(async () => ({
  default: (await import("./screens/SupplierDues")).SupplierDuesScreen,
}));
const ProcurementScreen = lazy(async () => ({
  default: (await import("./screens/Procurement")).ProcurementScreen,
}));
const ConsolidatedScreen = lazy(async () => ({
  default: (await import("./screens/Consolidated")).ConsolidatedScreen,
}));
const RecurringScreen = lazy(async () => ({
  default: (await import("./screens/Recurring")).RecurringScreen,
}));
const BankingScreen = lazy(async () => ({
  default: (await import("./screens/Banking")).BankingScreen,
}));
const EdocsScreen = lazy(async () => ({
  default: (await import("./screens/Edocs")).EdocsScreen,
}));
const PayrollScreen = lazy(async () => ({
  default: (await import("./screens/Payroll")).PayrollScreen,
}));
const TdsScreen = lazy(async () => ({
  default: (await import("./screens/Tds")).TdsScreen,
}));
const ComplianceCentreScreen = lazy(async () => ({
  default: (await import("./screens/ComplianceCentre")).ComplianceCentreScreen,
}));
const CostCentresScreen = lazy(async () => ({
  default: (await import("./screens/CostCentres")).CostCentresScreen,
}));
const BudgetsScreen = lazy(async () => ({
  default: (await import("./screens/Budgets")).BudgetsScreen,
}));
const ManagementInsightsScreen = lazy(async () => ({
  default: (await import("./screens/ManagementInsights"))
    .ManagementInsightsScreen,
}));
const YearEndScreen = lazy(async () => ({
  default: (await import("./screens/YearEnd")).YearEndScreen,
}));
const MonthCloseScreen = lazy(async () => ({
  default: (await import("./screens/MonthClose")).MonthCloseScreen,
}));
const Settings = lazy(async () => ({
  default: (await import("./screens/Settings")).Settings,
}));
const CommandPalette = lazy(async () => ({
  default: (await import("./components/CommandPalette")).CommandPalette,
}));
const ShortcutHelp = lazy(async () => ({
  default: (await import("./components/ShortcutHelp")).ShortcutHelp,
}));
const CopilotPanel = lazy(async () => ({
  default: (await import("./components/CopilotPanel")).CopilotPanel,
}));
const HelpCentre = lazy(async () => ({
  default: (await import("./components/HelpCentre")).HelpCentre,
}));

function ScreenLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-5xl" role="status" aria-live="polite">
      <div className="overflow-hidden rounded-lg border border-line bg-panel p-5">
        <div className="h-2 w-20 animate-pulse rounded bg-amber/30" />
        <div className="mt-4 h-7 w-64 animate-pulse rounded bg-panel2" />
        <div className="mt-6 grid gap-2">
          <div className="h-10 animate-pulse rounded bg-panel2/70" />
          <div className="h-10 animate-pulse rounded bg-panel2/50" />
          <div className="h-10 animate-pulse rounded bg-panel2/30" />
        </div>
        <span className="sr-only">Loading workspace</span>
      </div>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const { slug, locked, integrityWarning, setIntegrityWarning } = useSession();
  const screen = useScreen();
  const nav = useNav();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpCentre, setHelpCentre] = useState<
    "context" | "search" | "troubleshoot" | "release" | null
  >(null);
  const [appVersion, setAppVersion] = useState("");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const openHelp = (event: Event): void => {
      const detail = (event as CustomEvent<{ tab?: typeof helpCentre }>).detail;
      if (readProductFlags(localStorage).flags.guidedHelp) {
        setHelpCentre(detail?.tab ?? "context");
      } else {
        setHelpOpen(true);
      }
    };
    window.addEventListener("total:open-help", openHelp);
    return () => window.removeEventListener("total:open-help", openHelp);
  }, []);

  useEffect(() => {
    if (!slug || locked) return;
    void coreApi.app.info().then((info) => {
      setAppVersion(info.version);
      if (releaseNotesDue(localStorage, info.version)) setHelpCentre("release");
    });
  }, [slug, locked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Modal work has priority over global navigation. In particular, never stack the command
        // palette over a confirmation or a dirty form and let it navigate around that decision.
        if (!commandPaletteShortcutAllowed(integrityWarning)) return;
        setPaletteOpen((v) => !v);
        return;
      }
      if (paletteOpen) return;
      if (e.key === "Escape") {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
          (e.target as HTMLElement).blur();
          return;
        }
        nav.back();
        return;
      }
      if (e.key === "?") {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, nav, integrityWarning]);

  // Fresh data whenever the visible screen changes — scoped to that screen's query-key
  // families (see the registry) instead of nuking the whole cache on every navigation.
  useEffect(() => {
    for (const family of invalidationFamilies(screen.name)) {
      void queryClient.invalidateQueries({ queryKey: [family] });
    }
  }, [screen.name, queryClient]);

  useEffect(() => {
    if (!slug) return;
    if (screen.name === "voucher-entry" && screen.voucherId) {
      rememberRecentRecord(slug, {
        kind: "voucher",
        id: screen.voucherId,
        label: `Voucher #${screen.voucherId}`,
        sub: "Recently viewed voucher",
      });
    } else if (screen.name === "ledger-statement") {
      rememberRecentRecord(slug, {
        kind: "ledger",
        id: screen.ledgerId,
        label: `Ledger #${screen.ledgerId}`,
        sub: "Recently viewed ledger",
      });
    }
  }, [slug, screen]);

  // Rendered once, below, regardless of which of the three layouts is active — so it survives
  // any navigation or lock-state flip that would otherwise unmount whatever triggered it (see
  // the session store's `integrityWarning` doc comment).
  const integrityModal = integrityWarning && (
    <IntegrityWarningModal
      warning={integrityWarning}
      onClose={() => setIntegrityWarning(null)}
    />
  );

  if (!slug)
    return (
      <>
        <Suspense fallback={<ScreenLoading />}>
          <CompanySelect />
        </Suspense>
        {integrityModal}
        <DialogHost />
        <Toasts />
      </>
    );

  if (locked)
    return (
      <>
        <Suspense fallback={<ScreenLoading />}>
          <LockScreen />
        </Suspense>
        {integrityModal}
        <DialogHost />
        <Toasts />
      </>
    );

  return (
    <>
      <Suspense fallback={<ScreenLoading />}>
        <Shell
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenCopilot={() => setCopilotOpen(true)}
          onOpenHelp={() => {
            if (readProductFlags(localStorage).flags.guidedHelp) setHelpCentre("context");
            else setHelpOpen(true);
          }}
        >
          <ErrorBoundary key={screen.name} screen={screen.name}>
            <Suspense fallback={<ScreenLoading />}>
            {screen.name === "gateway" && <Gateway />}
            {screen.name === "action-centre" && <ActionCentreScreen />}
            {screen.name === "control-room" && <ControlRoomScreen />}
            {screen.name === "assist" && <AssistScreen />}
            {screen.name === "task-inbox" && (
              <TaskInboxScreen
                compose={screen.compose}
                linkType={screen.linkType}
                linkKey={screen.linkKey}
              />
            )}
            {screen.name === "daybook" && (
              <DayBook
                from={screen.from}
                to={screen.to}
                periodLabel={screen.periodLabel}
                kind={screen.kind}
                voucherIds={screen.voucherIds}
              />
            )}
            {screen.name === "import-tally" && <ImportTallyScreen />}
            {screen.name === "voucher-entry" && (
              <VoucherEntry
                key={
                  screen.voucherId ??
                  (screen.workDraftId
                    ? `work-draft-${screen.workDraftId}`
                    : screen.draftId
                      ? `draft-${screen.draftId}`
                      : "new")
                }
                voucherId={screen.voucherId}
                kindHint={screen.kindHint}
                draft={screen.draft}
                workDraftId={screen.workDraftId}
              />
            )}
            {screen.name === "voucher-drafts" && <VoucherDraftsScreen />}
            {screen.name === "entry-templates" && <EntryTemplatesScreen />}
            {screen.name === "sales-documents" && <SalesDocumentsScreen />}
            {screen.name === "communications" && <CommunicationsScreen />}
            {screen.name === "masters" && (
              <Masters key={screen.tab ?? "ledgers"} tab={screen.tab} />
            )}
            {screen.name === "trial-balance" && <TrialBalanceScreen />}
            {screen.name === "profit-loss" && <ProfitLossScreen />}
            {screen.name === "balance-sheet" && <BalanceSheetScreen />}
            {screen.name === "cash-flow" && <CashFlowScreen />}
            {screen.name === "exceptions" && <ExceptionsScreen />}
            {screen.name === "stock-summary" && <StockSummaryScreen />}
            {screen.name === "inventory-control" && <InventoryControlScreen />}
            {screen.name === "ledger-statement" && (
              <LedgerStatementScreen ledgerId={screen.ledgerId} />
            )}
            {screen.name === "gstr1" && <Gstr1Screen />}
            {screen.name === "gstr3b" && <Gstr3bScreen />}
            {screen.name === "gstr2b" && <Gstr2bScreen />}
            {screen.name === "edocs" && <EdocsScreen />}
            {screen.name === "registers" && <RegistersScreen />}
            {screen.name === "outstandings" && <OutstandingsScreen />}
            {screen.name === "collections" && <CollectionsScreen />}
            {screen.name === "supplier-dues" && <SupplierDuesScreen />}
            {screen.name === "procurement" && (
              <ProcurementScreen
                key={screen.tab ?? "requisitions"}
                initialTab={screen.tab}
              />
            )}
            {screen.name === "consolidated" && <ConsolidatedScreen />}
            {screen.name === "recurring" && <RecurringScreen />}
            {screen.name === "banking" && <BankingScreen />}
            {screen.name === "payroll" && <PayrollScreen />}
            {screen.name === "tds" && <TdsScreen />}
            {screen.name === "compliance-centre" && <ComplianceCentreScreen />}
            {screen.name === "management-insights" && (
              <ManagementInsightsScreen />
            )}
            {screen.name === "cost-centres" && <CostCentresScreen />}
            {screen.name === "budgets" && <BudgetsScreen />}
            {screen.name === "year-end" && <YearEndScreen />}
            {screen.name === "month-close" && <MonthCloseScreen />}
            {screen.name === "company-info" && <CompanyInfoScreen />}
            {screen.name === "settings" && (
              <Settings key={screen.tab ?? "backups"} tab={screen.tab} />
            )}
            </Suspense>
          </ErrorBoundary>
        </Shell>
      </Suspense>
      <Suspense fallback={null}>
        {paletteOpen && (
          <CommandPalette onClose={() => setPaletteOpen(false)} />
        )}
        {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
        {copilotOpen && <CopilotPanel onClose={() => setCopilotOpen(false)} />}
        {helpCentre && (
          <HelpCentre
            key={helpCentre}
            initialTab={helpCentre}
            onClose={() => {
              if (appVersion) markReleaseNotesSeen(localStorage, appVersion);
              setHelpCentre(null);
            }}
          />
        )}
      </Suspense>
      {integrityModal}
      <DialogHost />
      <Toasts />
    </>
  );
}

function IntegrityWarningModal({
  warning,
  onClose,
}: {
  warning: {
    quickCheck: string;
    unbalancedVoucherIds: number[];
    context: string;
  };
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal title="Integrity warning" onClose={onClose}>
      <p className="text-[13px] text-cr">
        Integrity check found an issue: {warning.quickCheck}
        {warning.unbalancedVoucherIds.length
          ? ` — ${warning.unbalancedVoucherIds.length} unbalanced voucher(s)`
          : ""}
      </p>
      <p className="mt-2 text-[12.5px] text-muted">
        The books were {warning.context}. Review the Day Book and Trial Balance
        carefully before continuing.
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}
