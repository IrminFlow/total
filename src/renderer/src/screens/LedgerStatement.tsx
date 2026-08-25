import { memo, useCallback, useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  EmptyState,
  Money,
  Panel,
  QueryErrorState,
  SectionTitle,
  SkeletonRows,
} from "../components/ui";
import { useKeyNav } from "../components/useKeyNav";
import { csvReport, printReport, slugFilename } from "../lib/reportExport";
import type {
  ReportColumn as PdfColumn,
  ReportRow as PdfRow,
} from "../lib/client";
import { toDisplayDate } from "@shared/dates";
import { formatPaise } from "@shared/money";
import type { LedgerStatement, LedgerStatementRow } from "@shared/reports";

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: "Date", align: "l" },
  { label: "Particulars", align: "l" },
  { label: "Type · No.", align: "l" },
  { label: "Debit", align: "r" },
  { label: "Credit", align: "r" },
  { label: "Balance", align: "r" },
];

const MONTHLY_COLUMNS: PdfColumn[] = [
  { label: "Month", align: "l" },
  { label: "Debit", align: "r" },
  { label: "Credit", align: "r" },
  { label: "Closing", align: "r" },
];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

const PAGE = 200;

const LedgerStatementRowView = memo(function LedgerStatementRowView({
  row,
  index,
  isActive,
  onHover,
  onOpen,
}: {
  row: LedgerStatementRow;
  index: number;
  isActive: boolean;
  onHover: (i: number) => void;
  onOpen: (voucherId: number) => void;
}): React.JSX.Element {
  return (
    <tr
      data-active={isActive}
      data-row-id={row.voucherId || undefined}
      className="kbar-row cursor-pointer"
      onMouseEnter={() => onHover(index)}
      onClick={() => onOpen(row.voucherId)}
    >
      <td className="num text-muted">{toDisplayDate(row.date)}</td>
      <td className="max-w-64 truncate">{row.particulars}</td>
      <td className="num text-[12px] text-muted">
        {row.voucherType} {row.number}
      </td>
      <td className="r">
        <Money paise={row.debit} />
      </td>
      <td className="r">
        <Money paise={row.credit} />
      </td>
      <td className="r">
        <Money paise={row.running} signed />
      </td>
    </tr>
  );
});

