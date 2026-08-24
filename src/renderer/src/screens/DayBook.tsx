import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
} from "../components/ui";
import { useKeyNav } from "../components/useKeyNav";
import { ReportConfigButton } from "../components/ReportConfigButton";
import { useReportConfig, type ReportColumn } from "../lib/reportConfig";
import { csvReport, printReport } from "../lib/reportExport";
import type {
  ReportColumn as PdfColumn,
  ReportRow as PdfRow,
} from "../lib/client";
import { toDisplayDate, todayISO } from "@shared/dates";
import { formatPaise } from "@shared/money";
import type { DayBookRow } from "@shared/reports";
import { promptDialog } from "../lib/dialogs";
import { useBoundedRows } from "../lib/useBoundedRows";

const PAGE = 200;

const COLUMNS: ReportColumn[] = [
  { key: "type", label: "Type", defaultOn: true },
  { key: "number", label: "Number", defaultOn: true },
  { key: "account", label: "Account", defaultOn: true },
  { key: "debit", label: "Debit", defaultOn: true },
  { key: "credit", label: "Credit", defaultOn: true },
];

/** Which vouchers show: the books only (default), everything, or just the out-of-book kinds. */
type Scope = "books" | "all" | "optional" | "post-dated";

const SCOPE_LABELS: { value: Scope; label: string }[] = [
  { value: "books", label: "In books" },
  { value: "all", label: "All vouchers" },
  { value: "optional", label: "Optional only" },
  { value: "post-dated", label: "Post-dated only" },
];

