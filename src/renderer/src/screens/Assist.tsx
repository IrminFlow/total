import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  FileImage,
  MagnifyingGlass,
  MagicWand,
  Receipt,
  SlidersHorizontal,
  Sparkle,
  ThumbsDown,
  ThumbsUp,
  Warning,
} from "@phosphor-icons/react";
import { formatPaise } from "@shared/money";
import type { AiTaskRoute } from "@shared/assistiveAutomation";
import type { AiOperatorAction, AiOperatorActionResult, AiOperatorPlan } from "@shared/aiOperator";
import { api } from "../lib/client";
import { SCREENS } from "../lib/screens";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  EmptyState,
  Field,
  Money,
  Panel,
  SectionTitle,
  Select,
  TextInput,
} from "../components/ui";
import { inputCls } from "../components/inputStyles";

type Tab = "operator" | "documents" | "ledgers" | "search" | "writing" | "routing";

const tabs: { id: Tab; label: string; eyebrow: string }[] = [
  { id: "operator", label: "Operator", eyebrow: "Act" },
  { id: "documents", label: "Document inbox", eyebrow: "Capture" },
  { id: "ledgers", label: "Ledger suggestions", eyebrow: "Classify" },
  { id: "search", label: "Book search", eyebrow: "Find" },
  { id: "writing", label: "Writing & variance", eyebrow: "Explain" },
  { id: "routing", label: "Task routing", eyebrow: "Control" },
];

