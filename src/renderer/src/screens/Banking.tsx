import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChequeConfig } from "@shared/schemas";
import {
  api,
  type BankChargeSuggestion,
  type BankImportResult,
  type BankMatchSuggestion,
  type BankReconciliationWorkspace,
  type BankRuleRecord,
  type BankSuggestionRow,
  type BrsItem,
} from "../lib/client";
import { useNav, useSession, useToasts, nextDraftId } from "../state/stores";
import {
  AmountInput,
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  ScrollList,
  SectionTitle,
  Select,
  Spinner,
  TextInput,
} from "../components/ui";
import { LedgerPicker } from "../components/pickers";
import { toDisplayDate, todayISO } from "@shared/dates";
import { suggestPattern } from "@shared/bankRules";
import { confirmDialog } from "../lib/dialogs";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import { MnemonicText } from "../components/MnemonicText";

type BankTab =
  | "workspace"
  | "treasury"
  | "transfers"
  | "charges"
  | "feeds"
  | "cheques"
  | "cash"
  | "recon"
  | "brs"
  | "pdc";

const TAB_LABELS: Record<BankTab, { label: string; key: string }> = {
  workspace: { label: "Control room", key: "c" },
  treasury: { label: "Treasury", key: "y" },
  transfers: { label: "Transfers", key: "t" },
  charges: { label: "Charges", key: "h" },
  feeds: { label: "Feeds", key: "f" },
  cheques: { label: "Cheques", key: "q" },
  cash: { label: "Cash count", key: "a" },
  recon: { label: "Book entries", key: "e" },
  brs: { label: "BRS", key: "b" },
  pdc: { label: "Post-dated", key: "p" },
};