const DayBookRowView = memo(function DayBookRowView({
  row,
  index,
  isActive,
  visible,
  onHover,
  onOpen,
  onPdf,
  selected,
  onToggle,
}: {
  row: DayBookRow;
  index: number;
  isActive: boolean;
  visible: Record<string, boolean>;
  onHover: (i: number) => void;
  onOpen: (voucherId: number) => void;
  onPdf: (voucherId: number, e: React.MouseEvent) => void;
  selected: boolean;
  onToggle: (voucherId: number) => void;
}): React.JSX.Element {
  return (
    <tr
      data-active={isActive}
      data-row-id={row.voucherId}
      className="kbar-row cursor-pointer"
      onMouseEnter={() => onHover(index)}
      onClick={() => onOpen(row.voucherId)}
    >
      <td className="w-10 text-center" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select voucher ${row.number}`}
          data-testid={`select-voucher-${row.voucherId}`}
          checked={selected}
          onChange={() => onToggle(row.voucherId)}
          className="accent-amberbar"
        />
      </td>
      <td className="num text-muted">{toDisplayDate(row.date)}</td>
      {visible.type && <td className="text-muted">{row.voucherType}</td>}
      {visible.number && <td className="num text-muted">{row.number}</td>}
      {visible.account && (
        <td>
          <div>{row.account}</div>
          {(row.isOptional ||
            row.postDated ||
            row.reversalOfId ||
            row.reversedById ||
            row.reviewedAt ||
            (row.tags?.length ?? 0) > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.isOptional && (
                <span className="whitespace-nowrap rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber">
                  Optional
                </span>
              )}
              {row.postDated && (
                <span className="whitespace-nowrap rounded bg-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-blue">
                  PDC
                </span>
              )}
              {row.reversalOfId && (
                <span className="whitespace-nowrap rounded bg-cr/10 px-1.5 py-0.5 text-[10px] font-medium text-cr">
                  Reversal
                </span>
              )}
              {row.reversedById && (
                <span className="whitespace-nowrap rounded bg-muted/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                  Reversed
                </span>
              )}
              {row.reviewedAt && (
                <span
                  className="whitespace-nowrap rounded bg-dr/10 px-1.5 py-0.5 text-[10px] font-medium text-dr"
                  title={`Reviewed by ${row.reviewedBy ?? "user"}`}
                >
                  Reviewed
                </span>
              )}
              {(row.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-[10px] text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </td>
      )}
      <td className="max-w-56 truncate text-muted">{row.narration}</td>
      {visible.debit && (
        <td className="r">
          <Money paise={row.debit} />
          {row.kind === "sales" && (
            <button
              className="ml-2 text-[11.5px] text-blue hover:underline"
              onClick={(e) => onPdf(row.voucherId, e)}
              title="Invoice PDF"
            >
              PDF
            </button>
          )}
        </td>
      )}
      {visible.credit && (
        <td className="r">
          <Money paise={row.credit} />
        </td>
      )}
    </tr>
  );
});

export function DayBook({
  from: drillFrom,
  to: drillTo,
  periodLabel: drillLabel,
  kind,
  voucherIds,
}: {
  from?: string;
  to?: string;
  periodLabel?: string;
  kind?: string;
  voucherIds?: number[];
} = {}): React.JSX.Element {
  const { from, to } = useSession();
  const nav = useNav();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<Scope>("books");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [reverseOpen, setReverseOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // Registers hands over an exact month/quarter range + kind; keep it dismissible local state
  // so the chip's ✕ clears the drill without a navigation.
  const [drill, setDrill] = useState<{
    from?: string;
    to?: string;
    label?: string;
    kind?: string;
    voucherIds?: number[];
  }>({
    from: drillFrom,
    to: drillTo,
    label: drillLabel,
    kind,
    voucherIds,
  });
  useEffect(() => {
    setDrill({
      from: drillFrom,
      to: drillTo,
      label: drillLabel,
      kind,
      voucherIds,
    });
  }, [drillFrom, drillTo, drillLabel, kind, voucherIds]);
  const { data, isLoading } = useQuery({
    queryKey: ["daybook", from, to, "all"],
    queryFn: ({ signal }) => api.reports.dayBook(from, to, true, signal),
  });
  const { visible, toggle } = useReportConfig("daybook", COLUMNS);

  const rows = useMemo(() => {
    let all = data ?? [];
    if (scope === "books")
      all = all.filter((r) => !r.isOptional && !r.postDated);
    else if (scope === "optional") all = all.filter((r) => r.isOptional);
    else if (scope === "post-dated") all = all.filter((r) => r.postDated);
    if (drill.from) all = all.filter((r) => r.date >= drill.from!);
    if (drill.to) all = all.filter((r) => r.date <= drill.to!);
    if (drill.kind) all = all.filter((r) => r.kind === drill.kind);
    if (drill.voucherIds) {
      const ids = new Set(drill.voucherIds);
      all = all.filter((r) => ids.has(r.voucherId));
    }
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.account.toLowerCase().includes(q) ||
        r.voucherType.toLowerCase().includes(q) ||
        r.number.toLowerCase().includes(q) ||
        (r.narration ?? "").toLowerCase().includes(q),
    );
  }, [data, filter, scope, drill]);

  const {
    visibleRows: displayRows,
    visibleCount,
    remaining,
    showMore,
  } = useBoundedRows(
    rows,
    `${from}|${to}|${filter}|${scope}|${drill.from ?? ""}|${drill.to ?? ""}|${drill.kind ?? ""}|${drill.voucherIds?.join(",") ?? ""}`,
    PAGE,
  );
  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.voucherId)),
    [rows, selected],
  );
  const allSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.voucherId));

  useEffect(() => {
    const available = new Set(rows.map((row) => row.voucherId));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  const toggleSelected = useCallback((voucherId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(voucherId)) next.delete(voucherId);
      else next.add(voucherId);
      return next;
    });
  }, []);

  // Totals stay honest: only in-books rows (never optional/PDC) count, whatever the scope shows.
  const bookRows = useMemo(
    () => rows.filter((r) => !r.isOptional && !r.postDated),
    [rows],
  );
  const totalDebit = bookRows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = bookRows.reduce((s, r) => s + r.credit, 0);

  const { active, setActive } = useKeyNav(displayRows.length, (i) => {
    const r = displayRows[i];
    if (r) nav.go({ name: "voucher-entry", voucherId: r.voucherId });
  });

  const openRow = useCallback(
    (voucherId: number) => {
      nav.go({ name: "voucher-entry", voucherId });
    },
    [nav],
  );

  const openPdf = useCallback(
    (voucherId: number, e: React.MouseEvent) => {
      e.stopPropagation();
      api.invoice
        .pdf(voucherId)
        .catch((err: Error) => toast.push("error", err.message));
    },
    [toast],
  );

  // Date and Narration always show; the rest follow the F12 column config.
  const colCount =
    3 +
    (visible.type ? 1 : 0) +
    (visible.number ? 1 : 0) +
    (visible.account ? 1 : 0) +
    (visible.debit ? 1 : 0) +
    (visible.credit ? 1 : 0);

  const exportColumns: PdfColumn[] = [
    { label: "Date", align: "l" },
    ...(visible.type ? [{ label: "Type", align: "l" as const }] : []),
    ...(visible.number ? [{ label: "No.", align: "l" as const }] : []),
    ...(visible.account ? [{ label: "Account", align: "l" as const }] : []),
    { label: "Narration", align: "l" },
    ...(visible.debit ? [{ label: "Debit", align: "r" as const }] : []),
    ...(visible.credit ? [{ label: "Credit", align: "r" as const }] : []),
  ];
  const badge = (r: DayBookRow): string =>
    r.isOptional ? " [Optional]" : r.postDated ? " [PDC]" : "";
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        toDisplayDate(r.date),
        ...(visible.type ? [r.voucherType] : []),
        ...(visible.number ? [r.number] : []),
        ...(visible.account ? [`${r.account}${badge(r)}`] : []),
        r.narration ?? "",
        ...(visible.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(r.credit, { zeroDash: true })] : []),
      ],
    })),
    {
      cells: [
        `Total (in books) · ${bookRows.length} vouchers`,
        ...(visible.type ? [""] : []),
        ...(visible.number ? [""] : []),
        ...(visible.account ? [""] : []),
        "",
        ...(visible.debit ? [formatPaise(totalDebit, { zeroDash: true })] : []),
        ...(visible.credit
          ? [formatPaise(totalCredit, { zeroDash: true })]
          : []),
      ],
      bold: true,
      rule: true,
    },
  ];
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`;
  const hasOutOfBooks = rows.length !== bookRows.length;

  const rowsForExport = useCallback(
    (source: DayBookRow[]): PdfRow[] => {
      const inBooks = source.filter((row) => !row.isOptional && !row.postDated);
      const debit = inBooks.reduce((sum, row) => sum + row.debit, 0);
      const credit = inBooks.reduce((sum, row) => sum + row.credit, 0);
      return [
        ...source.map((row) => ({
          cells: [
            toDisplayDate(row.date),
            ...(visible.type ? [row.voucherType] : []),
            ...(visible.number ? [row.number] : []),
            ...(visible.account ? [`${row.account}${badge(row)}`] : []),
            row.narration ?? "",
            ...(visible.debit
              ? [formatPaise(row.debit, { zeroDash: true })]
              : []),
            ...(visible.credit
              ? [formatPaise(row.credit, { zeroDash: true })]
              : []),
          ],
        })),
        {
          cells: [
            `Total (in books) · ${inBooks.length} vouchers`,
            ...(visible.type ? [""] : []),
            ...(visible.number ? [""] : []),
            ...(visible.account ? [""] : []),
            "",
            ...(visible.debit ? [formatPaise(debit, { zeroDash: true })] : []),
            ...(visible.credit
              ? [formatPaise(credit, { zeroDash: true })]
              : []),
          ],
          bold: true,
          rule: true,
        },
      ];
    },
    [visible],
  );

  const runBatch = useCallback(
    async (action: () => Promise<unknown>, success: string): Promise<void> => {
      setBatchBusy(true);
      try {
        await action();
        await queryClient.invalidateQueries({ queryKey: ["daybook"] });
        toast.push("success", success);
        setSelected(new Set());
      } catch (err) {
        toast.push("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBatchBusy(false);
      }
    },
    [queryClient, toast],
  );

  const addTag = useCallback(async (): Promise<void> => {
    const tag = await promptDialog({
      title: `Tag ${selectedRows.length} voucher${selectedRows.length === 1 ? "" : "s"}`,
      message: "Use a short operational label, such as GST check or Follow up.",
      placeholder: "Tag",
      confirmLabel: "Add tag",
    });
    if (tag == null || !tag.trim()) return;
    await runBatch(
      () =>
        api.vouchers.batchTag(
          selectedRows.map((row) => row.voucherId),
          tag,
        ),
      `Tag added to ${selectedRows.length} vouchers`,
    );
  }, [runBatch, selectedRows]);

  const markReviewed = useCallback(async (): Promise<void> => {
    await runBatch(
      () => api.vouchers.batchReview(selectedRows.map((row) => row.voucherId)),
      `${selectedRows.length} voucher${selectedRows.length === 1 ? "" : "s"} marked reviewed`,
    );
  }, [runBatch, selectedRows]);

  const exportInvoicePdfs = useCallback(async (): Promise<void> => {
    const sales = selectedRows.filter((row) => row.kind === "sales");
    setBatchBusy(true);
    try {
      const result = await api.invoice.pdfBatch(
        sales.map((row) => row.voucherId),
      );
      toast.push(
        "success",
        `${result.paths.length} invoice PDF${result.paths.length === 1 ? "" : "s"} created`,
      );
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBatchBusy(false);
    }
  }, [selectedRows, toast]);

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TextInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter…"
              className="w-56"
            />
            <Select
              data-testid="input-daybook-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              className="w-40"
              aria-label="Voucher scope"
            >
              {SCOPE_LABELS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <ReportConfigButton
              columns={COLUMNS}
              visible={visible}
              toggle={toggle}
            />
            <Button
              variant="ghost"
              onClick={() =>
                void printReport(
                  {
                    title: "Day book",
                    periodLabel,
                    columns: exportColumns,
                    rows: exportRows,
                  },
                  toast,
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(
                  exportColumns.map((c) => c.label),
                  exportRows.map((r) => r.cells),
                  "day-book",
                  toast,
                )
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Day book
      </SectionTitle>
      {(drill.from || drill.to || drill.kind || drill.voucherIds) && (
        <div className="mb-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-amberbar/50 bg-amberbar/10 px-3 py-1 text-[12px]">
            {drill.label ??
              (drill.from && drill.to
                ? `${toDisplayDate(drill.from)} to ${toDisplayDate(drill.to)}`
                : null)}
            {(drill.from || drill.to) && drill.kind ? " · " : ""}
            {drill.kind ? (
              <span className="capitalize">{drill.kind.replace("_", " ")}</span>
            ) : null}
            {drill.voucherIds
              ? `${drill.kind || drill.from || drill.to ? " · " : ""}${drill.voucherIds.length} contributing voucher${drill.voucherIds.length === 1 ? "" : "s"}`
              : null}
            <button
              type="button"
              data-testid="daybook-clear-drill"
              aria-label="Clear the period/type filter"
              className="ml-1 text-muted hover:text-ink"
              onClick={() => setDrill({})}
            >
              ✕
            </button>
          </span>
          <span className="text-[11.5px] text-muted">
            Exact source set from the previous report
          </span>
        </div>
      )}
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              scope === "books"
                ? "No entries in this period"
                : `No ${scope === "all" ? "" : scope + " "}vouchers in this period`
            }
            hint="Press V for voucher entry"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all filtered vouchers"
                    data-testid="select-all-vouchers"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected
                          ? new Set()
                          : new Set(rows.map((row) => row.voucherId)),
                      )
                    }
                    className="accent-amberbar"
                  />
                </th>
                <th className="w-24">Date</th>
                {visible.type && <th className="w-28">Type</th>}
                {visible.number && <th className="w-20">No.</th>}
                {visible.account && <th>Account</th>}
                <th>Narration</th>
                {visible.debit && <th className="r w-36">Debit</th>}
                {visible.credit && <th className="r w-36">Credit</th>}
              </tr>
            </thead>
            <tbody data-testid="rows-daybook">
              {displayRows.map((r, i) => (
                <DayBookRowView
                  key={`${r.voucherId}`}
                  row={r}
                  index={i}
                  isActive={i === active}
                  visible={visible}
                  onHover={setActive}
                  onOpen={openRow}
                  onPdf={openPdf}
                  selected={selected.has(r.voucherId)}
                  onToggle={toggleSelected}
                />
              ))}
              {remaining > 0 && (
                <tr>
                  <td colSpan={colCount} className="py-2 text-center">
                    <Button variant="ghost" onClick={showMore}>
                      Show next {Math.min(PAGE, remaining)} · {remaining}{" "}
                      remaining
                    </Button>
                    <span className="ml-2 text-[10px] text-muted">
                      Showing {visibleCount} of {rows.length}; totals include
                      every row.
                    </span>
                  </td>
                </tr>
              )}
              <tr className="total-row">
                <td
                  colSpan={
                    colCount -
                    (visible.debit ? 1 : 0) -
                    (visible.credit ? 1 : 0)
                  }
                >
                  Total{hasOutOfBooks ? " (in books)" : ""} · {bookRows.length}{" "}
                  vouchers
                </td>
                {visible.debit && (
                  <td className="r">
                    <Money paise={totalDebit} />
                  </td>
                )}
                {visible.credit && (
                  <td className="r">
                    <Money paise={totalCredit} />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      {selectedRows.length > 0 && (
        <div
          data-testid="daybook-batch-tray"
          className="sticky bottom-4 z-20 mx-auto mt-3 flex items-center justify-between gap-4 rounded-lg border border-amberbar/40 bg-panel/95 px-3 py-2 panel-shadow backdrop-blur"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-8 min-w-8 place-items-center rounded-md bg-amberbar text-[12px] font-semibold text-[#2b2000]">
              {selectedRows.length}
            </span>
            <div>
              <p className="text-[12px] font-semibold">Selected vouchers</p>
              <p className="text-[10.5px] text-muted">
                Actions apply to this exact filtered selection
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              disabled={batchBusy}
              onClick={() =>
                void printReport(
                  {
                    title: "Selected Day book vouchers",
                    periodLabel,
                    columns: exportColumns,
                    rows: rowsForExport(selectedRows),
                  },
                  toast,
                )
              }
            >
              Print
            </Button>
            <Button
              variant="ghost"
              disabled={batchBusy}
              onClick={() =>
                void csvReport(
                  exportColumns.map((column) => column.label),
                  rowsForExport(selectedRows).map((row) => row.cells),
                  "day-book-selection",
                  toast,
                )
              }
            >
              Export CSV
            </Button>
            {selectedRows.some((row) => row.kind === "sales") && (
              <Button
                variant="ghost"
                disabled={batchBusy}
                onClick={() => void exportInvoicePdfs()}
              >
                Invoice PDFs
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={batchBusy}
              onClick={() => void addTag()}
            >
              Tag
            </Button>
            <Button
              variant="ghost"
              disabled={batchBusy}
              onClick={() => void markReviewed()}
            >
              Mark reviewed
            </Button>
            <Button
              variant="danger"
              disabled={
                batchBusy ||
                selectedRows.some(
                  (row) =>
                    row.reversalOfId !== null || row.reversedById !== null,
                )
              }
              disabledTitle="A reversal or already-reversed voucher cannot be reversed again"
              onClick={() => setReverseOpen(true)}
            >
              Reverse…
            </Button>
            <Button
              variant="ghost"
              disabled={batchBusy}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      {reverseOpen && (
        <VoucherReverseModal
          count={selectedRows.length}
          onClose={() => setReverseOpen(false)}
          onReverse={async (date, reason) => {
            await runBatch(
              () =>
                api.vouchers.batchReverse(
                  selectedRows.map((row) => row.voucherId),
                  date,
                  reason,
                ),
              `${selectedRows.length} linked reversal${selectedRows.length === 1 ? "" : "s"} created`,
            );
            setReverseOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function VoucherReverseModal({
  count,
  onClose,
  onReverse,
}: {
  count: number;
  onClose: () => void;
  onReverse: (date: string, reason: string) => Promise<void>;
}): React.JSX.Element {
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = reason.trim().length >= 5;
  return (
    <Modal
      title={`Reverse ${count} voucher${count === 1 ? "" : "s"}`}
      onClose={onClose}
      dirty={reason.trim().length > 0}
    >
      <div className="grid gap-4">
        <div className="rounded-md border border-cr/25 bg-cr/5 px-3 py-2 text-[11.5px]">
          The originals remain immutable. Total will create side-flipped entries
          linked to each source, all-or-nothing.
        </div>
        <Field
          label="Reversal date"
          hint="Must be on or after every selected voucher and outside the books lock."
        >
          <DateInput
            value={date}
            context={todayISO()}
            onChange={setDate}
            testId="input-reversal-date"
          />
        </Field>
        <Field
          label="Reason"
          hint="This is stored permanently with the author and original-entry link."
        >
          <TextInput
            autoFocus
            data-testid="input-reversal-reason"
            value={reason}
            maxLength={500}
            placeholder="Why are these entries being reversed?"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid="action-confirm-reversal"
            disabled={saving || !valid}
            onClick={() => {
              setSaving(true);
              void onReverse(date, reason).finally(() => setSaving(false));
            }}
          >
            {saving ? "Creating reversals…" : "Create linked reversals"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
