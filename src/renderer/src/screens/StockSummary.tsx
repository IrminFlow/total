import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  EmptyState,
  Money,
  Panel,
  SectionTitle,
  SkeletonRows,
} from "../components/ui";
import { ReportConfigButton } from "../components/ReportConfigButton";
import { useReportConfig, type ReportColumn } from "../lib/reportConfig";
import { csvReport, printReport } from "../lib/reportExport";
import type {
  ReportColumn as PdfColumn,
  ReportRow as PdfRow,
} from "../lib/client";
import { toDisplayDate } from "@shared/dates";
import { formatPaise } from "@shared/money";
import { useBoundedRows } from "../lib/useBoundedRows";

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals);
}

const COLUMNS: ReportColumn[] = [
  { key: "opening", label: "Opening", defaultOn: true },
  { key: "inwards", label: "Inwards", defaultOn: true },
  { key: "outwards", label: "Outwards", defaultOn: true },
  { key: "closingQty", label: "Closing qty", defaultOn: true },
  { key: "closingValue", label: "Closing value", defaultOn: true },
];

export function StockSummaryScreen(): React.JSX.Element {
  const { to } = useSession();
  const toast = useToasts();
  const { data, isLoading } = useQuery({
    queryKey: ["stockSummary", to],
    queryFn: ({ signal }) => api.reports.stockSummary(to, signal),
  });
  const rows = data ?? [];
  const { visibleRows, visibleCount, remaining, showMore } = useBoundedRows(
    rows,
    to,
    200,
  );
  const { visible, toggle } = useReportConfig("stock-summary", COLUMNS);
  // Expandable item rows (user ask): one item at a time unfolds into its godown- and
  // batch-wise closing position, fetched on demand.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const colCount =
    1 +
    (visible.opening ? 1 : 0) +
    (visible.inwards ? 1 : 0) +
    (visible.outwards ? 1 : 0) +
    (visible.closingQty ? 1 : 0) +
    (visible.closingValue ? 1 : 0);

  const exportColumns: PdfColumn[] = [
    { label: "Item", align: "l" },
    ...(visible.opening ? [{ label: "Opening", align: "r" as const }] : []),
    ...(visible.inwards ? [{ label: "Inwards", align: "r" as const }] : []),
    ...(visible.outwards ? [{ label: "Outwards", align: "r" as const }] : []),
    ...(visible.closingQty
      ? [{ label: "Closing qty", align: "r" as const }]
      : []),
    ...(visible.closingValue
      ? [{ label: "Closing value", align: "r" as const }]
      : []),
  ];
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.name,
        ...(visible.opening
          ? [`${fmtQty(r.openingQtyMilli, r.decimals)} ${r.unitSymbol}`]
          : []),
        ...(visible.inwards
          ? [`${fmtQty(r.inwardQtyMilli, r.decimals)} ${r.unitSymbol}`]
          : []),
        ...(visible.outwards
          ? [`${fmtQty(r.outwardQtyMilli, r.decimals)} ${r.unitSymbol}`]
          : []),
        ...(visible.closingQty
          ? [`${fmtQty(r.closingQtyMilli, r.decimals)} ${r.unitSymbol}`]
          : []),
        ...(visible.closingValue
          ? [formatPaise(r.closingValue, { zeroDash: true })]
          : []),
      ],
    })),
    {
      cells: [
        "Total",
        ...(visible.opening ? [""] : []),
        ...(visible.inwards ? [""] : []),
        ...(visible.outwards ? [""] : []),
        ...(visible.closingQty ? [""] : []),
        ...(visible.closingValue
          ? [
              formatPaise(
                rows.reduce((s, r) => s + r.closingValue, 0),
                { zeroDash: true },
              ),
            ]
          : []),
      ],
      bold: true,
      rule: true,
    },
  ];
  const periodLabel = `as on ${toDisplayDate(to)}`;

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <span className="num text-[12px] text-muted">
              as on {toDisplayDate(to)}
            </span>
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
                    title: "Stock summary",
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
                  "stock-summary",
                  toast,
                )
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Stock summary
      </SectionTitle>
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No stock items yet"
            hint="Create items under Masters, or straight from a sales/purchase voucher"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Item</th>
                {visible.opening && <th className="r w-32">Opening</th>}
                {visible.inwards && <th className="r w-32">Inwards</th>}
                {visible.outwards && <th className="r w-32">Outwards</th>}
                {visible.closingQty && <th className="r w-32">Closing qty</th>}
                {visible.closingValue && (
                  <th className="r w-40">Closing value</th>
                )}
              </tr>
            </thead>
            <tbody data-testid="rows-stock-summary">
              {visibleRows.map((r) => (
                <Fragment key={r.stockItemId}>
                  <tr
                    data-row-id={r.stockItemId}
                    className={`cursor-pointer ${r.closingQtyMilli < 0 ? "text-cr" : ""}`}
                    onClick={() =>
                      setExpandedId((cur) =>
                        cur === r.stockItemId ? null : r.stockItemId,
                      )
                    }
                  >
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-[10px] text-muted">
                        {expandedId === r.stockItemId ? "▾" : "▸"}
                      </span>
                      {r.name}
                      {r.closingQtyMilli < 0 && (
                        <span className="ml-2 text-[11px]">
                          — negative stock, check entries
                        </span>
                      )}
                    </td>
                    {visible.opening && (
                      <td className="r num">
                        {fmtQty(r.openingQtyMilli, r.decimals)} {r.unitSymbol}
                      </td>
                    )}
                    {visible.inwards && (
                      <td className="r num">
                        {fmtQty(r.inwardQtyMilli, r.decimals)} {r.unitSymbol}
                      </td>
                    )}
                    {visible.outwards && (
                      <td className="r num">
                        {fmtQty(r.outwardQtyMilli, r.decimals)} {r.unitSymbol}
                      </td>
                    )}
                    {visible.closingQty && (
                      <td className="r num">
                        {fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}
                      </td>
                    )}
                    {visible.closingValue && (
                      <td className="r">
                        <Money paise={r.closingValue} />
                      </td>
                    )}
                  </tr>
                  {expandedId === r.stockItemId && (
                    <tr>
                      <td colSpan={colCount} className="bg-panel2/50">
                        <ItemDetail
                          stockItemId={r.stockItemId}
                          asOn={to}
                          decimals={r.decimals}
                          unitSymbol={r.unitSymbol}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {remaining > 0 && (
                <tr>
                  <td colSpan={colCount} className="py-2 text-center">
                    <Button variant="ghost" onClick={showMore}>
                      Show next {Math.min(200, remaining)} · {remaining}{" "}
                      remaining
                    </Button>
                    <span className="ml-2 text-[10px] text-muted">
                      Showing {visibleCount} of {rows.length}; inventory value
                      includes every item.
                    </span>
                  </td>
                </tr>
              )}
              <tr className="total-row">
                <td
                  colSpan={
                    1 +
                    (visible.opening ? 1 : 0) +
                    (visible.inwards ? 1 : 0) +
                    (visible.outwards ? 1 : 0) +
                    (visible.closingQty ? 1 : 0)
                  }
                >
                  Total
                </td>
                {visible.closingValue && (
                  <td className="r">
                    <Money
                      paise={rows.reduce((s, r) => s + r.closingValue, 0)}
                    />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <ValuationReconciliation asOn={to} />
      <StockAnalysis asOn={to} />
    </div>
  );
}

/** Godown- and batch-wise closing for one expanded item (fetched on expand). */
function ItemDetail({
  stockItemId,
  asOn,
  decimals,
  unitSymbol,
}: {
  stockItemId: number;
  asOn: string;
  decimals: number;
  unitSymbol: string;
}): React.JSX.Element {
  const nav = useNav();
  const { data: godowns, isLoading: loadingGodowns } = useQuery({
    queryKey: ["stockByGodown", asOn],
    queryFn: () => api.stock.byGodown(asOn),
  });
  const { data: batches, isLoading: loadingBatches } = useQuery({
    queryKey: ["stockBatches", asOn, stockItemId],
    queryFn: () => api.stock.batches(asOn, stockItemId),
  });
  const { data: trail, isLoading: loadingTrail } = useQuery({
    queryKey: ["stockTrail", stockItemId, asOn],
    queryFn: () => api.stock.trail(stockItemId, asOn),
  });
  // Untracked stock lands in a null-godown bucket — showing it as a nameless row reads like a
  // rendering bug, and a breakdown with ONLY that bucket adds nothing over the summary row.
  const godownRows = (godowns ?? []).filter(
    (g) =>
      g.stockItemId === stockItemId &&
      g.closingQtyMilli !== 0 &&
      g.godownId !== null,
  );
  const batchRows = (batches ?? []).filter((b) => b.closingQtyMilli !== 0);
  if (loadingGodowns || loadingBatches || loadingTrail)
    return (
      <p className="px-6 py-2 text-[12px] text-muted">Loading breakdown…</p>
    );
  if (
    godownRows.length === 0 &&
    batchRows.length === 0 &&
    (trail?.length ?? 0) === 0
  ) {
    return (
      <p className="px-6 py-2 text-[12px] text-muted">
        No godown or batch breakdown for this item.
      </p>
    );
  }
  return (
    <div
      className="flex flex-wrap gap-8 px-6 py-2"
      data-testid="stock-item-detail"
    >
      {godownRows.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
            By godown
          </p>
          {godownRows.map((g) => (
            <p key={`${g.godownId}`} className="num text-[12.5px]">
              {g.godownName}: {fmtQty(g.closingQtyMilli, decimals)} {unitSymbol}{" "}
              · <Money paise={g.closingValue} />
            </p>
          ))}
        </div>
      )}
      {batchRows.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
            By batch
          </p>
          {batchRows.map((b) => (
            <p key={b.batchId} className="num text-[12.5px]">
              {b.batchName}: {fmtQty(b.closingQtyMilli, decimals)} {unitSymbol}
              {b.expiryDate ? ` · expires ${toDisplayDate(b.expiryDate)}` : ""}
            </p>
          ))}
        </div>
      )}
      {(trail?.length ?? 0) > 0 && (
        <div className="w-full border-t border-line pt-2">
          <p className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
            Movement trail · click to open source voucher
          </p>
          <div className="max-h-52 overflow-auto rounded border border-line">
            <table className="ledger-table" data-testid="rows-stock-trail">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Party / location</th>
                  <th className="r">Movement</th>
                  <th className="r">Running qty</th>
                  <th className="r">Running value</th>
                </tr>
              </thead>
              <tbody>
                {trail!.map((movement) => (
                  <tr
                    key={movement.lineId}
                    data-row-id={movement.voucherId}
                    className="kbar-row cursor-pointer"
                    onClick={() =>
                      nav.go({
                        name: "voucher-entry",
                        voucherId: movement.voucherId,
                      })
                    }
                  >
                    <td className="num text-muted">
                      {toDisplayDate(movement.date)}
                    </td>
                    <td>
                      {movement.voucherType}{" "}
                      <span className="num text-muted">{movement.number}</span>
                      {movement.isAbsolute ? " · count" : ""}
                    </td>
                    <td className="text-muted">
                      {[
                        movement.partyName,
                        movement.godownName,
                        movement.batchName,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td
                      className={`r num ${movement.direction === "out" && !movement.isAbsolute ? "text-cr" : "text-dr"}`}
                    >
                      {movement.direction === "out" && !movement.isAbsolute
                        ? "−"
                        : "+"}
                      {fmtQty(movement.qtyMilli, decimals)}
                    </td>
                    <td className="r num">
                      {fmtQty(movement.runningQtyMilli, decimals)} {unitSymbol}
                    </td>
                    <td className="r">
                      <Money paise={movement.runningValue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ValuationReconciliation({
  asOn,
}: {
  asOn: string;
}): React.JSX.Element | null {
  const { data } = useQuery({
    queryKey: ["stockReconciliation", asOn],
    queryFn: () => api.stock.reconcile(asOn),
  });
  if (!data) return null;
  const clean = data.difference === 0;
  return (
    <Panel
      className={`mt-4 flex items-center justify-between gap-5 px-4 py-3 ${clean ? "" : "border-cr/60 bg-cr/5"}`}
    >
      <div>
        <p className="text-[12.5px] font-semibold">
          Stock-to-Balance-Sheet reconciliation
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted">
          {data.mode === "computed_closing_stock"
            ? "Balance Sheet uses the same computed closing-stock valuation."
            : `Balance Sheet uses ${data.carryingLedgerCount} carrying Stock-in-Hand ledger${data.carryingLedgerCount === 1 ? "" : "s"}.`}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-6 text-right">
        <div>
          <p className="text-[10px] text-muted uppercase">Stock report</p>
          <Money
            paise={data.inventoryValue}
            className="text-[12.5px] font-medium"
          />
        </div>
        <div>
          <p className="text-[10px] text-muted uppercase">Balance Sheet</p>
          <Money
            paise={data.financialStatementValue}
            className="text-[12.5px] font-medium"
          />
        </div>
        <div>
          <p className="text-[10px] text-muted uppercase">Difference</p>
          <Money
            paise={data.difference}
            signed
            className={`text-[12.5px] font-semibold ${clean ? "text-dr" : "text-cr"}`}
          />
        </div>
      </div>
    </Panel>
  );
}

/** Stock analysis (v0.3 #58): age of the held quantity, slow movers, reorder breaches. */
function StockAnalysis({ asOn }: { asOn: string }): React.JSX.Element | null {
  const { data } = useQuery({
    queryKey: ["stockAgeing", asOn],
    queryFn: ({ signal }) => api.reports.stockAgeing(asOn, signal),
  });
  const rows = (data ?? []).filter(
    (r) => r.closingQtyMilli > 0 || r.belowReorder,
  );
  if (rows.length === 0) return null;
  return (
    <Panel className="mt-4">
      <p className="mb-2 px-1 text-[13.5px] font-medium">
        Stock analysis — ageing &amp; reorder
      </p>
      <table className="ledger-table" data-testid="stock-ageing-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r w-24">0–30 d</th>
            <th className="r w-24">31–60 d</th>
            <th className="r w-24">61–90 d</th>
            <th className="r w-24">90+ d</th>
            <th className="w-44">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stockItemId}>
              <td>{r.name}</td>
              {r.buckets.map((b, i) => (
                <td key={i} className="r num">
                  {b === 0 ? "–" : `${fmtQty(b, r.decimals)} ${r.unitSymbol}`}
                </td>
              ))}
              <td>
                {r.belowReorder && (
                  <span className="mr-2 text-[11.5px] text-cr">reorder</span>
                )}
                {r.slowMoving && (
                  <span className="text-[11.5px] text-muted">slow-moving</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