export function AssistScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("documents");
  return (
    <div className="mx-auto max-w-7xl" data-testid="assist-screen">
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <Check size={13} weight="bold" className="text-dr" /> Human approval
            required
          </span>
        }
      >
        Assist
      </SectionTitle>

      <div className="mb-5 grid gap-3 lg:grid-cols-[1.45fr_0.55fr]">
        <Panel className="relative min-h-[158px] overflow-hidden !border-ink !bg-ink px-6 py-5 text-panel">
          <div className="absolute -right-12 -top-24 size-64 rounded-full border border-panel/10" />
          <div className="absolute right-11 top-10 size-20 rounded-full border border-amberbar/25" />
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.2em] text-panel/45">
            AI assistance
          </p>
          <h3 className="mt-3 max-w-xl font-serif text-[30px] font-semibold leading-[1.05] tracking-[-0.025em]">
            Faster work. Every claim traceable to your books.
          </h3>
          <p className="mt-3 max-w-2xl text-[11.5px] leading-5 text-panel/55">
            Capture documents, find evidence and prepare editable drafts. Assist
            can propose; only you can post, send or approve.
          </p>
        </Panel>
        <Panel className="flex flex-col justify-between px-5 py-4">
          <div>
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted">
              AI limits
            </p>
            <p className="mt-2 text-[12px] leading-5 text-ink">
              No generated SQL. No silent postings. No uncited financial
              conclusions.
            </p>
          </div>
          <div className="mt-4 border-t border-line pt-3 text-[10.5px] text-muted">
            Uses your selected provider and task-specific model routes.
          </div>
        </Panel>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-6">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`assist-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`min-h-[58px] bg-panel px-3 py-2 text-left transition-colors ${
              tab === item.id
                ? "border-t-2 border-amberbar !bg-panel2"
                : "border-t-2 border-transparent hover:bg-panel2"
            }`}
          >
            <span className="block text-[8.5px] font-semibold uppercase tracking-[0.14em] text-muted">
              {item.eyebrow}
            </span>
            <span className="mt-0.5 block text-[11.5px] font-medium text-ink">
              {item.label}
            </span>
          </button>
        ))}
      </div>

      {tab === "operator" && <OperatorWorkspace />}
      {tab === "documents" && <DocumentInbox />}
      {tab === "ledgers" && <LedgerSuggestions />}
      {tab === "search" && <BookSearch />}
      {tab === "writing" && <WritingWorkspace />}
      {tab === "routing" && <TaskRouting />}
    </div>
  );
}

function OperatorWorkspace(): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<AiOperatorPlan | null>(null);
  const [results, setResults] = useState<Record<number, AiOperatorActionResult>>({});
  const config = useQuery({ queryKey: ["aiOperatorConfig"], queryFn: api.ai.operatorConfig });
  const planMutation = useMutation({
    mutationFn: api.ai.operatorPlan,
    onSuccess: (next) => { setPlan(next); setResults({}); },
    onError: (error) => toast.push("error", error instanceof Error ? error.message : String(error)),
  });
  const execute = async (action: AiOperatorAction, index: number, approved = false): Promise<void> => {
    try {
      const result = await api.ai.operatorExecute(action, approved);
      setResults((current) => ({ ...current, [index]: result }));
      if (action.kind === "navigate" && result.status === "completed") {
        const query = action.screen.toLowerCase().replace(/\s+/g, "-");
        const target = SCREENS.find((screen) => screen.name === query || screen.title.toLowerCase() === action.screen.toLowerCase())?.screen;
        if (target) nav.go(target);
        else toast.push("warning", `No screen named ${action.screen} was found`);
      }
      if (result.status === "proposal_created") toast.push("success", "Proposal added to Agent access for review");
    } catch (error) {
      toast.push("error", error instanceof Error ? error.message : String(error));
    }
  };
  if (!config.data?.enabled) return (
    <Panel className="p-6"><EmptyState title="AI Operator is off" hint="Enable it in Settings → AI. The rest of Total remains fully available without AI." /></Panel>
  );
  return (
    <div className="grid gap-3 lg:grid-cols-[0.7fr_1.3fr]">
      <Panel className="p-4">
        <p className="text-[12.5px] font-semibold">Give Total a job</p>
        <p className="mt-1 text-[10.5px] leading-4 text-muted">It can navigate, search, prepare voucher proposals and work inside approved folders. You see the plan before anything runs.</p>
        <textarea className={`${inputCls} mt-4 min-h-36 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)}
          placeholder="Find last month's overdue customers, prepare a receipt draft, or update a file in my approved workspace…" />
        <Button className="mt-3 w-full" variant="primary" disabled={!prompt.trim() || planMutation.isPending}
          onClick={() => planMutation.mutate(prompt)}>{planMutation.isPending ? "Planning…" : "Build action plan"}</Button>
        <div className="mt-4 rounded-md border border-line bg-panel2 p-3 text-[10px] text-muted">
          {config.data.approvalMode === "every_change" ? "Every file change asks first." : "Approved-folder file changes may run directly."} Accounting always produces a reviewable proposal.
        </div>
      </Panel>
      <Panel className="overflow-hidden">
        <div className="border-b border-line px-4 py-3"><p className="text-[12.5px] font-semibold">Action plan</p><p className="mt-0.5 text-[10px] text-muted">{plan?.summary ?? "Nothing planned yet."}</p></div>
        {!plan?.actions.length ? <div className="p-6"><EmptyState title="No actions" hint="Describe an outcome and review the generated plan here." /></div> : (
          <div className="divide-y divide-line">
            {plan.actions.map((action, index) => {
              const result = results[index];
              return <div key={`${action.kind}-${index}`} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 rounded bg-amberbar/15 px-2 py-0.5 text-[9px] font-semibold uppercase text-ink">{action.kind.replace("_", " ")}</span>
                <div className="min-w-0 flex-1"><p className="text-[11.5px] text-ink">{action.reason}</p>{"path" in action && <code className="mt-1 block truncate text-[9.5px] text-muted">{action.path}</code>}{result && <p className={`mt-1 text-[10px] ${result.status === "approval_required" ? "text-amber" : "text-dr"}`}>{result.message}</p>}</div>
                {result?.status === "approval_required" ? <Button variant="primary" onClick={() => void execute(action, index, true)}>Approve</Button>
                  : !result && <Button onClick={() => void execute(action, index)}>Run</Button>}
              </div>;
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function DocumentInbox(): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const documents = useQuery({
    queryKey: ["aiDocuments"],
    queryFn: api.ai.documents,
  });
  const capture = useMutation({
    mutationFn: api.ai.captureDocument,
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: ["aiDocuments"] });
      if (row)
        toast.push(
          row.status === "duplicate" ? "warning" : "success",
          row.status === "duplicate"
            ? "Possible duplicate added for review"
            : "Document extracted and ready for review",
        );
    },
    onError: (error) =>
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      ),
  });
  const review = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: number;
      status: "approved" | "dismissed";
    }) => api.ai.reviewDocument(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiDocuments"] }),
    onError: (error) =>
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      ),
  });
  return (
    <div className="grid gap-3 lg:grid-cols-[0.52fr_1.48fr]">
      <Panel className="p-4">
        <p className="text-[12.5px] font-semibold">Add to review inbox</p>
        <p className="mt-1 text-[10.5px] leading-4 text-muted">
          Images stay linked to their source hash. Similar document numbers and
          totals are flagged before review.
        </p>
        <div className="mt-4 grid gap-2">
          <Button
            data-testid="assist-capture-invoice"
            variant="primary"
            disabled={capture.isPending}
            onClick={() => capture.mutate("supplier_invoice")}
            className="flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              <FileImage size={16} /> Supplier invoice
            </span>
            <ArrowRight size={14} />
          </Button>
          <Button
            data-testid="assist-capture-receipt"
            disabled={capture.isPending}
            onClick={() => capture.mutate("receipt")}
            className="flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              <Receipt size={16} /> Expense receipt
            </span>
            <ArrowRight size={14} />
          </Button>
        </div>
        <div className="mt-5 rounded-md border border-line bg-panel2 p-3 text-[10px] leading-4 text-muted">
          Extraction reads supplier, GSTIN, date, totals and line items. Nothing
          is booked until the result is reviewed and converted into a voucher
          draft.
        </div>
      </Panel>
      <Panel className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="text-[12.5px] font-semibold">Review queue</p>
            <p className="text-[9.5px] text-muted">
              {documents.data?.filter(
                (row) => row.status === "review" || row.status === "duplicate",
              ).length ?? 0}{" "}
              waiting
            </p>
          </div>
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
            Newest first
          </span>
        </div>
        {!documents.data?.length ? (
          <EmptyState
            icon={<FileImage size={30} />}
            title="The document inbox is clear"
            hint="Capture an invoice or receipt to begin."
          />
        ) : (
          <div className="divide-y divide-line">
            {documents.data.map((row) => (
              <div
                key={row.id}
                className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]"
                data-testid={`assist-document-${row.id}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[12px] font-semibold">
                      {row.extracted.supplierOrMerchant ||
                        "Unidentified document"}
                    </p>
                    <Status status={row.status} />
                  </div>
                  <p className="mt-1 text-[10px] text-muted">
                    {row.documentKind === "supplier_invoice"
                      ? "Supplier invoice"
                      : "Receipt"}{" "}
                    · {row.extracted.documentNumber || "No document number"} ·{" "}
                    {row.extracted.date || "Date not read"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
                    <span>
                      Total{" "}
                      <strong className="num font-medium text-ink">
                        {row.extracted.total == null
                          ? "Not available"
                          : `₹${formatPaise(row.extracted.total)}`}
                      </strong>
                    </span>
                    <span>
                      Confidence{" "}
                      <strong className="num font-medium text-ink">
                        {(row.extracted.confidenceBps / 100).toFixed(0)}%
                      </strong>
                    </span>
                    <span>
                      {row.extracted.items.length} line
                      {row.extracted.items.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {row.duplicateOfId && (
                    <p className="mt-2 flex items-center gap-1 text-[9.5px] text-cr">
                      <Warning size={12} /> Matches inbox item #
                      {row.duplicateOfId}
                    </p>
                  )}
                </div>
                {(row.status === "review" || row.status === "duplicate") && (
                  <div className="flex items-center gap-1.5 self-center">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        review.mutate({ id: row.id, status: "dismissed" })
                      }
                    >
                      Dismiss
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() =>
                        review.mutate({ id: row.id, status: "approved" })
                      }
                    >
                      Approve
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Status({ status }: { status: string }): React.JSX.Element {
  const tone =
    status === "approved"
      ? "bg-dr/10 text-dr"
      : status === "duplicate" || status === "failed"
        ? "bg-cr/10 text-cr"
        : "bg-amberbar/15 text-ink";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.09em] ${tone}`}
    >
      {status}
    </span>
  );
}

function LedgerSuggestions(): React.JSX.Element {
  const [kind, setKind] = useState("purchase");
  const [query, setQuery] = useState("");
  const [partyLedgerId, setPartyLedgerId] = useState<number | null>(null);
  const [contextKey] = useState(() => `assist:${Date.now()}`);
  const toast = useToasts();
  const qc = useQueryClient();
  const ledgers = useQuery({
    queryKey: ["ledgers"],
    queryFn: api.ledgers.list,
  });
  const suggestions = useQuery({
    queryKey: [
      "evidenceLedgerSuggestions",
      kind,
      query,
      contextKey,
      partyLedgerId,
    ],
    queryFn: () =>
      api.ai.ledgerSuggestions(kind, query, contextKey, partyLedgerId),
    enabled: query.trim().length > 0,
  });
  const feedback = async (
    ledgerId: number,
    outcome: "accepted" | "rejected",
  ): Promise<void> => {
    await api.ai.ledgerFeedback(contextKey, ledgerId, outcome);
    await qc.invalidateQueries({ queryKey: ["evidenceLedgerSuggestions"] });
    toast.push(
      "success",
      outcome === "accepted"
        ? "Suggestion accepted locally"
        : "Suggestion moved down locally",
    );
  };
  return (
    <div className="grid gap-3 lg:grid-cols-[0.55fr_1.45fr]">
      <Panel className="p-4">
        <p className="text-[12.5px] font-semibold">Describe the posting</p>
        <p className="mt-1 text-[10.5px] leading-4 text-muted">
          Suggestions combine party history, matching narration, prior voucher
          use and feedback stored only in this company.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Voucher context">
            <Select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="purchase">Purchase</option>
              <option value="payment">Payment</option>
              <option value="receipt">Receipt</option>
              <option value="journal">Journal</option>
            </Select>
          </Field>
          <Field label="Party context (optional)">
            <Select
              data-testid="assist-ledger-party"
              value={partyLedgerId ?? ""}
              onChange={(event) =>
                setPartyLedgerId(Number(event.target.value) || null)
              }
            >
              <option value="">No party selected</option>
              {ledgers.data?.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What is this for?">
            <TextInput
              data-testid="assist-ledger-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Courier, rent, hosting…"
            />
          </Field>
        </div>
      </Panel>
      <Panel className="p-0">
        <div className="border-b border-line px-4 py-3">
          <p className="text-[12.5px] font-semibold">Evidence-ranked ledgers</p>
          <p className="text-[9.5px] text-muted">
            Feedback changes future ranking; it never changes posted entries.
          </p>
        </div>
        {!query.trim() ? (
          <EmptyState
            icon={<MagicWand size={30} />}
            title="Describe a transaction"
            hint="Matching ledgers and their evidence will appear here."
          />
        ) : !suggestions.data?.length ? (
          <EmptyState
            title="No evidence-backed match yet"
            hint="Try a shorter business description."
          />
        ) : (
          <div className="divide-y divide-line">
            {suggestions.data.map((row, index) => (
              <div
                key={row.ledgerId}
                className="grid gap-3 px-4 py-3 md:grid-cols-[28px_1fr_auto]"
              >
                <div className="num mt-0.5 text-[10px] text-muted">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div>
                  <p className="text-[12px] font-semibold">{row.name}</p>
                  <p className="text-[9.5px] text-muted">
                    {row.groupName} · score {row.score}
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9.5px] text-muted">
                    {row.evidence.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center gap-1 self-center">
                  <Button
                    aria-label={`Reject ${row.name}`}
                    variant="ghost"
                    onClick={() => void feedback(row.ledgerId, "rejected")}
                  >
                    <ThumbsDown size={14} />
                  </Button>
                  <Button
                    aria-label={`Accept ${row.name}`}
                    variant="primary"
                    onClick={() => void feedback(row.ledgerId, "accepted")}
                  >
                    <ThumbsUp size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function BookSearch(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const nav = useNav();
  const results = useQuery({
    queryKey: ["naturalSearch", query],
    queryFn: () => api.search.natural(query),
    enabled: query.trim().length > 1,
  });
  const openResult = (row: { kind: string; id: number }): void => {
    if (row.kind === "voucher")
      nav.go({ name: "voucher-entry", voucherId: row.id });
    else if (row.kind === "ledger")
      nav.go({ name: "ledger-statement", ledgerId: row.id });
    else if (row.kind === "report") {
      const screens = [
        "",
        "trial-balance",
        "profit-loss",
        "balance-sheet",
        "cash-flow",
        "registers",
        "registers",
        "gstr1",
        "gstr3b",
        "outstandings",
        "stock-summary",
      ] as const;
      const name = screens[row.id];
      if (name) nav.go({ name } as Parameters<typeof nav.go>[0]);
    }
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="border-b border-line bg-panel2 px-5 py-5">
        <p className="text-[9.5px] font-semibold uppercase tracking-[0.15em] text-muted">
          Constrained book search
        </p>
        <div className="relative mt-2 max-w-3xl">
          <MagnifyingGlass
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            size={17}
          />
          <TextInput
            autoFocus
            data-testid="assist-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="!py-2.5 !pl-10 text-[13px]"
            placeholder="Try ‘voucher 12500’, a party name, item, or report…"
          />
        </div>
        <p className="mt-2 text-[9.5px] text-muted">
          Searches approved indexes and exact amounts only. It cannot generate
          or execute database queries.
        </p>
      </div>
      {!query.trim() ? (
        <EmptyState
          icon={<MagnifyingGlass size={30} />}
          title="Search your books in plain language"
          hint="Every result includes a stable Total citation."
        />
      ) : !results.data?.length ? (
        <EmptyState
          title="No indexed result"
          hint="Try an exact amount, voucher number, ledger or item name."
        />
      ) : (
        <div className="divide-y divide-line">
          {results.data.map((row) => (
            <button
              key={`${row.kind}:${row.id}`}
              type="button"
              onClick={() => openResult(row)}
              className="grid w-full grid-cols-[80px_1fr_auto] items-center gap-3 px-5 py-3 text-left hover:bg-panel2"
            >
              <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-muted">
                {row.kind}
              </span>
              <span>
                <span className="block text-[12px] font-semibold">
                  {row.label}
                </span>
                <span className="mt-0.5 block text-[9.5px] text-muted">
                  {row.sub}
                </span>
              </span>
              <span className="num text-[9px] text-muted">{row.citation}</span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function WritingWorkspace(): React.JSX.Element {
  const { from, to } = useSession();
  const [mode, setMode] = useState<"variance" | "collection">("variance");
  const [ledgerId, setLedgerId] = useState<number | null>(null);
  const [billVoucherIds, setBillVoucherIds] = useState<number[]>([]);
  const [draft, setDraft] = useState("");
  const [citations, setCitations] = useState<string[]>([]);
  const toast = useToasts();
  const collectionQueue = useQuery({
    queryKey: ["collections", to],
    queryFn: () => api.collections.queue(to),
  });
  const selectedCustomer = collectionQueue.data?.find(
    (row) => row.ledgerId === ledgerId,
  );
  const prior = useMemo(() => {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const priorTo = new Date(start.getTime() - 86400000);
    const priorFrom = new Date(priorTo.getTime() - (days - 1) * 86400000);
    return {
      from: priorFrom.toISOString().slice(0, 10),
      to: priorTo.toISOString().slice(0, 10),
    };
  }, [from, to]);
  const generate = async (): Promise<void> => {
    try {
      if (mode === "variance") {
        const result = await api.ai.varianceNarrative(
          from,
          to,
          prior.from,
          prior.to,
        );
        setDraft(result.text);
        setCitations(result.citations);
      } else {
        if (!ledgerId) throw new Error("Choose a customer");
        if (billVoucherIds.length === 0)
          throw new Error("Select at least one invoice");
        const result = await api.ai.collectionMessage(
          ledgerId,
          to,
          "polite",
          billVoucherIds,
        );
        setDraft(result.message);
        setCitations(result.citations);
      }
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <div className="grid gap-3 lg:grid-cols-[0.5fr_1.5fr]">
      <Panel className="p-4">
        <p className="text-[12.5px] font-semibold">Prepare a grounded draft</p>
        <div className="mt-4 space-y-3">
          <Field label="Draft type">
            <Select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as typeof mode);
                setDraft("");
                setCitations([]);
                setLedgerId(null);
                setBillVoucherIds([]);
              }}
            >
              <option value="variance">Period variance narrative</option>
              <option value="collection">Customer reminder</option>
            </Select>
          </Field>
          {mode === "collection" && (
            <>
              <Field label="Customer">
                <Select
                  data-testid="assist-writing-customer"
                  value={ledgerId ?? ""}
                  onChange={(event) => {
                    const id = Number(event.target.value) || null;
                    setLedgerId(id);
                    const customer = collectionQueue.data?.find(
                      (row) => row.ledgerId === id,
                    );
                    setBillVoucherIds(
                      customer?.bills.flatMap((bill) =>
                        bill.voucherId ? [bill.voucherId] : [],
                      ) ?? [],
                    );
                  }}
                >
                  <option value="">Choose customer…</option>
                  {collectionQueue.data?.map((row) => (
                    <option key={row.ledgerId} value={row.ledgerId}>
                      {row.name} · ₹{formatPaise(row.pending)}
                    </option>
                  ))}
                </Select>
              </Field>
              {selectedCustomer && (
                <div className="rounded-md border border-line bg-panel2 p-2.5">
                  <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
                    Include invoices
                  </p>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {selectedCustomer.bills.map((bill, index) => {
                      const id = bill.voucherId;
                      return (
                        <label
                          key={`${bill.number}-${index}`}
                          className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[10px] hover:bg-panel"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              disabled={!id}
                              checked={id ? billVoucherIds.includes(id) : false}
                              onChange={(event) => {
                                if (!id) return;
                                setBillVoucherIds((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, id])]
                                    : current.filter((item) => item !== id),
                                );
                              }}
                            />
                            <span className="truncate">{bill.number}</span>
                          </span>
                          <Money paise={bill.pending} />
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          <Button
            data-testid="assist-generate-writing"
            variant="primary"
            className="w-full"
            onClick={() => void generate()}
          >
            <span className="flex items-center justify-center gap-2">
              <Sparkle size={15} /> Prepare editable draft
            </span>
          </Button>
        </div>
        <p className="mt-4 text-[9.5px] leading-4 text-muted">
          The result is deliberately not sent, posted or exported. Verify the
          citations, edit the language, then use it in your own workflow.
        </p>
      </Panel>
      <Panel className="p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-[12.5px] font-semibold">Draft editor</p>
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
            Editable · unsent
          </span>
        </div>
        <div className="p-4">
          <textarea
            data-testid="assist-writing-draft"
            className={`${inputCls} min-h-[190px] resize-y text-[12px] leading-5`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Generate a grounded draft, then edit it here…"
          />
          {citations.length > 0 && (
            <div className="mt-3 rounded-md border border-line bg-panel2 p-3">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
                Evidence
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {citations.map((citation) => (
                  <span
                    key={citation}
                    className="num rounded border border-line bg-panel px-2 py-1 text-[9px] text-muted"
                  >
                    {citation}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function TaskRouting(): React.JSX.Element {
  const routes = useQuery({ queryKey: ["aiRoutes"], queryFn: api.ai.routes });
  const toast = useToasts();
  const qc = useQueryClient();
  const save = async (
    route: AiTaskRoute,
    patch: Partial<Pick<AiTaskRoute, "provider" | "model">>,
  ): Promise<void> => {
    try {
      await api.ai.routeSet({
        taskKind: route.taskKind,
        provider: patch.provider ?? route.provider,
        model: patch.model === undefined ? route.model : patch.model,
      });
      await qc.invalidateQueries({ queryKey: ["aiRoutes"] });
      toast.push("success", `${route.taskKind} route saved`);
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="grid gap-3 border-b border-line bg-panel2 px-5 py-4 md:grid-cols-[1fr_auto]">
        <div>
          <p className="text-[12.5px] font-semibold">
            Choose the right model for each job
          </p>
          <p className="mt-1 text-[10px] text-muted">
            Default follows the provider in Settings. Overrides let OCR,
            analysis and writing use different compatible models.
          </p>
        </div>
        <SlidersHorizontal size={22} className="self-center text-muted" />
      </div>
      <div className="divide-y divide-line">
        {routes.data?.map((route) => (
          <RouteRow key={route.taskKind} route={route} onSave={save} />
        ))}
      </div>
    </Panel>
  );
}

function RouteRow({
  route,
  onSave,
}: {
  route: AiTaskRoute;
  onSave: (
    route: AiTaskRoute,
    patch: Partial<Pick<AiTaskRoute, "provider" | "model">>,
  ) => Promise<void>;
}): React.JSX.Element {
  const [provider, setProvider] = useState(route.provider);
  const [model, setModel] = useState(route.model ?? "");
  return (
    <div
      className="grid items-end gap-3 px-5 py-4 md:grid-cols-[0.65fr_0.6fr_1fr_auto]"
      data-testid={`assist-route-${route.taskKind}`}
    >
      <div>
        <p className="text-[11.5px] font-semibold capitalize">
          {route.taskKind === "ocr" ? "OCR" : route.taskKind}
        </p>
        <p className="mt-0.5 text-[9px] text-muted">
          Updated by {route.updatedBy}
        </p>
      </div>
      <Field label="Provider">
        <Select
          value={provider}
          onChange={(event) =>
            setProvider(event.target.value as AiTaskRoute["provider"])
          }
        >
          <option value="default">Default</option>
          <option value="openai">OpenAI</option>
          <option value="compatible">Compatible</option>
          {route.taskKind === "ocr" && <option value="offline">Bundled offline OCR</option>}
        </Select>
      </Field>
      <Field label="Model override">
        <TextInput
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="Use provider default"
        />
      </Field>
      <Button
        variant="primary"
        onClick={() =>
          void onSave(route, { provider, model: model.trim() || null })
        }
      >
        Save route
      </Button>
    </div>
  );
}
