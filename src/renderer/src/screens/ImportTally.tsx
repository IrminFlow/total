import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TallyImportSummary } from "../lib/client";
import { useNav, useToasts } from "../state/stores";
import {
  Button,
  EmptyState,
  Money,
  Panel,
  SectionTitle,
} from "../components/ui";
import { printReport } from "../lib/reportExport";
import { todayISO, toDisplayDate } from "@shared/dates";
import { formatPaise } from "@shared/money";
import {
  CheckCircle,
  FileCode,
  Fingerprint,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";

type Step =
  | { kind: "pick" }
  | { kind: "preview"; filePath: string | null; summary: TallyImportSummary }
  | { kind: "done"; filePath: string | null; summary: TallyImportSummary };

type CountKey =
  "groups" | "ledgers" | "units" | "items" | "vouchers" | "skipped";
const COUNT_LABELS: { key: CountKey; label: string }[] = [
  { key: "groups", label: "Groups" },
  { key: "ledgers", label: "Ledgers" },
  { key: "units", label: "Units" },
  { key: "items", label: "Stock items" },
  { key: "vouchers", label: "Vouchers" },
  { key: "skipped", label: "Skipped" },
];

function CountsGrid({
  summary,
}: {
  summary: TallyImportSummary;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {COUNT_LABELS.map(({ key, label }) => (
        <div
          key={key}
          className="rounded-md border border-line bg-panel2 px-3 py-2.5 text-center"
        >
          <div
            className={`num text-[20px] font-semibold ${key === "skipped" && summary[key] > 0 ? "text-cr" : ""}`}
          >
            {summary[key]}
          </div>
          <div className="text-[11px] text-muted uppercase tracking-[0.06em]">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

const WARNINGS_PREVIEW = 8;

function WarningsBox({
  warnings,
}: {
  warnings: string[];
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;
  const shown = expanded ? warnings : warnings.slice(0, WARNINGS_PREVIEW);
  const hidden = warnings.length - shown.length;
  return (
    <div className="mt-4 max-h-56 overflow-auto rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-2">
      <p className="flex items-center gap-2 py-0.5 text-[12.5px] font-medium text-ink">
        <span
          data-testid="badge-import-tally-warnings"
          className="rounded bg-amberbar/40 px-1.5 py-0.5 num text-[11px]"
        >
          {warnings.length}
        </span>
        warning{warnings.length > 1 ? "s" : ""}
      </p>
      {shown.map((w, i) => (
        <p key={i} className="py-0.5 text-[12.5px] text-ink">
          {w}
        </p>
      ))}
      {hidden > 0 && (
        <button
          data-testid="btn-import-tally-warnings-more"
          className="py-0.5 text-[12.5px] text-blue hover:underline"
          onClick={() => setExpanded(true)}
        >
          {hidden} more…
        </button>
      )}
    </div>
  );
}

export function ImportTallyScreen(): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [busy, setBusy] = useState(false);

  const pickFile = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.tally.dryRun();
      if (!r) return; // dialog canceled
      setStep({ kind: "preview", filePath: r.filePath, summary: r.summary });
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyImport = async (filePath: string | null): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.tally.apply(filePath ?? undefined);
      if (!r) return;
      setStep({ kind: "done", filePath: r.filePath, summary: r.summary });
      toast.push(
        "success",
        `Imported: ${r.summary.groups} groups, ${r.summary.ledgers} ledgers, ${r.summary.units} units, ${r.summary.items} items, ${r.summary.vouchers} vouchers${r.summary.skipped ? ` (${r.summary.skipped} skipped)` : ""}`,
      );
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-md border border-line bg-panel2 p-2 text-blue">
          <FileCode size={22} weight="duotone" />
        </span>
        <div>
          <SectionTitle>Import from Tally</SectionTitle>
          <p className="mt-0.5 text-[12px] text-muted">
            Review first, apply once, and retain an audit-ready source
            fingerprint.
          </p>
        </div>
      </div>
      {step.kind === "pick" && (
        <PickStep busy={busy} onPick={() => void pickFile()} />
      )}
      {step.kind === "preview" && (
        <PreviewStep
          summary={step.summary}
          busy={busy}
          onImport={() => void applyImport(step.filePath)}
          onDifferentFile={() => setStep({ kind: "pick" })}
        />
      )}
      {step.kind === "done" && (
        <DoneStep summary={step.summary} onGateway={() => nav.home()} />
      )}
    </div>
  );
}

function PickStep({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <>
      <Panel className="p-6">
        <p className="text-[13.5px] text-muted">
          Export your books from Tally first:
        </p>
        <ol className="mt-3 flex flex-col gap-1.5 text-[13px]">
          <li>
            <b>Masters</b> — Gateway of Tally → Display → List of Accounts →{" "}
            <span className="num">Export</span> → XML
          </li>
          <li>
            <b>Vouchers</b> — Gateway of Tally → Display → Day Book →{" "}
            <span className="num">Export</span> → XML for the period you want
          </li>
        </ol>
        <p className="mt-3 text-[12.5px] text-muted">
          Import the masters export first (groups, ledgers, stock items), then
          the vouchers export. Nothing is written to your books until you
          confirm on the next screen.
        </p>
        <div className="mt-5 flex justify-center">
          <Button
            variant="primary"
            data-testid="btn-import-tally-pick"
            disabled={busy}
            onClick={onPick}
            className="px-8 py-3 text-[14px]"
          >
            {busy ? "Reading…" : "Choose Tally XML…"}
          </Button>
        </div>
      </Panel>
    </>
  );
}

function PreviewStep({
  summary,
  busy,
  onImport,
  onDifferentFile,
}: {
  summary: TallyImportSummary;
  busy: boolean;
  onImport: () => void;
  onDifferentFile: () => void;
}): React.JSX.Element {
  return (
    <Panel className="p-6">
      <p className="mb-3 text-[13px] text-muted">
        Here&rsquo;s what this file contains — nothing has been imported yet.
      </p>
      <CountsGrid summary={summary} />
      {summary.alreadyImported && (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-cr/35 bg-cr/8 px-3.5 py-3 text-[12.5px]">
          <Warning
            size={19}
            weight="fill"
            className="mt-0.5 shrink-0 text-cr"
          />
          <div>
            <b>Already imported as batch #{summary.alreadyImported.id}.</b> This
            exact XML was applied on{" "}
            {new Date(summary.alreadyImported.appliedAt).toLocaleString()}.
            Reapplying is disabled to protect your books.
          </div>
        </div>
      )}
      <WarningsBox warnings={summary.warnings} />
      {summary.sourceHash && (
        <div className="mt-4 flex items-center gap-1.5 border-t border-line pt-3 text-[10.5px] text-muted">
          <Fingerprint size={14} /> <span>File fingerprint</span>{" "}
          <code className="num truncate">{summary.sourceHash}</code>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDifferentFile}>
          Choose different file
        </Button>
        <Button
          variant="primary"
          data-testid="btn-import-tally-import"
          disabled={busy || Boolean(summary.alreadyImported)}
          onClick={onImport}
        >
          {summary.alreadyImported
            ? "Already imported"
            : busy
              ? "Importing…"
              : "Import now"}
        </Button>
      </div>
    </Panel>
  );
}

function DoneStep({
  summary,
  onGateway,
}: {
  summary: TallyImportSummary;
  onGateway: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const [certificateBusy, setCertificateBusy] = useState(false);
  const today = todayISO();
  const { data: tb } = useQuery({
    queryKey: ["trialBalance", today],
    queryFn: ({ signal }) => api.reports.trialBalance(today, signal),
  });
  const rows = tb?.rows ?? [];

  const printTb = (): void => {
    void printReport(
      {
        title: "Trial balance",
        periodLabel: `as on ${toDisplayDate(today)}`,
        columns: [
          { label: "Ledger", align: "l" },
          { label: "Group", align: "l" },
          { label: "Debit", align: "r" },
          { label: "Credit", align: "r" },
        ],
        rows: [
          ...rows.map((r) => ({
            cells: [
              r.ledgerName,
              r.groupName,
              formatPaise(r.debit, { zeroDash: true }),
              formatPaise(r.credit, { zeroDash: true }),
            ],
          })),
          {
            cells: [
              "Total",
              "",
              formatPaise(tb?.totalDebit ?? 0, { zeroDash: true }),
              formatPaise(tb?.totalCredit ?? 0, { zeroDash: true }),
            ],
            bold: true,
            rule: true,
          },
        ],
        filename: "trial-balance",
      },
      toast,
    );
  };

  const exportCertificate = async (): Promise<void> => {
    if (!summary.batchId) return;
    setCertificateBusy(true);
    try {
      const result = await api.importer.certificate(summary.batchId);
      toast.push(
        result.status === "internal_checks_passed" ? "success" : "info",
        result.status === "internal_checks_passed"
          ? `Batch #${summary.batchId} evidence receipt saved as JSON and PDF`
          : `Batch #${summary.batchId} evidence receipt saved; review the checks needing attention`,
      );
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setCertificateBusy(false);
    }
  };

  return (
    <>
      <Panel className="p-6">
        <div className="mb-4 flex items-start gap-3 border-b border-line pb-4">
          <span className="rounded-md bg-dr/12 p-2 text-dr">
            <ShieldCheck size={22} weight="duotone" />
          </span>
          <div>
            <p className="text-[13.5px] font-semibold text-ink">
              Import complete and recorded
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted">
              {summary.batchId ? `Batch #${summary.batchId} · ` : ""}All
              accepted records committed in one transaction.
            </p>
          </div>
        </div>
        <CountsGrid summary={summary} />
        <WarningsBox warnings={summary.warnings} />
        {summary.sourceHash && (
          <div className="mt-4 flex items-center gap-1.5 text-[10.5px] text-muted">
            <CheckCircle size={14} weight="fill" className="text-dr" />{" "}
            <span>Verified fingerprint</span>{" "}
            <code className="num truncate">{summary.sourceHash}</code>
          </div>
        )}
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[12.5px] text-muted">
          Compare with Tally&rsquo;s Trial Balance — should match to the paise.
        </p>
        <div className="flex gap-2">
          {summary.batchId && (
            <Button
              onClick={() => void exportCertificate()}
              disabled={certificateBusy}
            >
              {certificateBusy ? "Preparing…" : "Import evidence receipt"}
            </Button>
          )}
          <Button variant="ghost" onClick={printTb}>
            Trial balance PDF
          </Button>
          <Button variant="primary" onClick={onGateway}>
            Go to Gateway
          </Button>
        </div>
      </div>

      <Panel className="mt-3" scroll={{ maxH: "60vh" }}>
        {rows.length === 0 ? (
          <EmptyState title="No balances yet" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                <th className="r w-40">Debit</th>
                <th className="r w-40">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ledgerId}>
                  <td>{r.ledgerName}</td>
                  <td className="text-muted">{r.groupName}</td>
                  <td className="r">
                    <Money paise={r.debit} />
                  </td>
                  <td className="r">
                    <Money paise={r.credit} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="r">
                  <Money paise={tb?.totalDebit ?? 0} />
                </td>
                <td className="r">
                  <Money paise={tb?.totalCredit ?? 0} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