export function BankingScreen(): React.JSX.Element {
  const nav = useNav();
  const { from, to } = useSession();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: ledgers } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const [tab, setTab] = useState<BankTab>("workspace");
  const [ledgerId, setLedgerId] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<BankSuggestionRow[] | null>(
    null,
  );
  const [matchSuggestions, setMatchSuggestions] = useState<
    BankMatchSuggestion[]
  >([]);
  const [matchExplanations, setMatchExplanations] = useState<
    Record<string, { summary: string; reasons: string[]; citations: string[] }>
  >({});
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesPrefill, setRulesPrefill] = useState<{
    pattern: string;
    kind: "payment" | "receipt";
  } | null>(null);
  const [rulesModalKey, setRulesModalKey] = useState(0);
  const [chequeSetupOpen, setChequeSetupOpen] = useState(false);
  const [dateEdit, setDateEdit] = useState<{
    lineId: number;
    current: string | null;
  } | null>(null);
  const [importPreview, setImportPreview] = useState<
    | (BankImportResult & {
        csvText: string;
        format: "csv" | "xlsx" | "ofx" | "qif" | "mt940";
        fileName: string | null;
      })
    | null
  >(null);

  useEffect(() => {
    if (ledgerId == null && ledgers?.length) setLedgerId(ledgers[0]!.id);
  }, [ledgers, ledgerId]);

  // A new bank ledger's statement lines have nothing to do with the last one's suggestions.
  useEffect(() => {
    setSuggestions(null);
    setMatchSuggestions([]);
    setMatchExplanations({});
  }, [ledgerId]);

  const { data: recon } = useQuery({
    queryKey: ["bankRecon", ledgerId, from, to],
    queryFn: () => api.bank.recon(ledgerId!, from, to),
    enabled: ledgerId != null,
  });

  const refresh = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bankRecon"] }),
      queryClient.invalidateQueries({ queryKey: ["brs"] }),
      queryClient.invalidateQueries({ queryKey: ["bankWorkspace"] }),
    ]).then(() => undefined);

  const markToday = async (
    lineId: number,
    current: string | null,
  ): Promise<void> => {
    try {
      await api.bank.setBankDate(lineId, current ? null : todayISO());
      await refresh();
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  /** Step 1 of the import: dry-run parse+match, then show the preview modal to confirm. */
  const doImport = async (): Promise<void> => {
    if (ledgerId == null) return;
    try {
      const result = await api.bank.importCsv(ledgerId, { dryRun: true });
      if (!result) return; // file dialog cancelled
      if (result.statementRows === 0)
        return void toast.push(
          "warning",
          "No statement rows found in that CSV",
        );
      setImportPreview(result);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  /** Step 2: the user confirmed the preview — apply the same CSV for real. */
  const applyImport = async (): Promise<void> => {
    if (ledgerId == null || !importPreview) return;
    let result;
    try {
      result = await api.bank.importCsv(ledgerId, {
        csvText: importPreview.csvText,
        dryRun: false,
        format: importPreview.format,
        fileName: importPreview.fileName,
      });
    } catch (err) {
      toast.push("error", (err as Error).message);
      return;
    }
    setImportPreview(null);
    if (!result) return;
    toast.push(
      result.matched > 0 ? "success" : "warning",
      `${result.matched} of ${result.statementRows} statement rows matched and reconciled${result.unmatched.length ? `; ${result.unmatched.length} unmatched` : ""}`,
    );
    await refresh();

    if (result.unmatched.length === 0) {
      setSuggestions(null);
      return;
    }
    try {
      const [rows, matches] = await Promise.all([
        api.bank.suggest(ledgerId, result.csvText),
        api.bank.matchSuggestions(ledgerId, result.csvText),
      ]);
      const matchedRows = new Set(
        matches.map((match) => match.statementRow.rowNo),
      );
      const voucherRows = rows.filter(
        (row) => !matchedRows.has(row.statementRow.rowNo),
      );
      setSuggestions(voucherRows);
      setMatchSuggestions(matches);
      const withSuggestion = voucherRows.filter((r) => r.suggestion).length;
      if (withSuggestion > 0)
        toast.push(
          "info",
          `${withSuggestion} of ${voucherRows.length} remaining lines have a suggested ledger below`,
        );
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const explainMatch = async (
    suggestion: BankMatchSuggestion,
  ): Promise<void> => {
    const key = `${suggestion.statementRow.rowNo}:${suggestion.kind}`;
    try {
      const result = await api.ai.reconciliationExplain(
        suggestion.kind,
        suggestion.statementRow.amount,
        suggestion.lines,
      );
      setMatchExplanations((current) => ({ ...current, [key]: result }));
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const acceptMatch = async (
    suggestion: BankMatchSuggestion,
  ): Promise<void> => {
    try {
      await Promise.all(
        suggestion.lines.map((line) =>
          api.bank.setBankDate(line.lineId, suggestion.statementRow.date),
        ),
      );
      setMatchSuggestions((current) =>
        current.filter((item) => item !== suggestion),
      );
      await refresh();
      toast.push(
        "success",
        `${suggestion.lines.length} book ${suggestion.lines.length === 1 ? "entry" : "entries"} reconciled after review`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const createFromSuggestion = async (
    row: BankSuggestionRow,
  ): Promise<void> => {
    if (row.suggestion) {
      try {
        await api.bankRules.hit(row.suggestion.ruleId);
      } catch {
        // Non-fatal — the draft is still worth opening even if the hit counter didn't update.
      }
      nav.go({
        name: "voucher-entry",
        kindHint: row.suggestion.kind,
        draft: row.suggestion.voucherDraft,
        draftId: nextDraftId(),
      });
      return;
    }
    if (ledgerId == null) return;
    const isDeposit = row.statementRow.kind === "deposit";
    nav.go({
      name: "voucher-entry",
      kindHint: isDeposit ? "receipt" : "payment",
      draft: {
        date: row.statementRow.date,
        narration: row.statementRow.description,
        lines: [
          {
            ledgerId,
            drCr: isDeposit ? "dr" : "cr",
            amount: row.statementRow.amount,
          },
        ],
      },
      draftId: nextDraftId(),
    });
  };

  const openRules = (
    prefill: { pattern: string; kind: "payment" | "receipt" } | null,
  ): void => {
    setRulesPrefill(prefill);
    setRulesModalKey((k) => k + 1);
    setRulesOpen(true);
  };

  const rememberRule = (row: BankSuggestionRow): void => {
    const kind: "payment" | "receipt" =
      row.statementRow.kind === "deposit" ? "receipt" : "payment";
    openRules({ pattern: suggestPattern(row.statementRow.description), kind });
  };

  const rejectSuggestion = async (row: BankSuggestionRow): Promise<void> => {
    if (!row.suggestion) return;
    try {
      await api.bankRules.reject(row.suggestion.ruleId);
      setSuggestions(
        (current) =>
          current?.map((candidate) =>
            candidate === row ? { ...candidate, suggestion: null } : candidate,
          ) ?? null,
      );
      await queryClient.invalidateQueries({ queryKey: ["bankRules"] });
      toast.push("success", "Suggestion corrected; confidence reduced");
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  if (ledgers && ledgers.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <SectionTitle>Banking</SectionTitle>
        <Panel>
          <EmptyState
            title="No bank ledgers yet"
            hint="Create a ledger under Bank Accounts in Masters, then reconcile it here"
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            {tab !== "pdc" &&
              tab !== "treasury" &&
              tab !== "transfers" &&
              tab !== "charges" &&
              tab !== "feeds" &&
              tab !== "cheques" &&
              tab !== "cash" && (
                <Select
                  value={ledgerId ?? ""}
                  onChange={(e) => setLedgerId(Number(e.target.value))}
                  className="w-52"
                  data-testid="banking-ledger"
                >
                  {(ledgers ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
            {(tab === "workspace" || tab === "recon") && (
              <>
                <Button
                  data-testid="btn-banking-rules"
                  onClick={() => openRules(null)}
                >
                  Rules…
                </Button>
                {ledgerId != null && (
                  <Button
                    data-testid="btn-banking-cheque-setup"
                    onClick={() => setChequeSetupOpen(true)}
                  >
                    Cheque setup…
                  </Button>
                )}
                <Button
                  variant="primary"
                  data-testid="btn-banking-import"
                  onClick={() => void doImport()}
                >
                  Import statement
                </Button>
              </>
            )}
          </div>
        }
      >
        Banking
      </SectionTitle>

      <div className="mb-3 flex items-center gap-1 overflow-x-auto whitespace-nowrap">
        {(
          [
            "workspace",
            "treasury",
            "transfers",
            "charges",
            "feeds",
            "cheques",
            "cash",
            "recon",
            "brs",
            "pdc",
          ] as const
        ).map((t) => (
          <button
            key={t}
            data-testid={`tab-banking-${t}`}
            onClick={() => setTab(t)}
            aria-label={TAB_LABELS[t].label}
            className={`relative px-3 py-2 text-[12px] font-medium ${tab === t ? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-amberbar" : "text-muted hover:text-ink"}`}
          >
            <MnemonicText
              label={TAB_LABELS[t].label}
              mnemonic={TAB_LABELS[t].key}
            />
          </button>
        ))}
      </div>

      {tab === "workspace" && ledgerId != null && (
        <ReconciliationWorkspaceSection
          ledgerId={ledgerId}
          onRefresh={refresh}
        />
      )}
      {tab === "treasury" && <TreasurySection />}
      {tab === "transfers" && (
        <TransferSuggestionsSection onRefresh={refresh} />
      )}
      {tab === "charges" && <ChargeExtractionSection onRefresh={refresh} />}
      {tab === "feeds" && <BankFeedsSection onRefresh={refresh} />}
      {tab === "cheques" && <ChequeLifecycleSection onRefresh={refresh} />}
      {tab === "cash" && <CashCountSection />}

      {tab === "recon" && recon && (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Balance as per books
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={recon.bookBalance} />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Deposits not in bank
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={recon.unreconciledDeposits} />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Withdrawals not in bank
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={recon.unreconciledWithdrawals} />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Balance as per bank
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={recon.bankBalance} />
              </p>
            </Panel>
          </div>

          <Panel scroll={{ maxH: "58vh" }}>
            {recon.rows.length === 0 ? (
              <EmptyState title="No bank entries in this period" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="w-24">Date</th>
                    <th>Particulars</th>
                    <th className="w-28">Instrument</th>
                    <th className="r w-32">Deposit</th>
                    <th className="r w-32">Withdrawal</th>
                    <th className="w-32">Bank date</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody data-testid="rows-banking">
                  {recon.rows.map((r) => (
                    <tr
                      key={r.lineId}
                      data-row-id={r.lineId}
                      className={r.bankDate ? "opacity-60" : ""}
                    >
                      <td className="num text-muted">
                        {toDisplayDate(r.date)}
                      </td>
                      <td className="max-w-56 truncate">{r.particulars}</td>
                      <td className="num text-muted">{r.instrumentNo ?? ""}</td>
                      <td className="r">
                        <Money paise={r.deposit} />
                      </td>
                      <td className="r">
                        <Money paise={r.withdrawal} />
                      </td>
                      <td>
                        <button
                          className="num text-[12px] text-blue hover:underline"
                          data-testid="btn-banking-edit-bank-date"
                          onClick={() =>
                            setDateEdit({
                              lineId: r.lineId,
                              current: r.bankDate,
                            })
                          }
                        >
                          {r.bankDate ? toDisplayDate(r.bankDate) : "Set date"}
                        </button>
                      </td>
                      <td className="r">
                        <button
                          className="text-[12px] text-muted hover:text-ink"
                          data-testid="btn-banking-mark-today"
                          onClick={() => void markToday(r.lineId, r.bankDate)}
                        >
                          {r.bankDate ? "Clear" : "Cleared today"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <p className="mt-2 text-[11.5px] text-muted">
            Import a statement CSV (date + debit/credit columns) to auto-match
            by amount and date; anything left over, set the bank date by hand.
          </p>

          {matchSuggestions.length > 0 && (
            <Panel
              className="mt-3 overflow-hidden p-0"
              data-testid="bank-match-assistant"
            >
              <div className="flex items-center justify-between border-b border-line bg-panel2 px-4 py-3">
                <div>
                  <p className="text-[11.5px] font-semibold">
                    Reconciliation assistant
                  </p>
                  <p className="mt-0.5 text-[9.5px] text-muted">
                    Near matches and grouped settlements. Review the evidence
                    before clearing.
                  </p>
                </div>
                <span className="num text-[10px] text-muted">
                  {matchSuggestions.length} proposed
                </span>
              </div>
              <div className="divide-y divide-line">
                {matchSuggestions.map((suggestion) => {
                  const key = `${suggestion.statementRow.rowNo}:${suggestion.kind}`;
                  const explanation = matchExplanations[key];
                  return (
                    <div
                      key={key}
                      className="grid gap-3 px-4 py-3 lg:grid-cols-[1fr_auto]"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[11.5px] font-semibold">
                            {suggestion.statementRow.description ||
                              `Statement row ${suggestion.statementRow.rowNo}`}
                          </p>
                          <span className="rounded bg-amberbar/15 px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em]">
                            {suggestion.kind === "many_to_one"
                              ? "Grouped match"
                              : "Within tolerance"}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-muted">
                          Statement{" "}
                          <Money paise={suggestion.statementRow.amount} /> ·{" "}
                          {suggestion.lines
                            .map(
                              (line) =>
                                `${line.number} ₹${(line.amount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
                            )
                            .join(" + ")}
                        </p>
                        {explanation && (
                          <div className="mt-2 rounded-md border border-line bg-panel2 px-3 py-2">
                            <p className="text-[10.5px] font-medium">
                              {explanation.summary}
                            </p>
                            <ul className="mt-1 space-y-0.5 text-[9.5px] text-muted">
                              {explanation.reasons.map((reason) => (
                                <li key={reason}>• {reason}</li>
                              ))}
                            </ul>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {explanation.citations.map((citation) => (
                                <span
                                  key={citation}
                                  className="num text-[8.5px] text-blue"
                                >
                                  {citation}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 self-center">
                        <Button
                          variant="ghost"
                          onClick={() => void explainMatch(suggestion)}
                        >
                          {explanation ? "Refresh why" : "Why this match?"}
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => void acceptMatch(suggestion)}
                        >
                          Accept & clear
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {suggestions && suggestions.length > 0 && (
            <Panel className="mt-3">
              <div className="border-b border-line px-4 py-2.5">
                <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                  Unmatched statement lines · {suggestions.length}
                </p>
              </div>
              <ScrollList maxH="40vh">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th className="w-24">Date</th>
                      <th>Description</th>
                      <th className="r w-32">Amount</th>
                      <th className="w-48">Suggested ledger</th>
                      <th className="w-56"></th>
                    </tr>
                  </thead>
                  <tbody data-testid="rows-banking-unmatched">
                    {suggestions.map((s, i) => (
                      <tr key={i} className="hover:bg-panel2">
                        <td className="num text-muted">
                          {toDisplayDate(s.statementRow.date)}
                        </td>
                        <td className="max-w-72 truncate">
                          {s.statementRow.description}
                        </td>
                        <td className="r">
                          <Money paise={s.statementRow.amount} />
                        </td>
                        <td>
                          {s.suggestion ? (
                            <span className="rounded px-1.5 py-0.5 text-[10.5px] bg-blue/10 text-blue">
                              {s.suggestion.ledgerName}
                            </span>
                          ) : (
                            <span className="text-[11.5px] text-muted">
                              No match
                            </span>
                          )}
                        </td>
                        <td className="r">
                          <button
                            className="mr-3 text-[12px] text-blue hover:underline"
                            data-testid="btn-banking-create-voucher"
                            onClick={() => void createFromSuggestion(s)}
                          >
                            Create voucher
                          </button>
                          <button
                            className="text-[12px] text-muted hover:text-ink"
                            data-testid="btn-banking-remember-rule"
                            onClick={() => rememberRule(s)}
                          >
                            Remember as rule
                          </button>
                          {s.suggestion && (
                            <button
                              className="ml-3 text-[12px] text-cr hover:underline"
                              onClick={() => void rejectSuggestion(s)}
                            >
                              Wrong
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollList>
            </Panel>
          )}
        </>
      )}

      {tab === "brs" && ledgerId != null && (
        <BrsSection ledgerId={ledgerId} defaultAsOn={to} />
      )}

      {tab === "pdc" && <PdcSection />}

      {rulesOpen && (
        <BankRulesModal
          key={rulesModalKey}
          prefill={rulesPrefill}
          onClose={() => setRulesOpen(false)}
        />
      )}
      {chequeSetupOpen && ledgerId != null && (
        <ChequeSetupModal
          bankLedgerId={ledgerId}
          bankLedgerName={
            (ledgers ?? []).find((l) => l.id === ledgerId)?.name ?? ""
          }
          onClose={() => setChequeSetupOpen(false)}
        />
      )}
      {dateEdit && (
        <BankDateModal
          lineId={dateEdit.lineId}
          current={dateEdit.current}
          context={to}
          onDone={() => {
            setDateEdit(null);
            void refresh();
          }}
          onClose={() => setDateEdit(null)}
        />
      )}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          onApply={() => void applyImport()}
          onClose={() => setImportPreview(null)}
        />
      )}
    </div>
  );
}

const CASH_DENOMINATIONS = [
  200000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100,
];

function BankFeedsSection({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const { data: feeds } = useQuery({
    queryKey: ["bankFeeds"],
    queryFn: api.bankFeeds.list,
  });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["bankFeeds"] });
  };
  const sync = async (id: number): Promise<void> => {
    setBusyId(id);
    try {
      const result = await api.bankFeeds.sync(id);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: ["bankWorkspace"] }),
        onRefresh(),
      ]);
      toast.push(
        "success",
        `${result.statementRows} feed rows retained · ${result.matched} matched · ${result.unmatched} for review`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };
  const status = async (
    id: number,
    value: "connected" | "paused" | "revoked",
  ): Promise<void> => {
    if (value === "revoked") {
      const proceed = await confirmDialog({
        title: "Revoke bank-feed consent",
        message:
          "Remove the encrypted access token and stop future syncs? Previously imported statement evidence stays in Total.",
        confirmLabel: "Revoke consent",
        danger: true,
      });
      if (!proceed) return;
    }
    try {
      await api.bankFeeds.setStatus(id, value);
      await refresh();
      toast.push(
        "success",
        value === "revoked"
          ? "Consent revoked and token removed"
          : `Feed ${value}`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <>
      <Panel className="overflow-hidden p-0" data-testid="bank-feeds">
        <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-5 py-3">
          <div>
            <p className="text-[12px] font-semibold">
              Optional read-only bank feeds
            </p>
            <p className="text-[10px] text-muted">
              Explicit statement-read consent only. CSV, XLSX, OFX, QIF and
              MT940 import always remain available.
            </p>
          </div>
          <Button variant="primary" onClick={() => setOpen(true)}>
            Connect provider
          </Button>
        </div>
        {!feeds?.length ? (
          <EmptyState
            title="No bank feed connected"
            hint="Total is fully usable with statement files; connecting a provider is optional"
          />
        ) : (
          <div>
            {feeds.map((feed) => (
              <div
                key={feed.id}
                className="grid grid-cols-[1fr_180px_160px_210px] items-center gap-4 border-b border-line px-5 py-4 last:border-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[12px] font-semibold">
                      {feed.displayName}
                    </p>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold uppercase ${feed.status === "connected" ? "bg-dr/10 text-dr" : feed.status === "revoked" ? "bg-cr/10 text-cr" : "bg-amber/15 text-amber"}`}
                    >
                      {feed.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[9px] text-muted">
                    {feed.endpoint}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-muted">Account</p>
                  <p className="text-[11px]">{feed.bankLedgerName}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-muted">Consent</p>
                  <p className="text-[10px]">statements.read</p>
                  <p className="text-[9px] text-muted">
                    to {feed.consentExpiresAt.slice(0, 10)}
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  {feed.status === "connected" && (
                    <>
                      <Button
                        disabled={busyId === feed.id}
                        onClick={() => void status(feed.id, "paused")}
                      >
                        Pause
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busyId === feed.id}
                        onClick={() => void sync(feed.id)}
                      >
                        {busyId === feed.id ? "Syncing…" : "Sync now"}
                      </Button>
                    </>
                  )}
                  {feed.status === "paused" && (
                    <Button
                      variant="primary"
                      onClick={() => void status(feed.id, "connected")}
                    >
                      Resume
                    </Button>
                  )}
                  {feed.status !== "revoked" && (
                    <Button
                      variant="danger"
                      onClick={() => void status(feed.id, "revoked")}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
                {feed.lastError && (
                  <p className="col-span-4 rounded bg-cr/5 px-3 py-1.5 text-[9.5px] text-cr">
                    Last sync: {feed.lastError}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
      {open && (
        <BankFeedModal onClose={() => setOpen(false)} onSaved={refresh} />
      )}
    </>
  );
}

function BankFeedModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const { data: banks } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const [bankLedgerId, setBankLedgerId] = useState<number | null>(null);
  const [name, setName] = useState("Open banking feed");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [expiry, setExpiry] = useState(
    new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const [consented, setConsented] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (bankLedgerId == null && banks?.length) setBankLedgerId(banks[0]!.id);
  }, [banks, bankLedgerId]);
  const save = async (): Promise<void> => {
    if (!bankLedgerId || !consented) return;
    setSaving(true);
    try {
      await api.bankFeeds.save({
        bankLedgerId,
        displayName: name,
        endpoint,
        consentExpiresAt: `${expiry}T23:59:59.999Z`,
        accessToken: token,
      });
      await onSaved();
      toast.push("success", "Read-only bank feed connected");
      onClose();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setSaving(false);
    }
  };
  return (
    <Modal title="Connect a bank-feed provider" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md border border-blue/20 bg-blue/5 px-3 py-2 text-[10px] leading-4 text-muted">
          <b className="text-ink">Scope: statements.read only.</b> Total
          requests transaction data; it cannot initiate payments. The token is
          encrypted with the operating system and never appears in exports or
          audit details.
        </div>
        <Field label="Bank ledger">
          <Select
            value={bankLedgerId ?? ""}
            onChange={(e) => setBankLedgerId(Number(e.target.value))}
          >
            {(banks ?? []).map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Connection name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Provider transactions endpoint"
          hint="HTTPS JSON endpoint using Total's documented read-only transaction shape"
        >
          <TextInput
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://provider.example/v1/transactions"
          />
        </Field>
        <Field label="Access token">
          <TextInput
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Consent expires">
          <DateInput value={expiry} context={todayISO()} onChange={setExpiry} />
        </Field>
        <label className="flex items-start gap-2 text-[10.5px] leading-4 text-muted">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={consented}
            onChange={(e) => setConsented(e.target.checked)}
          />
          <span>
            I authorize Total to read statements for this account until the date
            above. I can pause or revoke access at any time.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              saving ||
              !consented ||
              !bankLedgerId ||
              !endpoint ||
              token.length < 8
            }
            onClick={() => void save()}
          >
            Connect read-only feed
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TreasurySection(): React.JSX.Element {
  const asOn = todayISO();
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: position } = useQuery({
    queryKey: ["treasuryPosition", asOn],
    queryFn: () => api.treasury.position(asOn),
  });
  const { data: scenarios } = useQuery({
    queryKey: ["treasuryScenarios"],
    queryFn: api.treasury.scenarios,
  });
  const { data: forecast } = useQuery({
    queryKey: ["treasuryForecast", asOn, scenarioId],
    queryFn: () => api.treasury.forecast(asOn, scenarioId),
  });
  const { data: alerts } = useQuery({
    queryKey: ["treasuryAlerts", asOn, scenarioId],
    queryFn: () => api.treasury.alerts(asOn, scenarioId),
  });
  if (!position || !forecast)
    return (
      <Panel className="flex items-center justify-center py-16">
        <Spinner />
      </Panel>
    );
  const maxFlow = Math.max(
    1,
    ...forecast.weeks.flatMap((week) => [week.inflows, week.outflows]),
  );
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="font-serif text-[20px] font-semibold">Cash runway</p>
          <p className="text-[10.5px] text-muted">
            Today plus expected bills and recurring commitments—never a promise
            that cash will arrive.
          </p>
        </div>
        <div className="flex gap-2">
          <Select
            value={scenarioId ?? ""}
            onChange={(e) =>
              setScenarioId(e.target.value ? Number(e.target.value) : null)
            }
            className="w-48"
            data-testid="treasury-scenario"
          >
            <option value="">Base case</option>
            {(scenarios ?? []).map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </Select>
          <Button onClick={() => setScenarioOpen(true)}>New scenario</Button>
          <Button onClick={() => setSettingsOpen(true)}>Thresholds</Button>
        </div>
      </div>
      {(alerts?.length ?? 0) > 0 && (
        <div className="mb-3 space-y-2">
          {alerts?.map((alert) => (
            <div
              key={alert.kind}
              className={`flex items-center justify-between rounded-lg border px-4 py-2.5 ${alert.kind === "shortfall" ? "border-cr/30 bg-cr/5" : "border-amber/30 bg-amber/5"}`}
            >
              <span>
                <b
                  className={`text-[11.5px] ${alert.kind === "shortfall" ? "text-cr" : "text-amber"}`}
                >
                  {alert.title}
                </b>
                <span className="ml-2 text-[10px] text-muted">
                  {alert.detail}
                </span>
              </span>
              <span className="num text-[11px] font-semibold">
                <Money paise={alert.amount} signed />
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mb-3 grid grid-cols-4 gap-2">
        <Panel className="px-4 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
            Available today
          </p>
          <p className="num mt-1 text-[17px] font-semibold">
            <Money paise={position.availableNow} signed />
          </p>
        </Panel>
        <Panel className="px-4 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
            Expected 7-day receipts
          </p>
          <p className="num mt-1 text-[17px] font-semibold text-dr">
            <Money paise={position.expectedReceipts} />
          </p>
        </Panel>
        <Panel className="px-4 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
            Expected 7-day payments
          </p>
          <p className="num mt-1 text-[17px] font-semibold text-cr">
            <Money paise={position.expectedPayments} />
          </p>
        </Panel>
        <Panel className="px-4 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
            Projected in 7 days
          </p>
          <p
            className={`num mt-1 text-[17px] font-semibold ${position.projectedAvailable < 0 ? "text-cr" : ""}`}
          >
            <Money paise={position.projectedAvailable} signed />
          </p>
        </Panel>
      </div>
      <div className="grid grid-cols-[220px_1fr] gap-3">
        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line bg-panel2/55 px-4 py-2.5">
            <p className="text-[11px] font-semibold">Accounts today</p>
          </div>
          {position.accounts.map((account) => (
            <div
              key={account.ledgerId}
              className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0"
            >
              <span>
                <span className="block text-[11px] font-medium">
                  {account.name}
                </span>
                <span className="text-[8.5px] uppercase text-muted">
                  {account.kind}
                </span>
              </span>
              <span className="num text-[10.5px]">
                <Money paise={account.balance} signed />
              </span>
            </div>
          ))}
        </Panel>
        <Panel className="overflow-hidden p-0" data-testid="treasury-forecast">
          <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-4 py-2.5">
            <div>
              <p className="text-[11px] font-semibold">
                13-week forecast · {forecast.scenarioName}
              </p>
              <p className="text-[9px] text-muted">
                Lowest projected balance: week {forecast.lowestWeek}
              </p>
            </div>
            <span
              className={`num text-[12px] font-semibold ${forecast.lowestClosing < 0 ? "text-cr" : "text-dr"}`}
            >
              <Money paise={forecast.lowestClosing} signed />
            </span>
          </div>
          <div className="grid grid-cols-13 gap-1 px-4 pb-3 pt-5">
            {forecast.weeks.map((week) => (
              <div key={week.week} className="min-w-0">
                <div className="flex h-28 items-end justify-center gap-px border-b border-line">
                  <div
                    className="w-2 bg-dr/70"
                    style={{
                      height: `${Math.max(2, Math.round((week.inflows / maxFlow) * 100))}%`,
                    }}
                    title={`Inflows ₹${week.inflows / 100}`}
                  />
                  <div
                    className="w-2 bg-cr/55"
                    style={{
                      height: `${Math.max(2, Math.round((week.outflows / maxFlow) * 100))}%`,
                    }}
                    title={`Outflows ₹${week.outflows / 100}`}
                  />
                </div>
                <p className="mt-1 text-center font-mono text-[8px] text-muted">
                  W{week.week}
                </p>
                <p
                  className={`truncate text-center font-mono text-[7px] ${week.closing < 0 ? "text-cr" : "text-muted"}`}
                >
                  {Math.round(week.closing / 100000)}L
                </p>
              </div>
            ))}
          </div>
          <div className="border-t border-line">
            <ScrollList maxH="22vh">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th className="r">Inflows</th>
                    <th className="r">Outflows</th>
                    <th className="r">Net</th>
                    <th className="r">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.weeks.map((week) => (
                    <tr key={week.week}>
                      <td className="text-[10px]">
                        W{week.week} · {toDisplayDate(week.from)}–
                        {toDisplayDate(week.to)}
                      </td>
                      <td className="r text-dr">
                        <Money paise={week.inflows} />
                      </td>
                      <td className="r text-cr">
                        <Money paise={week.outflows} />
                      </td>
                      <td className="r">
                        <Money paise={week.net} signed />
                      </td>
                      <td
                        className={`r font-medium ${week.closing < 0 ? "text-cr" : ""}`}
                      >
                        <Money paise={week.closing} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
          </div>
        </Panel>
      </div>
      {scenarioOpen && (
        <LiquidityScenarioModal onClose={() => setScenarioOpen(false)} />
      )}
      {settingsOpen && (
        <TreasuryThresholdModal onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}

function LiquidityScenarioModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Conservative case");
  const [collectionDelayDays, setCollectionDelayDays] = useState(14);
  const [collectionRealization, setCollectionRealization] = useState(80);
  const [paymentDelayDays, setPaymentDelayDays] = useState(0);
  const [eventDate, setEventDate] = useState(todayISO());
  const [eventLabel, setEventLabel] = useState("Major purchase");
  const [eventDirection, setEventDirection] = useState<"inflow" | "outflow">(
    "outflow",
  );
  const [eventKind, setEventKind] = useState<
    "purchase" | "loan" | "tax" | "other"
  >("purchase");
  const [eventAmount, setEventAmount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.treasury.scenarioSave({
        name,
        collectionDelayDays,
        collectionRealizationBp: collectionRealization * 100,
        paymentDelayDays,
        events:
          eventAmount && eventAmount > 0
            ? [
                {
                  date: eventDate,
                  label: eventLabel,
                  direction: eventDirection,
                  amount: eventAmount,
                  kind: eventKind,
                },
              ]
            : [],
      });
      await queryClient.invalidateQueries({ queryKey: ["treasuryScenarios"] });
      toast.push("success", "Liquidity scenario saved");
      onClose();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setSaving(false);
    }
  };
  return (
    <Modal title="New liquidity scenario" onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-[11px] leading-5 text-muted">
          Scenarios never post entries or change reports. They only shift the
          forecast assumptions shown in Treasury.
        </p>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Scenario name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Collection delay (days)">
            <TextInput
              type="number"
              min="0"
              value={collectionDelayDays}
              onChange={(e) =>
                setCollectionDelayDays(Number(e.target.value) || 0)
              }
            />
          </Field>
          <Field label="Collections realized %">
            <TextInput
              type="number"
              min="0"
              max="100"
              value={collectionRealization}
              onChange={(e) =>
                setCollectionRealization(
                  Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                )
              }
            />
          </Field>
          <Field label="Payment delay (days)">
            <TextInput
              type="number"
              min="0"
              value={paymentDelayDays}
              onChange={(e) => setPaymentDelayDays(Number(e.target.value) || 0)}
            />
          </Field>
        </div>
        <div className="rounded-md border border-line bg-panel2/40 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
            Optional one-off event
          </p>
          <div className="grid grid-cols-5 gap-3">
            <Field label="Date">
              <DateInput
                value={eventDate}
                context={todayISO()}
                onChange={setEventDate}
              />
            </Field>
            <Field label="Label">
              <TextInput
                value={eventLabel}
                onChange={(e) => setEventLabel(e.target.value)}
              />
            </Field>
            <Field label="Direction">
              <Select
                value={eventDirection}
                onChange={(e) =>
                  setEventDirection(e.target.value as typeof eventDirection)
                }
              >
                <option value="outflow">Outflow</option>
                <option value="inflow">Inflow</option>
              </Select>
            </Field>
            <Field label="Kind">
              <Select
                value={eventKind}
                onChange={(e) =>
                  setEventKind(e.target.value as typeof eventKind)
                }
              >
                <option value="purchase">Purchase</option>
                <option value="loan">Loan</option>
                <option value="tax">Tax</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Amount">
              <AmountInput paise={eventAmount} onPaise={setEventAmount} />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !name.trim()}
            onClick={() => void save()}
          >
            Save scenario
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TreasuryThresholdModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["treasuryAlertSettings"],
    queryFn: api.treasury.alertSettings,
  });
  if (!data)
    return (
      <Modal title="Treasury thresholds" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  return (
    <TreasuryThresholdForm
      key={`${data.minimumLiquidity}:${data.idleCashThreshold}:${data.sustainedWeeks}`}
      initial={data}
      onClose={onClose}
      onSaved={async () => {
        await queryClient.invalidateQueries({ queryKey: ["treasuryAlerts"] });
        toast.push("success", "Treasury thresholds saved");
      }}
    />
  );
}

function TreasuryThresholdForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Awaited<ReturnType<typeof api.treasury.alertSettings>>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [minimum, setMinimum] = useState<number | null>(
    initial.minimumLiquidity,
  );
  const [idle, setIdle] = useState<number | null>(initial.idleCashThreshold);
  const [weeks, setWeeks] = useState(initial.sustainedWeeks);
  const save = async (): Promise<void> => {
    try {
      await api.treasury.alertSettingsSet({
        minimumLiquidity: minimum ?? 0,
        idleCashThreshold: idle ?? 0,
        sustainedWeeks: weeks,
      });
      await onSaved();
      onClose();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <Modal title="Treasury thresholds" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Minimum operating liquidity">
          <AmountInput paise={minimum} onPaise={setMinimum} />
        </Field>
        <Field label="Excess-cash threshold">
          <AmountInput paise={idle} onPaise={setIdle} />
        </Field>
        <Field label="Weeks before excess alert">
          <TextInput
            type="number"
            min="1"
            max="13"
            value={weeks}
            onChange={(e) =>
              setWeeks(Math.max(1, Math.min(13, Number(e.target.value) || 1)))
            }
          />
        </Field>
        <p className="text-[10px] leading-4 text-muted">
          These are internal planning signals only. Total never recommends
          investments or moves money.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save thresholds
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CashCountSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToasts();
  const { data: cashLedgers } = useQuery({
    queryKey: ["cashLedgers"],
    queryFn: api.bank.cashLedgers,
  });
  const { data: sessions } = useQuery({
    queryKey: ["cashCounts"],
    queryFn: api.bank.cashCounts,
  });
  const [ledgerId, setLedgerId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState<
    NonNullable<typeof sessions>[number] | null
  >(null);
  useEffect(() => {
    if (ledgerId == null && cashLedgers?.length)
      setLedgerId(cashLedgers[0]!.id);
  }, [cashLedgers, ledgerId]);
  const lines = CASH_DENOMINATIONS.map((denominationPaise) => ({
    denominationPaise,
    count: counts[denominationPaise] ?? 0,
  }));
  const { data: preview } = useQuery({
    queryKey: ["cashCountPreview", ledgerId, date, counts],
    queryFn: () => api.bank.cashCountPreview(ledgerId!, date, lines),
    enabled: ledgerId != null,
  });
  const save = async (): Promise<void> => {
    if (ledgerId == null || !preview || preview.physicalTotal === 0) return;
    try {
      await api.bank.cashCountSave(ledgerId, date, lines, note.trim() || null);
      await queryClient.invalidateQueries({ queryKey: ["cashCounts"] });
      setCounts({});
      setNote("");
      toast.push("success", "Cash count saved for owner review");
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <>
      <div className="grid grid-cols-[1.15fr_0.85fr] gap-3">
        <Panel
          className="overflow-hidden p-0"
          data-testid="cash-count-workspace"
        >
          <div className="border-b border-line bg-panel2/55 px-5 py-3">
            <p className="text-[12px] font-semibold">Physical cash count</p>
            <p className="text-[10px] text-muted">
              Count notes and coins; Total compares the result to the books
              before any adjustment.
            </p>
          </div>
          <div className="p-4">
            <div className="mb-4 grid grid-cols-2 gap-3">
              <Field label="Cash ledger">
                <Select
                  value={ledgerId ?? ""}
                  onChange={(e) => setLedgerId(Number(e.target.value))}
                >
                  {(cashLedgers ?? []).map((ledger) => (
                    <option key={ledger.id} value={ledger.id}>
                      {ledger.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Count date">
                <DateInput
                  value={date}
                  context={todayISO()}
                  onChange={setDate}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              {CASH_DENOMINATIONS.map((denomination) => (
                <label
                  key={denomination}
                  className="grid grid-cols-[80px_1fr_100px] items-center gap-2 text-[11px]"
                >
                  <span className="font-mono text-muted">
                    ₹{denomination / 100}
                  </span>
                  <TextInput
                    aria-label={`Count of ₹${denomination / 100}`}
                    type="number"
                    min="0"
                    value={counts[denomination] ?? ""}
                    onChange={(e) =>
                      setCounts((current) => ({
                        ...current,
                        [denomination]: Math.max(
                          0,
                          Number(e.target.value) || 0,
                        ),
                      }))
                    }
                    className="num"
                  />
                  <span className="num text-right">
                    <Money paise={denomination * (counts[denomination] ?? 0)} />
                  </span>
                </label>
              ))}
            </div>
            <Field label="Count note">
              <TextInput
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Counter, location or handover note"
              />
            </Field>
          </div>
        </Panel>
        <div>
          <Panel className="mb-3 overflow-hidden p-0">
            <div className="border-b border-line px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                Count reconciliation
              </p>
            </div>
            <div className="space-y-3 p-4">
              {[
                ["Physical total", preview?.physicalTotal ?? 0],
                ["Balance in books", preview?.bookBalance ?? 0],
                ["Difference", preview?.difference ?? 0],
              ].map(([label, value], index) => (
                <div
                  key={String(label)}
                  className={`flex items-center justify-between ${index === 2 ? "border-t border-line pt-3 font-semibold" : ""}`}
                >
                  <span className="text-[11px] text-muted">{label}</span>
                  <span
                    className={`num text-[13px] ${index === 2 && Number(value) !== 0 ? "text-cr" : ""}`}
                  >
                    <Money paise={Number(value)} signed={index === 2} />
                  </span>
                </div>
              ))}
              <Button
                variant="primary"
                disabled={!preview || preview.physicalTotal === 0}
                onClick={() => void save()}
              >
                Save count for review
              </Button>
              <p className="text-[9.5px] leading-4 text-muted">
                Saving never changes the books. An owner must post the exact
                difference separately.
              </p>
            </div>
          </Panel>
          <Panel className="overflow-hidden p-0">
            <div className="border-b border-line bg-panel2/55 px-4 py-2.5">
              <p className="text-[11px] font-semibold">Recent counts</p>
            </div>
            {!sessions?.length ? (
              <EmptyState title="No count sessions" />
            ) : (
              <ScrollList maxH="30vh">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className="grid grid-cols-[1fr_90px_90px] items-center gap-2 border-b border-line px-4 py-2.5 last:border-0"
                  >
                    <span>
                      <span className="block text-[11px] font-medium">
                        {session.cashLedgerName}
                      </span>
                      <span className="text-[9px] text-muted">
                        {toDisplayDate(session.date)} · {session.status}
                      </span>
                    </span>
                    <span
                      className={`num text-right text-[10.5px] ${session.difference ? "text-cr" : "text-dr"}`}
                    >
                      <Money paise={session.difference} signed />
                    </span>
                    {session.status === "draft" ? (
                      <Button onClick={() => setPosting(session)}>Post</Button>
                    ) : (
                      <span className="text-right text-[9px] text-muted">
                        {session.postedBy ?? "Posted"}
                      </span>
                    )}
                  </div>
                ))}
              </ScrollList>
            )}
          </Panel>
        </div>
      </div>
      {posting && (
        <CashCountPostModal
          session={posting}
          onClose={() => setPosting(null)}
          onPosted={async () => {
            setPosting(null);
            await queryClient.invalidateQueries({ queryKey: ["cashCounts"] });
          }}
        />
      )}
    </>
  );
}

function CashCountPostModal({
  session,
  onClose,
  onPosted,
}: {
  session: Awaited<ReturnType<typeof api.bank.cashCounts>>[number];
  onClose: () => void;
  onPosted: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [adjustmentLedgerId, setAdjustmentLedgerId] = useState<number | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const post = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.bank.cashCountPost(
        session.id,
        session.difference === 0 ? null : adjustmentLedgerId,
      );
      toast.push(
        "success",
        session.difference === 0
          ? "Cash count approved with no difference"
          : "Cash difference posted as an explicit journal",
      );
      await onPosted();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setSaving(false);
    }
  };
  return (
    <Modal title="Approve cash count" onClose={onClose}>
      <div className="space-y-4">
        <Panel className="px-4 py-3">
          <div className="flex justify-between text-[11px]">
            <span className="text-muted">Physical cash</span>
            <Money paise={session.physicalTotal} />
          </div>
          <div className="mt-2 flex justify-between text-[11px]">
            <span className="text-muted">Books</span>
            <Money paise={session.bookBalance} />
          </div>
          <div className="mt-3 flex justify-between border-t border-line pt-3 text-[12px] font-semibold">
            <span>Difference</span>
            <span className={session.difference ? "text-cr" : "text-dr"}>
              <Money paise={session.difference} signed />
            </span>
          </div>
        </Panel>
        {session.difference !== 0 && (
          <Field
            label="Cash difference ledger"
            hint="For example Cash Short & Over"
          >
            <LedgerPicker
              value={adjustmentLedgerId}
              onPick={setAdjustmentLedgerId}
              placeholder="Choose adjustment ledger"
            />
          </Field>
        )}
        <p className="text-[10px] text-muted">
          Posting freezes this count and creates one reviewable journal only for
          the exact difference.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              saving || (session.difference !== 0 && adjustmentLedgerId == null)
            }
            onClick={() => void post()}
          >
            Approve & post
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChequeLifecycleSection({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const nav = useNav();
  const [editing, setEditing] = useState<
    Awaited<ReturnType<typeof api.bank.cheques>>[number] | null
  >(null);
  const { data: rows, isLoading } = useQuery({
    queryKey: ["bankCheques", todayISO()],
    queryFn: () => api.bank.cheques(todayISO()),
  });
  const counts = (rows ?? []).reduce<Record<string, number>>(
    (acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }),
    {},
  );
  if (isLoading)
    return (
      <Panel className="flex items-center justify-center py-16">
        <Spinner />
      </Panel>
    );
  const tone: Record<string, string> = {
    cleared: "bg-dr/10 text-dr",
    bounced: "bg-cr/10 text-cr",
    cancelled: "bg-panel2 text-muted",
    stale: "bg-amber/15 text-amber",
    issued: "bg-blue/10 text-blue",
    deposited: "bg-blue/10 text-blue",
  };
  return (
    <>
      <div className="mb-3 grid grid-cols-5 gap-2">
        {[
          ["Open", (counts.issued ?? 0) + (counts.deposited ?? 0)],
          ["Cleared", counts.cleared ?? 0],
          ["Bounced", counts.bounced ?? 0],
          ["Stale", counts.stale ?? 0],
          ["Cancelled", counts.cancelled ?? 0],
        ].map(([label, count]) => (
          <Panel key={String(label)} className="px-3 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
              {label}
            </p>
            <p className="num mt-0.5 text-[17px] font-semibold">{count}</p>
          </Panel>
        ))}
      </div>
      <Panel className="overflow-hidden p-0" data-testid="cheque-lifecycle">
        <div className="border-b border-line bg-panel2/55 px-5 py-3">
          <p className="text-[12px] font-semibold">Cheque lifecycle register</p>
          <p className="text-[10px] text-muted">
            Issued, deposited, cleared, bounced, cancelled and automatically
            stale after 90 days.
          </p>
        </div>
        {!rows?.length ? (
          <EmptyState
            title="No cheque instruments found"
            hint="Add a cheque or instrument number to a payment or receipt voucher"
          />
        ) : (
          <ScrollList maxH="55vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="w-24">Instrument</th>
                  <th>Party</th>
                  <th className="w-36">Bank</th>
                  <th className="w-24">Date</th>
                  <th className="r w-28">Amount</th>
                  <th className="w-24">State</th>
                  <th className="w-36"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.voucherId}>
                    <td className="font-mono text-[10px]">
                      {row.instrumentNo}
                    </td>
                    <td>
                      <button
                        className="max-w-56 truncate text-left font-medium hover:text-blue"
                        onClick={() =>
                          nav.go({
                            name: "voucher-entry",
                            voucherId: row.voucherId,
                          })
                        }
                      >
                        {row.partyName || row.number}
                      </button>
                      <span className="block text-[9px] text-muted">
                        {row.number}
                      </span>
                    </td>
                    <td className="text-muted">{row.bankLedgerName}</td>
                    <td className="num text-muted">
                      {toDisplayDate(row.instrumentDate ?? row.date)}
                    </td>
                    <td className="r">
                      <Money paise={row.amount} />
                    </td>
                    <td>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${tone[row.status]}`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="r">
                      <Button onClick={() => setEditing(row)}>
                        Update status
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollList>
        )}
      </Panel>
      {editing && (
        <ChequeStatusModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onRefresh();
          }}
        />
      )}
    </>
  );
}

function ChequeStatusModal({
  row,
  onClose,
  onSaved,
}: {
  row: Awaited<ReturnType<typeof api.bank.cheques>>[number];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const base = row.voucherKind === "payment" ? "issued" : "deposited";
  const [status, setStatus] = useState<
    "issued" | "deposited" | "cleared" | "bounced" | "cancelled"
  >(row.status === "stale" ? base : row.status);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState(row.note ?? "");
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.bank.chequeStatus(
        row.voucherId,
        status,
        date,
        note.trim() || null,
      );
      await queryClient.invalidateQueries({ queryKey: ["bankCheques"] });
      toast.push("success", `Cheque ${row.instrumentNo} marked ${status}`);
      await onSaved();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setSaving(false);
    }
  };
  return (
    <Modal title={`Cheque ${row.instrumentNo}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-panel2/50 px-3 py-2">
          <p className="text-[12px] font-medium">
            {row.partyName || row.number}
          </p>
          <p className="mt-0.5 text-[10px] text-muted">
            {row.bankLedgerName} · <Money paise={row.amount} />
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="New status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value={base}>
                {base === "issued" ? "Issued" : "Deposited"}
              </option>
              <option value="cleared">Cleared</option>
              <option value="bounced">Bounced</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field label="Status date">
            <DateInput value={date} context={todayISO()} onChange={setDate} />
          </Field>
        </div>
        <Field label="Review note">
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional bank reference or reason"
          />
        </Field>
        <p className="text-[10px] text-muted">
          Cleared updates the bank date. Bounced reopens the bank line for
          reconciliation; accounting reversal remains an explicit voucher
          action.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => void save()}
          >
            Save status
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChargeExtractionSection({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [reviewing, setReviewing] = useState<BankChargeSuggestion | null>(null);
  const { data: rows, isLoading } = useQuery({
    queryKey: ["bankChargeSuggestions"],
    queryFn: api.bank.chargeSuggestions,
  });
  if (isLoading)
    return (
      <Panel className="flex items-center justify-center py-16">
        <Spinner />
      </Panel>
    );
  return (
    <>
      <Panel
        className="overflow-hidden p-0"
        data-testid="bank-charge-suggestions"
      >
        <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-5 py-3">
          <div>
            <p className="text-[12px] font-semibold">
              Net settlement deductions
            </p>
            <p className="text-[10px] text-muted">
              Explain the gap between a gross book receipt and the net amount
              credited by the bank.
            </p>
          </div>
          <span className="rounded bg-cr/10 px-2 py-1 font-mono text-[9px] font-semibold text-cr">
            {rows?.length ?? 0} TO REVIEW
          </span>
        </div>
        {!rows?.length ? (
          <EmptyState
            title="No settlement deductions found"
            hint="Potential gateway fees and bank charges appear after statement import"
          />
        ) : (
          <div>
            {rows.map((row) => (
              <div
                key={row.statementRowId}
                className="grid grid-cols-[1fr_115px_115px_115px_120px] items-center gap-4 border-b border-line px-5 py-3.5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold">
                    {row.description || row.bankLedgerName}
                  </p>
                  <p className="mt-0.5 text-[9.5px] text-muted">
                    {row.bankLedgerName} · {toDisplayDate(row.date)} · book
                    voucher {row.voucherNumber}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[8.5px] uppercase tracking-[0.08em] text-muted">
                    Gross books
                  </p>
                  <p className="num text-[11.5px]">
                    <Money paise={row.grossBookAmount} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[8.5px] uppercase tracking-[0.08em] text-muted">
                    Net bank
                  </p>
                  <p className="num text-[11.5px] text-dr">
                    <Money paise={row.netAmount} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[8.5px] uppercase tracking-[0.08em] text-muted">
                    Difference
                  </p>
                  <p className="num text-[11.5px] font-semibold text-cr">
                    <Money paise={row.deductionAmount} />
                  </p>
                </div>
                <Button variant="primary" onClick={() => setReviewing(row)}>
                  Review split
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {reviewing && (
        <ChargeExtractionModal
          row={reviewing}
          onClose={() => setReviewing(null)}
          onPosted={async () => {
            setReviewing(null);
            await onRefresh();
          }}
        />
      )}
    </>
  );
}

function ChargeExtractionModal({
  row,
  onClose,
  onPosted,
}: {
  row: BankChargeSuggestion;
  onClose: () => void;
  onPosted: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [feeLedgerId, setFeeLedgerId] = useState<number | null>(null);
  const [taxLedgerId, setTaxLedgerId] = useState<number | null>(null);
  const [feeAmount, setFeeAmount] = useState<number | null>(
    row.suggestedFeeAmount,
  );
  const [taxAmount, setTaxAmount] = useState<number | null>(
    row.suggestedTaxAmount,
  );
  const [posting, setPosting] = useState(false);
  const explained = (feeAmount ?? 0) + (taxAmount ?? 0);
  const valid =
    feeLedgerId != null &&
    (feeAmount ?? 0) > 0 &&
    explained === row.deductionAmount &&
    ((taxAmount ?? 0) === 0 || taxLedgerId != null);
  const post = async (): Promise<void> => {
    if (!valid || feeAmount == null) return;
    setPosting(true);
    try {
      const result = await api.bank.postChargeExtraction({
        statementRowId: row.statementRowId,
        settlementLineId: row.settlementLineId,
        feeLedgerId,
        taxLedgerId,
        feeAmount,
        taxAmount: taxAmount ?? 0,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bankChargeSuggestions"] }),
        queryClient.invalidateQueries({ queryKey: ["bankWorkspace"] }),
      ]);
      toast.push(
        "success",
        `Charges posted in voucher #${result.voucherId}; net settlement reconciled`,
      );
      await onPosted();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setPosting(false);
    }
  };
  return (
    <Modal title="Review settlement deduction" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Panel className="px-3 py-2">
            <p className="text-[9px] uppercase text-muted">Gross receipt</p>
            <p className="num mt-1 text-[13px]">
              <Money paise={row.grossBookAmount} />
            </p>
          </Panel>
          <Panel className="px-3 py-2">
            <p className="text-[9px] uppercase text-muted">Net credited</p>
            <p className="num mt-1 text-[13px] text-dr">
              <Money paise={row.netAmount} />
            </p>
          </Panel>
          <Panel className="px-3 py-2">
            <p className="text-[9px] uppercase text-muted">Must explain</p>
            <p className="num mt-1 text-[13px] text-cr">
              <Money paise={row.deductionAmount} />
            </p>
          </Panel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fee / commission ledger">
            <LedgerPicker
              value={feeLedgerId}
              onPick={setFeeLedgerId}
              placeholder="Choose expense ledger"
            />
          </Field>
          <Field label="Fee amount">
            <AmountInput
              paise={feeAmount}
              onPaise={setFeeAmount}
              testId="input-bank-charge-fee"
            />
          </Field>
          <Field label="Input tax ledger">
            <LedgerPicker
              value={taxLedgerId}
              onPick={setTaxLedgerId}
              placeholder="Choose tax ledger"
            />
          </Field>
          <Field label="Tax amount">
            <AmountInput
              paise={taxAmount}
              onPaise={setTaxAmount}
              testId="input-bank-charge-tax"
            />
          </Field>
        </div>
        <div
          className={`rounded-md border px-3 py-2 text-[10.5px] ${explained === row.deductionAmount ? "border-dr/30 bg-dr/5 text-dr" : "border-cr/30 bg-cr/5 text-cr"}`}
        >
          {explained === row.deductionAmount ? (
            "The split explains the gross-to-net difference exactly."
          ) : (
            <>
              Still unexplained:{" "}
              <Money paise={row.deductionAmount - explained} signed />
            </>
          )}
        </div>
        <p className="text-[10px] leading-4 text-muted">
          This keeps the original gross receipt untouched and posts a linked
          payment voucher for the deduction. Nothing is changed until you
          confirm.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid || posting}
            onClick={() => void post()}
          >
            Post & reconcile
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TransferSuggestionsSection({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["bankTransfers"],
    queryFn: api.bank.transferSuggestions,
  });
  const post = async (row: NonNullable<typeof rows>[number]): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Post inter-bank transfer",
      message: `Post one Contra voucher moving ₹${(row.amount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })} from ${row.fromLedgerName} to ${row.toLedgerName}? Both statement lines will be marked matched.`,
      confirmLabel: "Post contra",
    });
    if (!proceed) return;
    try {
      const result = await api.bank.postTransfer(
        row.withdrawalRowId,
        row.depositRowId,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bankTransfers"] }),
        queryClient.invalidateQueries({ queryKey: ["bankWorkspace"] }),
        onRefresh(),
      ]);
      toast.push(
        "success",
        `Contra voucher #${result.voucherId} posted and both bank lines linked`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  if (isLoading)
    return (
      <Panel className="flex items-center justify-center py-16">
        <Spinner />
      </Panel>
    );
  return (
    <Panel
      className="overflow-hidden p-0"
      data-testid="bank-transfer-suggestions"
    >
      <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-5 py-3">
        <div>
          <p className="text-[12px] font-semibold">
            Inter-bank transfer review
          </p>
          <p className="text-[10px] text-muted">
            Same-value money out and money in across your accounts, paired by
            date and reference.
          </p>
        </div>
        <span className="rounded bg-amber/15 px-2 py-1 font-mono text-[9px] font-semibold text-amber">
          {rows?.length ?? 0} SUGGESTED
        </span>
      </div>
      {!rows?.length ? (
        <EmptyState
          title="No transfer pairs need review"
          hint="Import statements for two or more bank accounts; likely transfers will appear here"
        />
      ) : (
        <div>
          {rows.map((row) => (
            <div
              key={`${row.withdrawalRowId}-${row.depositRowId}`}
              className="grid grid-cols-[1fr_70px_1fr_130px_120px] items-center gap-4 border-b border-line px-5 py-4 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[12px] font-semibold">
                  {row.fromLedgerName}
                </p>
                <p className="mt-0.5 text-[10px] text-muted">
                  Money out · {toDisplayDate(row.withdrawalDate)}
                </p>
              </div>
              <div className="text-center">
                <span className="font-mono text-[15px] text-amber">→</span>
                <span className="block text-[8px] text-muted">
                  {row.confidence}%
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-[12px] font-semibold">
                  {row.toLedgerName}
                </p>
                <p className="mt-0.5 text-[10px] text-muted">
                  Money in · {toDisplayDate(row.depositDate)}
                </p>
              </div>
              <div className="text-right">
                <p className="num text-[13px] font-semibold">
                  <Money paise={row.amount} />
                </p>
                <p className="truncate font-mono text-[9px] text-muted">
                  {row.reference || "No shared reference"}
                </p>
              </div>
              <Button variant="primary" onClick={() => void post(row)}>
                Post contra
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ReconciliationWorkspaceSection({
  ledgerId,
  onRefresh,
}: {
  ledgerId: number;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["bankWorkspace", ledgerId],
    queryFn: () => api.bank.workspace(ledgerId),
  });

  const classify = async (
    row: BankReconciliationWorkspace["statementRows"][number],
    status: "bank_only" | "ignored" | "timing_difference",
  ): Promise<void> => {
    try {
      const note =
        status === "timing_difference"
          ? "Reviewed as a timing difference"
          : status === "ignored"
            ? "Reviewed and excluded from reconciliation"
            : null;
      await api.bank.classifyRow(row.id, status, note);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["bankWorkspace", ledgerId],
        }),
        onRefresh(),
      ]);
      toast.push(
        "success",
        status === "bank_only"
          ? "Classification reset"
          : status === "ignored"
            ? "Line ignored with audit trail"
            : "Marked as timing difference",
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  if (isLoading || !data)
    return (
      <Panel className="flex items-center justify-center py-16">
        <Spinner />
      </Panel>
    );
  if (!data.latestImport) {
    return (
      <Panel className="overflow-hidden p-0">
        <div className="grid min-h-72 place-items-center bg-[radial-gradient(circle_at_50%_0%,color-mix(in_srgb,var(--t-amberbar)_11%,transparent),transparent_52%)] px-8 text-center">
          <div className="max-w-lg">
            <p className="mb-2 text-[10px] font-semibold tracking-[0.16em] text-amber uppercase">
              A complete trail, not a checkbox
            </p>
            <h2 className="font-serif text-[24px] font-semibold text-ink">
              Bring the bank and books into one review queue.
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[12px] leading-5 text-muted">
              Import a statement to retain every bank line, expose missing book
              entries, and explain the opening balance before you reconcile
              anything.
            </p>
            <p className="mt-5 text-[11px] text-muted">
              Use <span className="font-medium text-ink">Import statement</span>{" "}
              above to begin.
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  const total =
    data.counts.matched +
    data.counts.bankOnly +
    data.counts.ignored +
    data.counts.timingDifference +
    data.counts.bookOnly;
  const resolved =
    data.counts.matched + data.counts.ignored + data.counts.timingDifference;
  const completion = total === 0 ? 100 : Math.round((resolved / total) * 100);
  const openingExplained =
    data.openingDifference === null || data.openingDifference === 0;
  const statusStyle: Record<string, string> = {
    matched: "bg-dr/10 text-dr",
    bank_only: "bg-cr/10 text-cr",
    ignored: "bg-panel2 text-muted",
    timing_difference: "bg-amber/15 text-amber",
  };
  const statusLabel: Record<string, string> = {
    matched: "Matched",
    bank_only: "Bank only",
    ignored: "Ignored",
    timing_difference: "Timing",
  };

  return (
    <div data-testid="bank-control-room">
      <Panel className="mb-3 overflow-hidden p-0">
        <div className="grid grid-cols-[1fr_280px]">
          <div className="px-5 py-4">
            <div className="flex items-center gap-2">
              <span className="rounded bg-ink px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
                LATEST STATEMENT
              </span>
              <span className="text-[10.5px] text-muted">
                {data.latestImport.fileName ??
                  data.latestImport.format.toUpperCase()}{" "}
                · {toDisplayDate(data.latestImport.periodFrom)}–
                {toDisplayDate(data.latestImport.periodTo)}
              </span>
            </div>
            <div className="mt-3 flex items-end gap-4">
              <p className="font-serif text-[30px] font-semibold leading-none text-ink">
                {completion}%
              </p>
              <div className="min-w-0 flex-1 pb-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
                  <div
                    className="h-full bg-amberbar transition-[width]"
                    style={{ width: `${completion}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10.5px] text-muted">
                  {resolved} reviewed ·{" "}
                  {data.counts.bankOnly + data.counts.bookOnly} need attention
                </p>
              </div>
            </div>
          </div>
          <div
            className={`border-l border-line px-5 py-4 ${openingExplained ? "bg-dr/5" : "bg-cr/5"}`}
          >
            <p className="text-[9.5px] font-semibold tracking-[0.12em] text-muted uppercase">
              Opening balance check
            </p>
            <p
              className={`mt-1 font-serif text-[20px] font-semibold ${openingExplained ? "text-dr" : "text-cr"}`}
            >
              {data.openingDifference === null ? (
                "Not supplied"
              ) : data.openingDifference === 0 ? (
                "Agrees exactly"
              ) : (
                <Money paise={data.openingDifference} signed />
              )}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted">
              {data.openingDifference === null ? (
                "This statement has no running-balance column."
              ) : (
                <>
                  Statement <Money paise={data.statementOpeningBalance ?? 0} />{" "}
                  · books <Money paise={data.bookOpeningBalance} />
                </>
              )}
            </p>
          </div>
        </div>
      </Panel>

      <div className="mb-3 grid grid-cols-5 gap-2">
        {[
          ["Matched", data.counts.matched, "text-dr"],
          ["Bank only", data.counts.bankOnly, "text-cr"],
          ["Book only", data.counts.bookOnly, "text-cr"],
          ["Timing", data.counts.timingDifference, "text-amber"],
          ["Ignored", data.counts.ignored, "text-muted"],
        ].map(([label, value, tone]) => (
          <Panel key={String(label)} className="px-3 py-2">
            <p className="text-[9px] font-semibold tracking-[0.1em] text-muted uppercase">
              {label}
            </p>
            <p className={`num mt-0.5 text-[17px] font-semibold ${tone}`}>
              {value}
            </p>
          </Panel>
        ))}
      </div>

      <div className="grid grid-cols-[1.45fr_1fr] gap-3">
        <Panel className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-line bg-panel2/60 px-4 py-2.5">
            <div>
              <p className="text-[11.5px] font-semibold">Statement evidence</p>
              <p className="text-[9.5px] text-muted">
                Every imported line keeps a durable review state.
              </p>
            </div>
            <span className="font-mono text-[9px] text-muted">
              {data.statementRows.length} LINES
            </span>
          </div>
          <ScrollList maxH="48vh">
            {data.statementRows.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[72px_1fr_100px] gap-3 border-b border-line px-4 py-2.5 last:border-0"
                data-testid={`bank-statement-row-${row.id}`}
              >
                <span className="num text-[10px] text-muted">
                  {toDisplayDate(row.date)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[11.5px] font-medium text-ink">
                    {row.description || "No description"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${statusStyle[row.status]}`}
                    >
                      {statusLabel[row.status]}
                    </span>
                    {row.reference && (
                      <span className="truncate font-mono text-[9px] text-muted">
                        {row.reference}
                      </span>
                    )}
                    {row.status !== "matched" && (
                      <>
                        <button
                          className="text-[9.5px] text-amber hover:underline"
                          onClick={() =>
                            void classify(row, "timing_difference")
                          }
                        >
                          Timing
                        </button>
                        <button
                          className="text-[9.5px] text-muted hover:text-ink"
                          onClick={() => void classify(row, "ignored")}
                        >
                          Ignore
                        </button>
                        {row.status !== "bank_only" && (
                          <button
                            className="text-[9.5px] text-blue hover:underline"
                            onClick={() => void classify(row, "bank_only")}
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className={`num text-right text-[11.5px] font-medium ${row.direction === "deposit" ? "text-dr" : "text-ink"}`}
                >
                  <Money paise={row.amount} />
                </span>
              </div>
            ))}
          </ScrollList>
        </Panel>

        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line bg-panel2/60 px-4 py-2.5">
            <p className="text-[11.5px] font-semibold">
              Book entries not found at bank
            </p>
            <p className="text-[9.5px] text-muted">
              Possible uncleared items or statement-period gaps.
            </p>
          </div>
          {!data.bookOnlyRows.length ? (
            <EmptyState
              title="No book-only entries"
              hint="Every in-period book entry is represented in the statement"
            />
          ) : (
            <ScrollList maxH="48vh">
              {data.bookOnlyRows.map((row) => (
                <button
                  key={row.lineId}
                  className="grid w-full grid-cols-[1fr_90px] gap-3 border-b border-line px-4 py-3 text-left last:border-0 hover:bg-panel2"
                  onClick={() =>
                    nav.go({ name: "voucher-entry", voucherId: row.voucherId })
                  }
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[11.5px] font-medium">
                      {row.particulars || row.number}
                    </span>
                    <span className="mt-0.5 block text-[9.5px] text-muted">
                      {toDisplayDate(row.date)} · {row.number} ·{" "}
                      {row.direction === "deposit" ? "Deposit" : "Withdrawal"}
                    </span>
                  </span>
                  <span className="num text-right text-[11.5px] font-medium">
                    <Money paise={row.amount} />
                  </span>
                </button>
              ))}
            </ScrollList>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** Bank-date editor: proper DateInput (Tally shorthand + inline parse errors) instead of a text prompt. */
function BankDateModal({
  lineId,
  current,
  context,
  onDone,
  onClose,
}: {
  lineId: number;
  current: string | null;
  /** Date context for shorthand parsing (period end). */
  context: string;
  onDone: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const [date, setDate] = useState(current ?? todayISO());
  const [saving, setSaving] = useState(false);

  const set = async (value: string | null): Promise<void> => {
    setSaving(true);
    try {
      await api.bank.setBankDate(lineId, value);
      onDone();
    } catch (err) {
      toast.push("error", (err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Bank date" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field
          label="Cleared at the bank on"
          hint="Shorthand works: 7, 7/4, t (today), y (yesterday)"
        >
          <DateInput
            value={date}
            context={context}
            onChange={setDate}
            testId="input-bank-date"
            className="w-40"
          />
        </Field>
        <div className="flex justify-between gap-2">
          <span>
            {current && (
              <Button
                variant="danger"
                disabled={saving}
                data-testid="btn-banking-clear-bank-date"
                onClick={() => void set(null)}
              >
                Clear bank date
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saving}
              data-testid="btn-banking-set-bank-date"
              onClick={() => void set(date)}
            >
              Set date
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** Dry-run import preview: what will reconcile, what's already done, what stays unmatched —
 *  nothing is written until the user confirms. */
function ImportPreviewModal({
  preview,
  onApply,
  onClose,
}: {
  preview: BankImportResult & {
    csvText: string;
    format: "csv" | "xlsx" | "ofx" | "qif" | "mt940";
    fileName: string | null;
  };
  onApply: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [applying, setApplying] = useState(false);
  return (
    <Modal title="Import preview" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
              Will reconcile
            </p>
            <p className="num mt-1 text-[15px] font-medium">
              {preview.matched}{" "}
              <span className="text-[11px] text-muted">
                of {preview.statementRows} rows
              </span>
            </p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
              Already reconciled
            </p>
            <p className="num mt-1 text-[15px] font-medium">
              {preview.alreadyReconciled}
            </p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
              Unmatched
            </p>
            <p className="num mt-1 text-[15px] font-medium">
              {preview.unmatched.length}
            </p>
          </Panel>
        </div>

        {preview.matches.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Matched book entries
            </p>
            <ScrollList maxH="30vh" className="rounded-md border border-line">
              <table className="ledger-table">
                <tbody data-testid="rows-banking-import-matches">
                  {preview.matches.map((m, i) => (
                    <tr key={i}>
                      <td className="num w-24 text-muted">
                        {toDisplayDate(m.date)}
                      </td>
                      <td className="max-w-80 truncate">{m.description}</td>
                      <td className="w-24 capitalize text-muted">{m.kind}</td>
                      <td className="num r w-32">
                        <Money paise={m.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
          </div>
        )}

        {preview.unmatched.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Unmatched statement lines
            </p>
            <ScrollList maxH="24vh" className="rounded-md border border-line">
              <table className="ledger-table">
                <tbody data-testid="rows-banking-import-unmatched">
                  {preview.unmatched.map((u, i) => (
                    <tr key={i}>
                      <td className="num w-24 text-muted">
                        {toDisplayDate(u.date)}
                      </td>
                      <td className="max-w-80 truncate">{u.description}</td>
                      <td className="w-24 capitalize text-muted">{u.kind}</td>
                      <td className="num r w-32">
                        <Money paise={u.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
            <p className="mt-1 text-[11.5px] text-muted">
              After applying, unmatched lines get ledger suggestions so you can
              create the missing vouchers.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={applying || preview.statementRows === 0}
            data-testid="btn-banking-apply-import"
            onClick={() => {
              setApplying(true);
              onApply();
            }}
          >
            {preview.matched === 0
              ? `Import ${preview.statementRows} for review`
              : `Import & reconcile ${preview.matched} ${preview.matched === 1 ? "entry" : "entries"}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Bank Reconciliation Statement as on a date: book balance → uncredited/unpresented → bank balance. */
function BrsSection({
  ledgerId,
  defaultAsOn,
}: {
  ledgerId: number;
  defaultAsOn: string;
}): React.JSX.Element {
  const toast = useToasts();
  const [asOn, setAsOn] = useState(defaultAsOn);
  const [printing, setPrinting] = useState(false);
  const { data: brs, isLoading } = useQuery({
    queryKey: ["brs", ledgerId, asOn],
    queryFn: () => api.bank.brs(ledgerId, asOn),
  });

  const pdf = async (): Promise<void> => {
    setPrinting(true);
    try {
      const r = await api.bank.brsPdf(ledgerId, asOn);
      toast.push("success", `BRS PDF: ${r.path}`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setPrinting(false);
    }
  };

  const itemTable = (items: BrsItem[], testId: string): React.JSX.Element =>
    items.length === 0 ? (
      <p className="px-4 py-3 text-[12.5px] text-muted">None</p>
    ) : (
      <ScrollList maxH="32vh">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="w-24">Date</th>
              <th className="w-24">Number</th>
              <th>Particulars</th>
              <th className="w-28">Instrument</th>
              <th className="r w-32">Amount</th>
            </tr>
          </thead>
          <tbody data-testid={testId}>
            {items.map((it) => (
              <tr key={it.lineId} data-row-id={it.voucherId}>
                <td className="num text-muted">{toDisplayDate(it.date)}</td>
                <td className="num text-muted">{it.number}</td>
                <td className="max-w-64 truncate">{it.particulars}</td>
                <td className="num text-muted">{it.instrumentNo ?? ""}</td>
                <td className="r">
                  <Money paise={it.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollList>
    );

  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <Field label="As on">
          <DateInput
            value={asOn}
            context={defaultAsOn}
            onChange={setAsOn}
            testId="input-brs-date"
            className="w-40"
          />
        </Field>
        <Button
          disabled={printing || !brs}
          data-testid="btn-banking-brs-pdf"
          onClick={() => void pdf()}
        >
          Export PDF
        </Button>
      </div>

      {isLoading || !brs ? (
        <Panel className="flex items-center justify-center py-10">
          <Spinner />
        </Panel>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Balance as per books
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={brs.bookBalance} signed />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Deposited, not credited
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={brs.uncreditedTotal} />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Issued, not presented
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={brs.unpresentedTotal} />
              </p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Balance as per bank
              </p>
              <p className="num mt-1 text-[15px] font-medium">
                <Money paise={brs.bankBalance} signed />
              </p>
            </Panel>
          </div>

          <Panel className="mb-3">
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Deposits not yet credited by the bank · {brs.uncredited.length}
              </p>
            </div>
            {itemTable(brs.uncredited, "rows-banking-brs-uncredited")}
          </Panel>

          <Panel>
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Cheques issued, not yet presented · {brs.unpresented.length}
              </p>
            </div>
            {itemTable(brs.unpresented, "rows-banking-brs-unpresented")}
          </Panel>
        </>
      )}
    </>
  );
}

/** Post-dated voucher register: everything waiting to mature, with early-mature and edit actions. */
function PdcSection(): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["pdc"],
    queryFn: api.pdc.list,
  });

  const mature = async (id: number, number: string): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Mature now",
      message: `Bring post-dated voucher ${number} into the books now? It will start counting in reports and balances immediately.`,
      confirmLabel: "Mature now",
    });
    if (!proceed) return;
    try {
      await api.pdc.mature(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pdc"] }),
        queryClient.invalidateQueries({ queryKey: ["bankRecon"] }),
        queryClient.invalidateQueries({ queryKey: ["brs"] }),
      ]);
      toast.push("success", `${number} matured into the books`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <Panel scroll={{ maxH: "64vh" }}>
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : !rows?.length ? (
        <EmptyState
          title="No post-dated vouchers"
          hint="Tick “Post-dated” on a payment or receipt to keep it out of the books until its date arrives"
        />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="w-24">Matures</th>
              <th className="w-24">Number</th>
              <th className="w-28">Type</th>
              <th>Party</th>
              <th className="w-28">Instrument</th>
              <th className="r w-32">Amount</th>
              <th className="w-36"></th>
            </tr>
          </thead>
          <tbody data-testid="rows-banking-pdc">
            {rows.map((r) => (
              <tr key={r.id} data-row-id={r.id} className="hover:bg-panel2">
                <td className="num text-muted">{toDisplayDate(r.date)}</td>
                <td className="num">{r.number}</td>
                <td className="text-muted">{r.voucherTypeName}</td>
                <td className="max-w-52 truncate">{r.partyName ?? ""}</td>
                <td className="num text-muted">{r.instrumentNo ?? ""}</td>
                <td className="r">
                  <Money paise={r.amount} />
                </td>
                <td className="r">
                  <button
                    className="mr-3 text-[12px] text-blue hover:underline"
                    data-testid="btn-banking-pdc-mature"
                    onClick={() => void mature(r.id, r.number)}
                  >
                    Mature now
                  </button>
                  <button
                    className="text-[12px] text-muted hover:text-ink"
                    data-testid="btn-banking-pdc-edit"
                    onClick={() =>
                      nav.go({ name: "voucher-entry", voucherId: r.id })
                    }
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function BankRulesModal({
  onClose,
  prefill,
}: {
  onClose: () => void;
  prefill: { pattern: string; kind: "payment" | "receipt" } | null;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: rules } = useQuery({
    queryKey: ["bankRules"],
    queryFn: api.bankRules.list,
  });
  const { data: bankAccounts } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pattern, setPattern] = useState(prefill?.pattern ?? "");
  const [ledgerId, setLedgerId] = useState<number | null>(null);
  const [kind, setKind] = useState<"payment" | "receipt">(
    prefill?.kind ?? "payment",
  );
  const [matchField, setMatchField] = useState<"description" | "reference">(
    "description",
  );
  const [minRupees, setMinRupees] = useState("");
  const [maxRupees, setMaxRupees] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [source, setSource] = useState<"manual" | "learned">(
    prefill ? "learned" : "manual",
  );
  const [bankLedgerId, setBankLedgerId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [narrationTemplate, setNarrationTemplate] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const invalidate = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: ["bankRules"] })
      .then(() => undefined);

  const resetForm = (): void => {
    setEditingId(null);
    setPattern("");
    setLedgerId(null);
    setKind("payment");
    setMatchField("description");
    setMinRupees("");
    setMaxRupees("");
    setAutoApply(false);
    setSource("manual");
    setBankLedgerId(null);
    setDateFrom("");
    setDateTo("");
    setNarrationTemplate("");
    setActive(true);
  };

  const edit = (r: BankRuleRecord): void => {
    setEditingId(r.id);
    setPattern(r.pattern);
    setLedgerId(r.ledgerId);
    setKind(r.kind);
    setMatchField(r.matchField === "reference" ? "reference" : "description");
    setMinRupees(r.minAmount == null ? "" : String(r.minAmount / 100));
    setMaxRupees(r.maxAmount == null ? "" : String(r.maxAmount / 100));
    setAutoApply(r.autoApply);
    setSource(r.source);
    setBankLedgerId(r.bankLedgerId);
    setDateFrom(r.dateFrom ?? "");
    setDateTo(r.dateTo ?? "");
    setNarrationTemplate(r.narrationTemplate ?? "");
    setActive(r.active);
  };

  const save = async (): Promise<void> => {
    if (pattern.trim().length < 2)
      return void toast.push("error", "Pattern needs at least 2 characters");
    if (ledgerId == null) return void toast.push("error", "Pick a ledger");
    setSaving(true);
    try {
      await api.bankRules.save(
        {
          pattern: pattern.trim(),
          ledgerId,
          kind,
          matchField,
          minAmount:
            minRupees === "" ? null : Math.round(Number(minRupees) * 100),
          maxAmount:
            maxRupees === "" ? null : Math.round(Number(maxRupees) * 100),
          autoApply,
          active,
          source,
          bankLedgerId,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          narrationTemplate: narrationTemplate.trim() || null,
        },
        editingId ?? undefined,
      );
      await invalidate();
      toast.push("success", editingId ? "Rule updated" : "Rule created");
      resetForm();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: BankRuleRecord): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Delete rule",
      message: `Delete rule "${r.pattern}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!proceed) return;
    try {
      await api.bankRules.remove(r.id);
      await invalidate();
      if (editingId === r.id) resetForm();
      toast.push("success", "Rule deleted");
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const toggleActive = async (r: BankRuleRecord): Promise<void> => {
    try {
      await api.bankRules.save(
        {
          pattern: r.pattern,
          ledgerId: r.ledgerId,
          kind: r.kind,
          matchField:
            r.matchField === "reference" ? "reference" : "description",
          minAmount: r.minAmount,
          maxAmount: r.maxAmount,
          autoApply: r.autoApply,
          active: !r.active,
          source: r.source,
          bankLedgerId: r.bankLedgerId,
          dateFrom: r.dateFrom,
          dateTo: r.dateTo,
          narrationTemplate: r.narrationTemplate,
        },
        r.id,
      );
      await invalidate();
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const rollback = async (r: BankRuleRecord): Promise<void> => {
    try {
      await api.bankRules.rollback(r.id);
      await invalidate();
      toast.push("success", `Rolled back “${r.pattern}”`);
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <Modal title="Bank rules" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {!rules?.length ? (
          <EmptyState
            title="No bank rules yet"
            hint={
              'Add one below, or use "Remember as rule" on an unmatched statement line'
            }
          />
        ) : (
          <ScrollList maxH="40vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Ledger</th>
                  <th className="w-32">Conditions</th>
                  <th className="w-28">Confidence</th>
                  <th className="w-20">Status</th>
                  <th className="w-44"></th>
                </tr>
              </thead>
              <tbody data-testid="rows-banking-rules">
                {rules.map((r) => (
                  <tr key={r.id} data-row-id={r.id} className="hover:bg-panel2">
                    <td>
                      <span className="block font-medium">{r.pattern}</span>
                      <span className="text-[9px] uppercase tracking-[0.08em] text-muted">
                        {r.source}
                      </span>
                    </td>
                    <td className="text-muted">{r.ledgerName}</td>
                    <td className="text-[10px] text-muted">
                      <span className="capitalize text-ink">{r.kind}</span> ·{" "}
                      {r.matchField}
                      <br />
                      {r.minAmount == null && r.maxAmount == null
                        ? "Any amount"
                        : `${r.minAmount == null ? "₹0" : `₹${r.minAmount / 100}`}–${r.maxAmount == null ? "∞" : `₹${r.maxAmount / 100}`}`}
                      <br />
                      {r.bankLedgerName ?? "All bank accounts"}
                      {r.dateFrom || r.dateTo
                        ? ` · ${r.dateFrom ?? "Any"}–${r.dateTo ?? "Any"}`
                        : ""}
                    </td>
                    <td>
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-panel2">
                        <div
                          className="h-full bg-amberbar"
                          style={{ width: `${r.confidenceBp / 100}%` }}
                        />
                      </div>
                      <span className="mt-1 block font-mono text-[9px] text-muted">
                        {Math.round(r.confidenceBp / 100)}% · {r.reviewedHits}{" "}
                        reviewed
                      </span>
                    </td>
                    <td>
                      <button
                        className="text-[12px] text-blue hover:underline"
                        onClick={() => void toggleActive(r)}
                      >
                        {r.rolledBackAt
                          ? "Rolled back"
                          : r.active
                            ? "Active"
                            : "Paused"}
                      </button>
                    </td>
                    <td className="r">
                      <button
                        className="mr-3 text-[12px] text-blue hover:underline"
                        onClick={() => edit(r)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[12px] text-cr hover:underline"
                        onClick={() => void remove(r)}
                      >
                        Delete
                      </button>
                      {r.source === "learned" && r.active && (
                        <button
                          className="ml-3 text-[12px] text-amber hover:underline"
                          onClick={() => void rollback(r)}
                        >
                          Rollback
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollList>
        )}

        <div className="border-t border-line pt-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {editingId ? "Edit rule" : "Add rule"}
          </p>
          <div className="grid grid-cols-6 gap-3">
            <Field label="Pattern">
              <TextInput
                autoFocus
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="e.g. ACME SUPPLIES"
              />
            </Field>
            <Field label="Ledger">
              <LedgerPicker
                value={ledgerId}
                onPick={setLedgerId}
                placeholder="Ledger"
              />
            </Field>
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as "payment" | "receipt")
                }
              >
                <option value="payment">Payment (withdrawal)</option>
                <option value="receipt">Receipt (deposit)</option>
              </Select>
            </Field>
            <Field label="Match in">
              <Select
                value={matchField}
                onChange={(e) =>
                  setMatchField(e.target.value as "description" | "reference")
                }
              >
                <option value="description">Description</option>
                <option value="reference">Reference / UTR</option>
              </Select>
            </Field>
            <Field label="Minimum ₹">
              <TextInput
                type="number"
                min="0"
                value={minRupees}
                onChange={(e) => setMinRupees(e.target.value)}
                placeholder="Any"
                className="num"
              />
            </Field>
            <Field label="Maximum ₹">
              <TextInput
                type="number"
                min="0"
                value={maxRupees}
                onChange={(e) => setMaxRupees(e.target.value)}
                placeholder="Any"
                className="num"
              />
            </Field>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Active
              </label>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[190px_150px_150px_1fr] gap-3 rounded-md border border-line bg-panel2/35 p-3">
            <Field label="Bank account scope">
              <Select
                value={bankLedgerId ?? ""}
                onChange={(e) =>
                  setBankLedgerId(
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              >
                <option value="">All bank accounts</option>
                {(bankAccounts ?? []).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Effective from">
              <DateInput
                value={dateFrom}
                context={todayISO()}
                onChange={setDateFrom}
              />
            </Field>
            <Field label="Effective to">
              <DateInput
                value={dateTo}
                context={todayISO()}
                onChange={setDateTo}
              />
            </Field>
            <Field
              label="Narration template"
              hint="Use {description} and {reference}"
            >
              <TextInput
                value={narrationTemplate}
                onChange={(e) => setNarrationTemplate(e.target.value)}
                placeholder="{description}"
              />
            </Field>
          </div>
          <label className="mt-3 flex items-start gap-2 rounded-md border border-line bg-panel2/50 px-3 py-2 text-[11px] text-muted">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={autoApply}
              onChange={(e) => setAutoApply(e.target.checked)}
            />
            <span>
              <b className="font-medium text-ink">Auto-create exact matches</b>
              <br />
              Use only for high-confidence, predictable entries. Every created
              voucher remains audited.
            </span>
          </label>
          <div className="mt-3 flex justify-end gap-2">
            {editingId && <Button onClick={resetForm}>Cancel edit</Button>}
            <Button
              variant="primary"
              disabled={saving}
              data-testid="btn-banking-save-rule"
              onClick={() => void save()}
            >
              {editingId ? "Save changes" : "Add rule"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** mm-offset number field — ui-kit TextInput (no rupee/date parsing needed here). */
function MmField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}): React.JSX.Element {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        step="0.5"
        className="num text-right"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  );
}

function ChequeSetupModal({
  bankLedgerId,
  bankLedgerName,
  onClose,
}: {
  bankLedgerId: number;
  bankLedgerName: string;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const {
    data: saved,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: ["chequeConfig", bankLedgerId],
    queryFn: () => api.cheque.config.get(bankLedgerId),
  });
  const [form, setForm] = useState<ChequeConfig | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChequeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (saved && !form) {
      setForm(saved);
      setSavedSnapshot(saved);
    }
  }, [saved, form]);

  const dirty =
    form != null &&
    savedSnapshot != null &&
    JSON.stringify(form) !== JSON.stringify(savedSnapshot);
  useUnsavedGuard(dirty);

  const save = async (): Promise<void> => {
    if (!form) return;
    setSaving(true);
    try {
      await api.cheque.config.set(bankLedgerId, form);
      setSavedSnapshot(form);
      toast.push("success", "Cheque layout saved");
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const printGrid = async (): Promise<void> => {
    if (!form) return;
    setPrinting(true);
    try {
      // Save first so the printed grid reflects any unsaved edits in the form.
      await api.cheque.config.set(bankLedgerId, form);
      setSavedSnapshot(form);
      const r = await api.cheque.testGrid(bankLedgerId);
      toast.push("success", `Test grid: ${r.path}`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Modal
      title={`Cheque setup — ${bankLedgerName}`}
      onClose={onClose}
      wide
      dirty={dirty}
    >
      {!form ? (
        loadError ? (
          // A failed config load used to strand the modal on "Loading…" forever — surface the
          // error and offer a retry instead.
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-cr">
              Couldn’t load the cheque layout: {(loadError as Error).message}
            </p>
            <Button
              data-testid="btn-banking-cheque-retry"
              onClick={() => void refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
            <Spinner /> Loading cheque layout…
          </div>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-3">
            <MmField
              label="Cheque width (mm)"
              value={form.widthMm}
              onChange={(n) => setForm({ ...form, widthMm: n })}
            />
            <MmField
              label="Cheque height (mm)"
              value={form.heightMm}
              onChange={(n) => setForm({ ...form, heightMm: n })}
            />
            <div className="col-span-2 flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={form.acPayee}
                  onChange={(e) =>
                    setForm({ ...form, acPayee: e.target.checked })
                  }
                />
                Print &quot;A/C Payee only&quot; stamp
              </label>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Date boxes
            </p>
            <div className="grid grid-cols-4 gap-3">
              <MmField
                label="X (mm)"
                value={form.date.xMm}
                onChange={(n) =>
                  setForm({ ...form, date: { ...form.date, xMm: n } })
                }
              />
              <MmField
                label="Y (mm)"
                value={form.date.yMm}
                onChange={(n) =>
                  setForm({ ...form, date: { ...form.date, yMm: n } })
                }
              />
              <MmField
                label="Digit gap (mm)"
                value={form.date.charGapMm}
                onChange={(n) =>
                  setForm({ ...form, date: { ...form.date, charGapMm: n } })
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Payee
            </p>
            <div className="grid grid-cols-4 gap-3">
              <MmField
                label="X (mm)"
                value={form.payee.xMm}
                onChange={(n) =>
                  setForm({ ...form, payee: { ...form.payee, xMm: n } })
                }
              />
              <MmField
                label="Y (mm)"
                value={form.payee.yMm}
                onChange={(n) =>
                  setForm({ ...form, payee: { ...form.payee, yMm: n } })
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Amount in words
            </p>
            <div className="grid grid-cols-4 gap-3">
              <MmField
                label="X (mm)"
                value={form.words.xMm}
                onChange={(n) =>
                  setForm({ ...form, words: { ...form.words, xMm: n } })
                }
              />
              <MmField
                label="Y (mm)"
                value={form.words.yMm}
                onChange={(n) =>
                  setForm({ ...form, words: { ...form.words, yMm: n } })
                }
              />
              <MmField
                label="Width (mm)"
                value={form.words.wMm}
                onChange={(n) =>
                  setForm({ ...form, words: { ...form.words, wMm: n } })
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Amount in figures
            </p>
            <div className="grid grid-cols-4 gap-3">
              <MmField
                label="X (mm)"
                value={form.figures.xMm}
                onChange={(n) =>
                  setForm({ ...form, figures: { ...form.figures, xMm: n } })
                }
              />
              <MmField
                label="Y (mm)"
                value={form.figures.yMm}
                onChange={(n) =>
                  setForm({ ...form, figures: { ...form.figures, yMm: n } })
                }
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button
              disabled={printing}
              data-testid="btn-banking-cheque-test-grid"
              onClick={() => void printGrid()}
            >
              Print test grid
            </Button>
            <Button
              variant="primary"
              disabled={saving}
              data-testid="btn-banking-cheque-save"
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
