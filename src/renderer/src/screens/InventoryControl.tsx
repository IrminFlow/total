import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import type {
  InventoryActionItem,
  InventoryPlannerRow,
  InventoryPlanningInput,
  StockCountSession,
} from "@shared/inventoryControl";
import { useSession, useToasts } from "../state/stores";
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
} from "../components/ui";
import { toDisplayDate } from "@shared/dates";

type Tab =
  | "plan"
  | "reservations"
  | "transfers"
  | "counts"
  | "production"
  | "trace"
  | "actions";
const qty = (value: number, decimals = 0): string =>
  (value / 1000).toFixed(decimals);
const asMilli = (value: string): number =>
  Math.max(0, Math.round((Number(value) || 0) * 1000));
const riskTone: Record<InventoryPlannerRow["risk"], string> = {
  stockout: "border-cr/35 bg-cr/8 text-cr",
  reorder: "border-amber/40 bg-amber/8 text-ink",
  excess: "border-blue-400/30 bg-blue-400/8 text-blue-700 dark:text-blue-300",
  healthy: "border-dr/25 bg-dr/5 text-dr",
};

export function InventoryControlScreen(): React.JSX.Element {
  const { to } = useSession();
  const [tab, setTab] = useState<Tab>("plan");
  const [policy, setPolicy] = useState<InventoryPlannerRow | null>(null);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [bomOpen, setBomOpen] = useState(false);
  const [manufactureOpen, setManufactureOpen] = useState(false);
  const [actionItem, setActionItem] = useState<InventoryPlannerRow | null>(
    null,
  );
  const planner = useQuery({
    queryKey: ["inventoryPlanner", to],
    queryFn: () => api.inventoryControl.planner(to),
  });
  const rows = planner.data ?? [];
  const metrics = [
    [
      "At risk",
      rows.filter((r) => r.risk === "stockout" || r.risk === "reorder").length,
      "items need supply",
    ],
    [
      "Committed",
      rows.reduce((s, r) => s + r.reservedQtyMilli, 0) / 1000,
      "units reserved",
    ],
    [
      "Incoming",
      rows.reduce((s, r) => s + r.openPoQtyMilli, 0) / 1000,
      "units on open POs",
    ],
    [
      "Excess",
      rows.filter((r) => r.risk === "excess").length,
      "items need action",
    ],
  ] as const;
  const tabs: { key: Tab; label: string }[] = [
    { key: "plan", label: "Plan" },
    { key: "reservations", label: "Reservations" },
    { key: "transfers", label: "Transfers" },
    { key: "counts", label: "Cycle counts" },
    { key: "production", label: "Production" },
    { key: "trace", label: "Trace & labels" },
    { key: "actions", label: "Action log" },
  ];
  return (
    <div className="mx-auto max-w-7xl" data-testid="inventory-control">
      <SectionTitle
        right={
          <div className="flex rounded-md border border-line bg-panel p-0.5">
            {tabs.map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`rounded px-3 py-1.5 text-[11px] ${tab === item.key ? "bg-ink font-semibold text-canvas" : "text-muted hover:text-ink"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      >
        Inventory control
      </SectionTitle>
      <div className="mb-3 grid grid-cols-4 gap-3">
        {metrics.map(([label, value, caption]) => (
          <Panel key={label} className="px-4 py-3">
            <p className="text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
              {label}
            </p>
            <p className="mt-2 font-mono text-[22px] font-semibold">{value}</p>
            <p className="mt-1 text-[10px] text-muted">
              {caption} · {toDisplayDate(to)}
            </p>
          </Panel>
        ))}
      </div>
      {tab === "plan" && (
        <Planner
          rows={rows}
          loading={planner.isLoading}
          onPolicy={setPolicy}
          onReserve={() => setReserveOpen(true)}
          onAction={setActionItem}
        />
      )}
      {tab === "reservations" && (
        <Reservations onCreate={() => setReserveOpen(true)} />
      )}
      {tab === "counts" && <Counts onCreate={() => setCountOpen(true)} />}
      {tab === "transfers" && (
        <Transfers onCreate={() => setTransferOpen(true)} />
      )}
      {tab === "production" && (
        <Production
          onBom={() => setBomOpen(true)}
          onOrder={() => setManufactureOpen(true)}
        />
      )}
      {tab === "trace" && <Traceability />}
      {tab === "actions" && (
        <Actions onCreate={() => setActionItem(rows[0] ?? null)} />
      )}
      {policy && <PolicyModal row={policy} onClose={() => setPolicy(null)} />}
      {reserveOpen && (
        <ReservationModal asOn={to} onClose={() => setReserveOpen(false)} />
      )}
      {countOpen && (
        <CountModal asOn={to} onClose={() => setCountOpen(false)} />
      )}
      {transferOpen && (
        <TransferModal asOn={to} onClose={() => setTransferOpen(false)} />
      )}
      {bomOpen && <BomModal asOn={to} onClose={() => setBomOpen(false)} />}
      {manufactureOpen && (
        <ManufacturingModal
          asOn={to}
          onClose={() => setManufactureOpen(false)}
        />
      )}
      {actionItem && (
        <ActionModal row={actionItem} onClose={() => setActionItem(null)} />
      )}
    </div>
  );
}

function Planner({
  rows,
  loading,
  onPolicy,
  onReserve,
  onAction,
}: {
  rows: InventoryPlannerRow[];
  loading: boolean;
  onPolicy: (row: InventoryPlannerRow) => void;
  onReserve: () => void;
  onAction: (row: InventoryPlannerRow) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Panel className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-semibold">Supply decision desk</p>
          <p className="mt-1 text-[10.5px] text-muted">
            Available = on hand − reservations. Suggested orders net open POs
            and cover lead-time demand plus safety stock.
          </p>
        </div>
        <Button variant="primary" onClick={onReserve}>
          Reserve stock
        </Button>
      </Panel>
      <Panel className="overflow-hidden p-0">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={8} />
          </div>
        ) : !rows.length ? (
          <EmptyState title="No stock items yet" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Signal</th>
                <th className="r">On hand</th>
                <th className="r">Reserved</th>
                <th className="r">Available</th>
                <th className="r">Open PO</th>
                <th className="r">30-day demand</th>
                <th className="r">Cover</th>
                <th className="r">Order now</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.stockItemId}
                  data-testid={`planner-row-${row.stockItemId}`}
                >
                  <td>
                    <p className="font-medium">{row.name}</p>
                    <p className="mt-0.5 text-[9px] text-muted">
                      {row.preferredSupplierName ?? "No preferred supplier"} ·{" "}
                      {row.leadTimeDays}d lead
                    </p>
                  </td>
                  <td>
                    <span
                      className={`rounded border px-2 py-1 text-[9px] font-semibold uppercase ${riskTone[row.risk]}`}
                    >
                      {row.risk}
                    </span>
                  </td>
                  <td className="r num">
                    {qty(row.closingQtyMilli, row.decimals)}
                  </td>
                  <td className="r num">
                    {qty(row.reservedQtyMilli, row.decimals)}
                  </td>
                  <td
                    className={`r num ${row.availableQtyMilli < 0 ? "text-cr" : ""}`}
                  >
                    {qty(row.availableQtyMilli, row.decimals)}
                  </td>
                  <td className="r num">
                    {qty(row.openPoQtyMilli, row.decimals)}
                  </td>
                  <td className="r num">
                    {qty(row.forecast30DayMilli, row.decimals)}
                  </td>
                  <td className="r num">
                    {row.daysCover == null
                      ? "—"
                      : `${row.daysCover.toFixed(0)}d`}
                  </td>
                  <td className="r num font-semibold">
                    {row.suggestedOrderMilli
                      ? `${qty(row.suggestedOrderMilli, row.decimals)} ${row.unitSymbol}`
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="ghost" onClick={() => onPolicy(row)}>
                      Policy
                    </Button>
                    {row.risk !== "healthy" && (
                      <Button variant="ghost" onClick={() => onAction(row)}>
                        Act
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function PolicyModal({
  row,
  onClose,
}: {
  row: InventoryPlannerRow;
  onClose: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const suppliers = useQuery({
    queryKey: ["ledgers"],
    queryFn: api.ledgers.list,
  });
  const [value, setValue] = useState<InventoryPlanningInput>({
    stockItemId: row.stockItemId,
    leadTimeDays: row.leadTimeDays,
    safetyStockMilli: row.safetyStockMilli,
    reorderQtyMilli: row.reorderQtyMilli,
    preferredSupplierLedgerId: row.preferredSupplierLedgerId,
    forecastMethod: row.forecastMethod,
  });
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.savePlanning(value);
      await qc.invalidateQueries({ queryKey: ["inventoryPlanner"] });
      toast.push("success", `${row.name} policy saved`);
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title={`Planning policy · ${row.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Lead time (days)">
            <TextInput
              type="number"
              value={value.leadTimeDays}
              onChange={(e) =>
                setValue({
                  ...value,
                  leadTimeDays: Number(e.target.value) || 0,
                })
              }
            />
          </Field>
          <Field label={`Safety stock (${row.unitSymbol})`}>
            <TextInput
              type="number"
              value={value.safetyStockMilli / 1000}
              onChange={(e) =>
                setValue({
                  ...value,
                  safetyStockMilli: asMilli(e.target.value),
                })
              }
            />
          </Field>
          <Field label={`Minimum order (${row.unitSymbol})`}>
            <TextInput
              type="number"
              value={value.reorderQtyMilli / 1000}
              onChange={(e) =>
                setValue({ ...value, reorderQtyMilli: asMilli(e.target.value) })
              }
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Forecast method">
            <Select
              value={value.forecastMethod}
              onChange={(e) =>
                setValue({
                  ...value,
                  forecastMethod: e.target
                    .value as InventoryPlanningInput["forecastMethod"],
                })
              }
            >
              <option value="velocity">90-day velocity</option>
              <option value="seasonal">Prior-year season</option>
              <option value="manual">Reviewed monthly forecast</option>
            </Select>
          </Field>
          <Field label="Preferred supplier">
            <Select
              value={value.preferredSupplierLedgerId ?? ""}
              onChange={(e) =>
                setValue({
                  ...value,
                  preferredSupplierLedgerId: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            >
              <option value="">Not assigned</option>
              {suppliers.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save policy
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Reservations({
  onCreate,
}: {
  onCreate: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const q = useQuery({
    queryKey: ["inventoryReservations"],
    queryFn: api.inventoryControl.reservations,
  });
  const resolve = async (
    id: number,
    status: "fulfilled" | "released",
  ): Promise<void> => {
    try {
      await api.inventoryControl.setReservationStatus(id, status);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryReservations"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
      ]);
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <p className="text-[12px] font-semibold">Customer commitments</p>
          <p className="text-[10px] text-muted">
            Reservations reduce promiseable stock without posting a voucher.
          </p>
        </div>
        <Button variant="primary" onClick={onCreate}>
          New reservation
        </Button>
      </div>
      {q.isLoading ? (
        <div className="p-4">
          <SkeletonRows />
        </div>
      ) : !q.data?.length ? (
        <EmptyState title="No stock reservations" />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Required</th>
              <th>Reference</th>
              <th>Item</th>
              <th>Location</th>
              <th className="r">Quantity</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id}>
                <td className="num">{toDisplayDate(r.requiredDate)}</td>
                <td>
                  {r.reference}
                  <p className="text-[9px] text-muted">
                    {r.customerName ?? "Unassigned customer"}
                  </p>
                </td>
                <td>{r.itemName}</td>
                <td>{r.godownName ?? "Company-wide"}</td>
                <td className="r num">
                  {qty(r.qtyMilli)} {r.unitSymbol}
                </td>
                <td className="capitalize">{r.status}</td>
                <td className="text-right">
                  {r.status === "active" && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => void resolve(r.id, "fulfilled")}
                      >
                        Fulfil
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void resolve(r.id, "released")}
                      >
                        Release
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ReservationModal({
  asOn,
  onClose,
}: {
  asOn: string;
  onClose: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const items = useQuery({
    queryKey: ["stockItems"],
    queryFn: api.stockItems.list,
  });
  const godowns = useQuery({
    queryKey: ["godowns"],
    queryFn: api.godowns.list,
  });
  const ledgers = useQuery({
    queryKey: ["ledgers"],
    queryFn: api.ledgers.list,
  });
  const [itemId, setItem] = useState(0);
  const [godownId, setGodown] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [customer, setCustomer] = useState<number | null>(null);
  const selected = itemId || items.data?.[0]?.id || 0;
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.createReservation({
        stockItemId: selected,
        godownId,
        batchId: null,
        qtyMilli: asMilli(amount),
        requiredDate: asOn,
        reference,
        customerLedgerId: customer,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryReservations"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
      ]);
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="Reserve stock" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Item">
            <Select
              value={selected}
              onChange={(e) => setItem(Number(e.target.value))}
            >
              {items.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Godown">
            <Select
              value={godownId ?? ""}
              onChange={(e) =>
                setGodown(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">Company-wide</option>
              {godowns.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity">
            <TextInput
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Sales order / promise">
            <TextInput
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Customer (optional)">
          <Select
            value={customer ?? ""}
            onChange={(e) =>
              setCustomer(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Not assigned</option>
            {ledgers.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected || !reference.trim() || asMilli(amount) <= 0}
            onClick={() => void save()}
          >
            Reserve
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Counts({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const q = useQuery({
    queryKey: ["inventoryCounts"],
    queryFn: api.inventoryControl.counts,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const row = q.data?.find((r) => r.id === selected) ?? q.data?.[0];
  return (
    <div className="grid grid-cols-[320px_1fr] gap-3">
      <Panel className="p-0">
        <div className="flex items-center justify-between border-b border-line p-3">
          <p className="text-[12px] font-semibold">Count sessions</p>
          <Button variant="primary" onClick={onCreate}>
            New
          </Button>
        </div>
        {q.isLoading ? (
          <div className="p-3">
            <SkeletonRows />
          </div>
        ) : !q.data?.length ? (
          <EmptyState title="No cycle counts" />
        ) : (
          q.data.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`block w-full border-b border-line px-3 py-2.5 text-left ${row?.id === s.id ? "bg-amber/8 shadow-[inset_3px_0_0_var(--t-amberbar)]" : "hover:bg-panel2"}`}
            >
              <span className="text-[11px] font-semibold">{s.name}</span>
              <span className="float-right text-[9px] uppercase text-muted">
                {s.status}
              </span>
              <span className="mt-1 block text-[9.5px] text-muted">
                {s.godownName} · {toDisplayDate(s.countDate)}
              </span>
            </button>
          ))
        )}
      </Panel>
      {row ? (
        <CountDetail session={row} />
      ) : (
        <Panel>
          <EmptyState title="Select a count session" />
        </Panel>
      )}
    </div>
  );
}

function CountDetail({
  session,
}: {
  session: StockCountSession;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const [values, setValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      session.lines.map((l) => [
        l.id,
        l.countedQtyMilli == null ? "" : String(l.countedQtyMilli / 1000),
      ]),
    ),
  );
  const editable = ["draft", "counting"].includes(session.status);
  const saveLine = async (lineId: number): Promise<void> => {
    const value = values[lineId];
    if (!value) return;
    try {
      await api.inventoryControl.saveCountLine({
        sessionId: session.id,
        lineId,
        countedQtyMilli: asMilli(value),
        note: null,
      });
      await qc.invalidateQueries({ queryKey: ["inventoryCounts"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const status = async (
    next: "review" | "posted" | "cancelled",
  ): Promise<void> => {
    try {
      await api.inventoryControl.setCountStatus(session.id, next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryCounts"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
        qc.invalidateQueries({ queryKey: ["stockSummary"] }),
      ]);
      toast.push(
        "success",
        next === "posted" ? "Count posted to stock" : "Count status updated",
      );
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex items-start justify-between border-b border-line p-4">
        <div>
          <p className="text-[13px] font-semibold">{session.name}</p>
          <p className="mt-1 text-[10px] text-muted">
            {session.godownName} ·{" "}
            {session.blindCount ? "Blind count" : "Visible expected"} ·{" "}
            {session.lines.length} items
          </p>
        </div>
        <div className="flex gap-2">
          {editable && (
            <Button onClick={() => void status("cancelled")}>Cancel</Button>
          )}
          {editable && (
            <Button variant="primary" onClick={() => void status("review")}>
              Submit review
            </Button>
          )}
          {session.status === "review" && (
            <Button variant="primary" onClick={() => void status("posted")}>
              Post adjustment
            </Button>
          )}
        </div>
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Item</th>
            {!session.blindCount && <th className="r">Expected</th>}
            <th className="r">Counted</th>
            <th className="r">Variance</th>
          </tr>
        </thead>
        <tbody>
          {session.lines.map((line) => {
            const entered = values[line.id];
            const current = entered ? asMilli(entered) : line.countedQtyMilli;
            return (
              <tr key={line.id}>
                <td>{line.itemName}</td>
                {!session.blindCount && (
                  <td className="r num">
                    {qty(line.expectedQtyMilli, line.decimals)}
                  </td>
                )}
                <td className="r">
                  {editable ? (
                    <TextInput
                      className="ml-auto w-28 text-right font-mono"
                      type="number"
                      value={entered ?? ""}
                      onChange={(e) =>
                        setValues({ ...values, [line.id]: e.target.value })
                      }
                      onBlur={() => void saveLine(line.id)}
                    />
                  ) : (
                    <span className="num">
                      {current == null ? "—" : qty(current, line.decimals)}
                    </span>
                  )}
                </td>
                <td
                  className={`r num ${current != null && current !== line.expectedQtyMilli ? "text-cr" : ""}`}
                >
                  {current == null
                    ? "—"
                    : qty(current - line.expectedQtyMilli, line.decimals)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function CountModal({
  asOn,
  onClose,
}: {
  asOn: string;
  onClose: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const godowns = useQuery({
    queryKey: ["godowns"],
    queryFn: api.godowns.list,
  });
  const [name, setName] = useState("");
  const [godown, setGodown] = useState(0);
  const selected = godown || godowns.data?.[0]?.id || 0;
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.createCount({
        name,
        countDate: asOn,
        godownId: selected,
        blindCount: true,
      });
      await qc.invalidateQueries({ queryKey: ["inventoryCounts"] });
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="Start cycle count" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Count name">
          <TextInput
            placeholder="West warehouse · aisle A"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Godown">
          <Select
            value={selected}
            onChange={(e) => setGodown(Number(e.target.value))}
          >
            {godowns.data?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded border border-line bg-panel2 p-3 text-[10px] text-muted">
          Blind count is on. Expected quantities stay hidden from the counter
          and appear at review.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !selected}
            onClick={() => void save()}
          >
            Create count
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Transfers({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const q = useQuery({
    queryKey: ["inventoryTransfers"],
    queryFn: api.inventoryControl.transfers,
  });
  const qc = useQueryClient();
  const toast = useToasts();
  const move = async (
    id: number,
    status: "dispatched" | "received" | "cancelled",
  ): Promise<void> => {
    try {
      await api.inventoryControl.setTransferStatus(id, status);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryTransfers"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
      ]);
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line p-3">
        <div>
          <p className="text-[12px] font-semibold">
            Godown transfers & in-transit stock
          </p>
          <p className="text-[10px] text-muted">
            Dispatch removes source availability; receipt restores the same
            carrying value at destination.
          </p>
        </div>
        <Button variant="primary" onClick={onCreate}>
          New transfer
        </Button>
      </div>
      {q.isLoading ? (
        <div className="p-4">
          <SkeletonRows />
        </div>
      ) : !q.data?.length ? (
        <EmptyState title="No stock transfers" />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Transfer</th>
              <th>Route</th>
              <th>Items</th>
              <th>Expected</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.id}>
                <td className="num">{toDisplayDate(t.transferDate)}</td>
                <td className="font-medium">{t.transferNo}</td>
                <td>
                  {t.fromGodownName} → {t.toGodownName}
                </td>
                <td>
                  {t.lines
                    .map(
                      (l) =>
                        `${l.itemName} · ${qty(l.qtyMilli)} ${l.unitSymbol}`,
                    )
                    .join(", ")}
                </td>
                <td>
                  {t.expectedArrival ? toDisplayDate(t.expectedArrival) : "—"}
                </td>
                <td className="capitalize">
                  {t.status === "dispatched" ? "In transit" : t.status}
                </td>
                <td className="text-right">
                  {t.status === "draft" && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => void move(t.id, "cancelled")}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => void move(t.id, "dispatched")}
                      >
                        Dispatch
                      </Button>
                    </>
                  )}
                  {t.status === "dispatched" && (
                    <Button
                      variant="primary"
                      onClick={() => void move(t.id, "received")}
                    >
                      Receive
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function TransferModal({
  asOn,
  onClose,
}: {
  asOn: string;
  onClose: () => void;
}): React.JSX.Element {
  const items = useQuery({
    queryKey: ["stockItems"],
    queryFn: api.stockItems.list,
  });
  const godowns = useQuery({
    queryKey: ["godowns"],
    queryFn: api.godowns.list,
  });
  const qc = useQueryClient();
  const toast = useToasts();
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [item, setItem] = useState(0);
  const [amount, setAmount] = useState("");
  const fromId = from || godowns.data?.[0]?.id || 0;
  const toId = to || godowns.data?.find((g) => g.id !== fromId)?.id || 0;
  const itemId = item || items.data?.[0]?.id || 0;
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.createTransfer({
        transferDate: asOn,
        fromGodownId: fromId,
        toGodownId: toId,
        expectedArrival: asOn,
        note: null,
        lines: [
          { stockItemId: itemId, batchId: null, qtyMilli: asMilli(amount) },
        ],
      });
      await qc.invalidateQueries({ queryKey: ["inventoryTransfers"] });
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="New godown transfer" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From godown">
            <Select
              value={fromId}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {godowns.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To godown">
            <Select
              value={toId}
              onChange={(e) => setTo(Number(e.target.value))}
            >
              {godowns.data
                ?.filter((g) => g.id !== fromId)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Item">
            <Select
              value={itemId}
              onChange={(e) => setItem(Number(e.target.value))}
            >
              {items.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quantity">
            <TextInput
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              !fromId ||
              !toId ||
              fromId === toId ||
              !itemId ||
              asMilli(amount) <= 0
            }
            onClick={() => void save()}
          >
            Create transfer
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Production({
  onBom,
  onOrder,
}: {
  onBom: () => void;
  onOrder: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const boms = useQuery({
    queryKey: ["inventoryBomVersions"],
    queryFn: () => api.inventoryControl.bomVersions(),
  });
  const orders = useQuery({
    queryKey: ["inventoryManufacturing"],
    queryFn: api.inventoryControl.manufacturingOrders,
  });
  const activate = async (id: number): Promise<void> => {
    try {
      await api.inventoryControl.activateBomVersion(id);
      await qc.invalidateQueries({ queryKey: ["inventoryBomVersions"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const status = async (
    id: number,
    next: "released" | "completed" | "cancelled",
  ): Promise<void> => {
    try {
      await api.inventoryControl.setManufacturingStatus(id, next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryManufacturing"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
      ]);
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <Panel className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-line p-3">
          <div>
            <p className="text-[12px] font-semibold">Effective BOM revisions</p>
            <p className="text-[10px] text-muted">
              Immutable formula history with cycle checks.
            </p>
          </div>
          <Button variant="primary" onClick={onBom}>
            New revision
          </Button>
        </div>
        {!boms.data?.length ? (
          <EmptyState title="No BOM revisions" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Finished item</th>
                <th>Version</th>
                <th>Effective</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {boms.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.itemName}
                    <p className="text-[9px] text-muted">
                      {b.lines
                        .map(
                          (l) =>
                            `${l.componentName} × ${qty(l.qtyMilliPerUnit)}`,
                        )
                        .join(", ")}
                    </p>
                  </td>
                  <td>{b.version}</td>
                  <td>{toDisplayDate(b.effectiveFrom)}</td>
                  <td className="capitalize">{b.status}</td>
                  <td>
                    {b.status === "draft" && (
                      <Button
                        variant="ghost"
                        onClick={() => void activate(b.id)}
                      >
                        Activate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-line p-3">
          <div>
            <p className="text-[12px] font-semibold">Manufacturing orders</p>
            <p className="text-[10px] text-muted">
              Plan, release and post component-to-finished conversion.
            </p>
          </div>
          <Button variant="primary" onClick={onOrder}>
            New order
          </Button>
        </div>
        {!orders.data?.length ? (
          <EmptyState title="No manufacturing orders" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Due</th>
                <th>Order</th>
                <th>Output</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id}>
                  <td>{toDisplayDate(o.dueDate)}</td>
                  <td>
                    {o.orderNo}
                    <p className="text-[9px] text-muted">
                      BOM {o.bomVersion ?? "—"}
                    </p>
                  </td>
                  <td>
                    {o.itemName} · {qty(o.plannedQtyMilli)} {o.unitSymbol}
                  </td>
                  <td className="capitalize">{o.status}</td>
                  <td className="text-right">
                    {o.status === "planned" && (
                      <Button
                        variant="primary"
                        onClick={() => void status(o.id, "released")}
                      >
                        Release
                      </Button>
                    )}
                    {o.status === "released" && (
                      <Button
                        variant="primary"
                        onClick={() => void status(o.id, "completed")}
                      >
                        Complete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function BomModal({
  asOn,
  onClose,
}: {
  asOn: string;
  onClose: () => void;
}): React.JSX.Element {
  const items = useQuery({
    queryKey: ["stockItems"],
    queryFn: api.stockItems.list,
  });
  const qc = useQueryClient();
  const toast = useToasts();
  const [finished, setFinished] = useState(0);
  const [component, setComponent] = useState(0);
  const [version, setVersion] = useState("1.0");
  const [amount, setAmount] = useState("1");
  const itemId = finished || items.data?.[0]?.id || 0;
  const componentId =
    component || items.data?.find((i) => i.id !== itemId)?.id || 0;
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.createBomVersion({
        itemId,
        version,
        effectiveFrom: asOn,
        effectiveTo: null,
        note: null,
        lines: [{ componentId, qtyMilliPerUnit: asMilli(amount), scrapPct: 0 }],
      });
      await qc.invalidateQueries({ queryKey: ["inventoryBomVersions"] });
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="New BOM revision" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Finished item">
            <Select
              value={itemId}
              onChange={(e) => setFinished(Number(e.target.value))}
            >
              {items.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Version">
            <TextInput
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Component">
            <Select
              value={componentId}
              onChange={(e) => setComponent(Number(e.target.value))}
            >
              {items.data
                ?.filter((i) => i.id !== itemId)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Quantity per output unit">
            <TextInput
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!itemId || !componentId || !version.trim()}
            onClick={() => void save()}
          >
            Save draft
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ManufacturingModal({
  asOn,
  onClose,
}: {
  asOn: string;
  onClose: () => void;
}): React.JSX.Element {
  const boms = useQuery({
    queryKey: ["inventoryBomVersions"],
    queryFn: () => api.inventoryControl.bomVersions(),
  });
  const godowns = useQuery({
    queryKey: ["godowns"],
    queryFn: api.godowns.list,
  });
  const qc = useQueryClient();
  const toast = useToasts();
  const active = boms.data?.filter((b) => b.status === "active") ?? [];
  const [bomId, setBom] = useState(0);
  const [godown, setGodown] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const selected = active.find((b) => b.id === (bomId || active[0]?.id));
  const save = async (): Promise<void> => {
    if (!selected) return;
    try {
      await api.inventoryControl.createManufacturingOrder({
        stockItemId: selected.itemId,
        plannedQtyMilli: asMilli(amount),
        dueDate: asOn,
        godownId: godown,
        bomVersionId: selected.id,
        note: null,
      });
      await qc.invalidateQueries({ queryKey: ["inventoryManufacturing"] });
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="Plan manufacturing order" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Active BOM">
          <Select
            value={selected?.id ?? ""}
            onChange={(e) => setBom(Number(e.target.value))}
          >
            {active.map((b) => (
              <option key={b.id} value={b.id}>
                {b.itemName} · v{b.version}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Output quantity">
            <TextInput
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Production godown">
            <Select
              value={godown ?? ""}
              onChange={(e) =>
                setGodown(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">Company-wide</option>
              {godowns.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected || asMilli(amount) <= 0}
            onClick={() => void save()}
          >
            Create order
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Traceability(): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const items = useQuery({
    queryKey: ["stockItems"],
    queryFn: api.stockItems.list,
  });
  const serials = useQuery({
    queryKey: ["inventorySerials"],
    queryFn: () => api.inventoryControl.serials(),
  });
  const costs = useQuery({
    queryKey: ["inventoryLandedCosts"],
    queryFn: api.inventoryControl.landedCosts,
  });
  const [labelItem, setLabelItem] = useState(0);
  const [copies, setCopies] = useState("24");
  const [lineId, setLineId] = useState("");
  const [serialText, setSerialText] = useState("");
  const [sourceVoucher, setSourceVoucher] = useState("");
  const [costLine, setCostLine] = useState("");
  const [cost, setCost] = useState("");
  const selected = labelItem || items.data?.find((i) => i.barcode)?.id || 0;
  const labels = async (): Promise<void> => {
    try {
      const result = await api.inventoryControl.barcodeLabelsPdf([
        { stockItemId: selected, copies: Number(copies) || 1 },
      ]);
      toast.push(
        "success",
        `Label sheet ready · ${result.path.split("/").pop()}`,
      );
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const assign = async (): Promise<void> => {
    try {
      const values = serialText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.inventoryControl.assignSerials({
        inventoryLineId: Number(lineId),
        serials: values.map((serialNo) => ({
          serialNo,
          warrantyUntil: null,
          note: null,
        })),
      });
      setSerialText("");
      await qc.invalidateQueries({ queryKey: ["inventorySerials"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const landed = async (): Promise<void> => {
    try {
      await api.inventoryControl.addLandedCost({
        sourceVoucherId: Number(sourceVoucher),
        inventoryLineId: Number(costLine),
        costLedgerId: null,
        amount: Math.round((Number(cost) || 0) * 100),
        method: "manual",
        note: "Reviewed landed cost",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inventoryLandedCosts"] }),
        qc.invalidateQueries({ queryKey: ["inventoryPlanner"] }),
      ]);
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <div className="grid grid-cols-[1fr_360px] gap-3">
      <div className="space-y-3">
        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line p-3">
            <p className="text-[12px] font-semibold">
              Serialized unit register
            </p>
            <p className="text-[10px] text-muted">
              Current custody is derived from the last linked inventory
              movement.
            </p>
          </div>
          {!serials.data?.length ? (
            <EmptyState title="No serial numbers assigned" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Serial</th>
                  <th>Batch</th>
                  <th>Location</th>
                  <th>Warranty</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {serials.data.map((s) => (
                  <tr key={s.id}>
                    <td>{s.itemName}</td>
                    <td className="font-mono">{s.serialNo}</td>
                    <td>{s.batchName ?? "—"}</td>
                    <td>{s.godownName ?? "—"}</td>
                    <td>
                      {s.warrantyUntil ? toDisplayDate(s.warrantyUntil) : "—"}
                    </td>
                    <td className="capitalize">{s.state.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line p-3">
            <p className="text-[12px] font-semibold">Landed cost evidence</p>
          </div>
          {!costs.data?.length ? (
            <EmptyState title="No landed costs allocated" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Item</th>
                  <th>Method</th>
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {costs.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sourceNumber}</td>
                    <td>{c.itemName}</td>
                    <td className="capitalize">{c.method}</td>
                    <td className="r num">₹{(c.amount / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <div className="space-y-3">
        <Panel>
          <p className="text-[12px] font-semibold">Print barcode / QR labels</p>
          <p className="mt-1 text-[10px] text-muted">
            A4 sheet, 24 warehouse-ready labels per page.
          </p>
          <div className="mt-3 space-y-2">
            <Field label="Item">
              <Select
                value={selected}
                onChange={(e) => setLabelItem(Number(e.target.value))}
              >
                {items.data
                  ?.filter((i) => i.barcode)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {i.barcode}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Copies">
              <TextInput
                type="number"
                value={copies}
                onChange={(e) => setCopies(e.target.value)}
              />
            </Field>
            <Button
              className="w-full"
              variant="primary"
              disabled={!selected}
              onClick={() => void labels()}
            >
              Create label PDF
            </Button>
          </div>
        </Panel>
        <Panel>
          <p className="text-[12px] font-semibold">
            Assign serials to movement
          </p>
          <div className="mt-3 space-y-2">
            <Field label="Inventory line ID">
              <TextInput
                type="number"
                value={lineId}
                onChange={(e) => setLineId(e.target.value)}
              />
            </Field>
            <Field label="Serials (comma or new line)">
              <TextInput
                value={serialText}
                onChange={(e) => setSerialText(e.target.value)}
              />
            </Field>
            <Button className="w-full" onClick={() => void assign()}>
              Assign serials
            </Button>
          </div>
        </Panel>
        <Panel>
          <p className="text-[12px] font-semibold">Load landed cost</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label="Source voucher ID">
              <TextInput
                type="number"
                value={sourceVoucher}
                onChange={(e) => setSourceVoucher(e.target.value)}
              />
            </Field>
            <Field label="Inward line ID">
              <TextInput
                type="number"
                value={costLine}
                onChange={(e) => setCostLine(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-2">
            <Field label="Cost (₹)">
              <TextInput
                type="number"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </Field>
          </div>
          <Button className="mt-2 w-full" onClick={() => void landed()}>
            Allocate cost
          </Button>
        </Panel>
      </div>
    </div>
  );
}

function Actions({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["inventoryActions"],
    queryFn: api.inventoryControl.actions,
  });
  const update = async (
    id: number,
    status: InventoryActionItem["status"],
  ): Promise<void> => {
    await api.inventoryControl.setActionStatus(id, status);
    await qc.invalidateQueries({ queryKey: ["inventoryActions"] });
  };
  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line p-3">
        <div>
          <p className="text-[12px] font-semibold">Inventory action log</p>
          <p className="text-[10px] text-muted">
            Retained ownership and resolution for every stock intervention.
          </p>
        </div>
        <Button variant="primary" onClick={onCreate}>
          New action
        </Button>
      </div>
      {q.isLoading ? (
        <div className="p-4">
          <SkeletonRows />
        </div>
      ) : !q.data?.length ? (
        <EmptyState title="No inventory actions" />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Due</th>
              <th>Item</th>
              <th>Action</th>
              <th>Owner</th>
              <th>Decision note</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((a) => (
              <tr key={a.id}>
                <td>{a.dueDate ? toDisplayDate(a.dueDate) : "—"}</td>
                <td>{a.itemName}</td>
                <td className="capitalize">{a.action}</td>
                <td>{a.owner ?? "—"}</td>
                <td className="max-w-sm text-muted">{a.note ?? "—"}</td>
                <td className="capitalize">{a.status}</td>
                <td className="text-right">
                  {a.status === "open" && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => void update(a.id, "done")}
                      >
                        Done
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void update(a.id, "dismissed")}
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ActionModal({
  row,
  onClose,
}: {
  row: InventoryPlannerRow;
  onClose: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const toast = useToasts();
  const [action, setAction] = useState<InventoryActionItem["action"]>(
    row.risk === "excess" ? "discount" : "reorder",
  );
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const save = async (): Promise<void> => {
    try {
      await api.inventoryControl.createAction({
        stockItemId: row.stockItemId,
        action,
        dueDate: null,
        owner: owner || null,
        note: note || null,
      });
      await qc.invalidateQueries({ queryKey: ["inventoryActions"] });
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title={`Inventory action · ${row.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Action">
            <Select
              value={action}
              onChange={(e) =>
                setAction(e.target.value as InventoryActionItem["action"])
              }
            >
              <option value="reorder">Reorder</option>
              <option value="discount">Discount / markdown</option>
              <option value="transfer">Transfer</option>
              <option value="return">Return to supplier</option>
              <option value="dispose">Dispose</option>
              <option value="review">Review</option>
            </Select>
          </Field>
          <Field label="Owner">
            <TextInput
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Decision note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Add action
          </Button>
        </div>
      </div>
    </Modal>
  );
}