export function LedgerStatementScreen({
  ledgerId,
}: {
  ledgerId: number;
}): React.JSX.Element {
  const { from, to } = useSession();
  const nav = useNav();
  const toast = useToasts();
  // Columnar month mode (v0.3 #55): one row per month with period totals + closing balance.
  const [mode, setMode] = useState<"detail" | "monthly">("detail");
  const [pageIndex, setPageIndex] = useState(0);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  useEffect(() => setPageIndex(0), [ledgerId, from, to, mode]);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["ledgerStatement", ledgerId, from, to, mode, pageIndex],
    queryFn: ({ signal }) =>
      api.reports.ledgerPage(
        ledgerId,
        from,
        to,
        {
          offset: mode === "monthly" ? 0 : pageIndex * PAGE,
          limit: PAGE,
          groupBy: mode === "monthly" ? "month" : undefined,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const months = data?.months ?? [];

  const { active, setActive } = useKeyNav(
    rows.length,
    (i) => {
      const r = rows[i];
      if (r) nav.go({ name: "voucher-entry", voucherId: r.voucherId });
    },
    mode === "detail",
  );

  const openRow = useCallback(
    (voucherId: number) => {
      nav.go({ name: "voucher-entry", voucherId });
    },
    [nav],
  );

  if (!data && isLoading) {
    return (
      <div className="mx-auto max-w-5xl">
        <Panel>
          <SkeletonRows />
        </Panel>
      </div>
    );
  }

  if (!data || isError) {
    return (
      <div className="mx-auto max-w-5xl">
        <Panel>
          <QueryErrorState
            title="Could not load the ledger statement"
            detail="The report request failed. No vouchers or balances were changed."
            onRetry={() => void refetch()}
          />
        </Panel>
      </div>
    );
  }

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`;
  const exportColumns = mode === "monthly" ? MONTHLY_COLUMNS : EXPORT_COLUMNS;
  const exportRowsFor = (statement: LedgerStatement): PdfRow[] =>
    mode === "monthly"
      ? [
          ...(statement.months ?? []).map((m) => ({
            cells: [
              monthLabel(m.month),
              formatPaise(m.debit, { zeroDash: true }),
              formatPaise(m.credit, { zeroDash: true }),
              formatPaise(m.closing, { zeroDash: true }),
            ],
          })),
          {
            cells: [
              "Closing balance",
              formatPaise(statement.totalDebit, { zeroDash: true }),
              formatPaise(statement.totalCredit, { zeroDash: true }),
              formatPaise(statement.closing, { zeroDash: true }),
            ],
            bold: true,
            rule: true,
          },
        ]
      : [
          ...statement.rows.map((r) => ({
            cells: [
              toDisplayDate(r.date),
              r.particulars,
              `${r.voucherType} ${r.number}`,
              formatPaise(r.debit, { zeroDash: true }),
              formatPaise(r.credit, { zeroDash: true }),
              formatPaise(r.running, { zeroDash: true }),
            ],
          })),
          {
            cells: [
              "",
              "Closing balance",
              "",
              formatPaise(statement.totalDebit, { zeroDash: true }),
              formatPaise(statement.totalCredit, { zeroDash: true }),
              formatPaise(statement.closing, { zeroDash: true }),
            ],
            bold: true,
            rule: true,
          },
        ];

  const exportReport = async (format: "pdf" | "csv"): Promise<void> => {
    if (format === "pdf" && mode === "detail" && data.page.totalRows > 5_000) {
      toast.push("error", "Too many rows for a PDF — narrow the period and try again");
      return;
    }
    setExporting(format);
    try {
      const statement =
        mode === "monthly"
          ? data
          : await api.reports.ledger(ledgerId, from, to);
      const exportRows = exportRowsFor(statement);
      if (format === "pdf") {
        await printReport(
          {
            title: statement.ledgerName,
            periodLabel,
            columns: exportColumns,
            rows: exportRows,
          },
          toast,
        );
      } else {
        await csvReport(
          exportColumns.map((column) => column.label),
          exportRows.map((row) => row.cells),
          `ledger-${slugFilename(statement.ledgerName)}${mode === "monthly" ? "-monthly" : ""}`,
          toast,
        );
      }
    } catch (error) {
      toast.push("error", error instanceof Error ? error.message : "Could not export the ledger statement");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {(["detail", "monthly"] as const).map((m) => (
                <button
                  key={m}
                  data-testid={`tab-ledger-statement-${m}`}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-1 text-[12.5px] capitalize ${mode === m ? "bg-amberbar/25 font-medium text-ink" : "text-muted hover:bg-panel2"}`}
                >
                  {m === "detail" ? "Vouchers" : "Monthly"}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              disabled={exporting !== null}
              onClick={() => void exportReport("pdf")}
            >
              {exporting === "pdf" ? "Preparing…" : "PDF"}
            </Button>
            <Button
              variant="ghost"
              disabled={exporting !== null}
              onClick={() => void exportReport("csv")}
            >
              {exporting === "csv" ? "Preparing…" : "CSV"}
            </Button>
            <Money paise={data.closing} signed className="text-[15px]" />
          </div>
        }
      >
        {data.ledgerName}
      </SectionTitle>
      <Panel>
        <div className="flex justify-between border-b border-line px-4 py-2 text-[12px] text-muted">
          <span>
            Opening balance · <Money paise={data.opening} signed />
          </span>
          <span>
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
        </div>
        {isLoading ? (
          <SkeletonRows />
        ) : mode === "monthly" ? (
          data.page.totalRows === 0 ? (
            <EmptyState title="No entries for this ledger in the period" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="r w-36">Debit</th>
                  <th className="r w-36">Credit</th>
                  <th className="r w-40">Closing</th>
                </tr>
              </thead>
              <tbody data-testid="rows-ledger-statement-monthly">
                {months.map((m) => (
                  <tr key={m.month}>
                    <td>{monthLabel(m.month)}</td>
                    <td className="r">
                      <Money paise={m.debit} />
                    </td>
                    <td className="r">
                      <Money paise={m.credit} />
                    </td>
                    <td className="r">
                      <Money paise={m.closing} signed />
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>Closing balance</td>
                  <td className="r">
                    <Money paise={data.totalDebit} />
                  </td>
                  <td className="r">
                    <Money paise={data.totalCredit} />
                  </td>
                  <td className="r">
                    <Money paise={data.closing} signed />
                  </td>
                </tr>
              </tbody>
            </table>
          )
        ) : rows.length === 0 ? (
          <EmptyState title="No entries for this ledger in the period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                <th>Particulars</th>
                <th className="w-24">Type · No.</th>
                <th className="r w-32">Debit</th>
                <th className="r w-32">Credit</th>
                <th className="r w-36">Balance</th>
              </tr>
            </thead>
            <tbody data-testid="rows-ledger-statement">
              {rows.map((r, i) => (
                <LedgerStatementRowView
                  key={`${r.voucherId}-${i}`}
                  row={r}
                  index={i}
                  isActive={i === active}
                  onHover={setActive}
                  onOpen={openRow}
                />
              ))}
              <tr className="total-row">
                <td colSpan={3}>Closing balance</td>
                <td className="r">
                  <Money paise={data.totalDebit} />
                </td>
                <td className="r">
                  <Money paise={data.totalCredit} />
                </td>
                <td className="r">
                  <Money paise={data.closing} signed />
                </td>
              </tr>
              {data.page.totalRows > PAGE && (
                <tr>
                  <td colSpan={6} className="py-2">
                    <div className="flex items-center justify-center gap-3">
                      <Button
                        variant="ghost"
                        disabled={!data.page.hasPrevious || isFetching}
                        onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                      >
                        Previous
                      </Button>
                      <span className="text-[11px] text-muted" aria-live="polite">
                        {data.page.offset + 1}–{data.page.offset + rows.length} of{" "}
                        {data.page.totalRows.toLocaleString()} entries
                        {isFetching ? " · Loading…" : ""}
                      </span>
                      <Button
                        variant="ghost"
                        disabled={!data.page.hasMore || isFetching}
                        onClick={() => setPageIndex((current) => current + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
