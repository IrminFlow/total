import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DiscountActorRole,
  DiscountScopeKind,
  SalesRecurringScheduleInput,
} from "@shared/salesBilling";
import { formatPaise } from "@shared/money";
import { todayISO, toDisplayDate } from "@shared/dates";
import { api } from "../lib/client";
import { useSession, useToasts } from "../state/stores";
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  TextInput,
} from "../components/ui";
import { inputCls } from "../components/inputStyles";
import { ItemPicker, LedgerPicker } from "../components/pickers";
import { useStockItems } from "../components/pickerHooks";

export function BillingSchedulesModal({
  onClose,
  onOpenDrafts,
}: {
  onClose: () => void;
  onOpenDrafts: () => void;
}): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient(),
    [asOn, setAsOn] = useState(todayISO()),
    [form, setForm] = useState(false);
  const schedules = useQuery({
    queryKey: ["salesRecurring"],
    queryFn: api.salesRecurring.list,
  });
  const preview = useQuery({
    queryKey: ["salesRecurringPreview", asOn],
    queryFn: () => api.salesRecurring.preview(asOn),
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["salesRecurring"] }),
      qc.invalidateQueries({ queryKey: ["salesRecurringPreview"] }),
      qc.invalidateQueries({ queryKey: ["voucher-drafts"] }),
    ]);
  };
  const generate = async (): Promise<void> => {
    try {
      const ids = [
        ...new Set(
          (preview.data?.rows ?? [])
            .filter((row) => row.status === "ready")
            .map((row) => row.scheduleId),
        ),
      ];
      const batch = await api.salesRecurring.generate(asOn, ids);
      await refresh();
      toast.push(
        "success",
        `${batch.rows.filter((row) => row.status === "generated").length} invoice drafts prepared`,
      );
      onClose();
      onOpenDrafts();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Recurring invoice studio" onClose={onClose} wide>
      {form ? (
        <ScheduleForm
          onCancel={() => setForm(false)}
          onSaved={async () => {
            setForm(false);
            await refresh();
          }}
        />
      ) : (
        <>
          <div className="grid grid-cols-[1fr_repeat(3,150px)] gap-px overflow-hidden rounded-md border border-line bg-line">
            <div className="bg-ink p-3 text-canvas">
              <p className="text-[9px] font-semibold uppercase tracking-[.12em] text-canvas/60">
                Batch preview
              </p>
              <p className="mt-2 text-[13px] font-semibold">
                Nothing posts automatically
              </p>
            </div>
            <Stat label="Ready" value={String(preview.data?.readyCount ?? 0)} />
            <Stat
              label="Exceptions"
              value={String(preview.data?.exceptionCount ?? 0)}
            />
            <Stat
              label="Draft value"
              value={formatPaise(preview.data?.totalAmount ?? 0, {
                symbol: true,
              })}
            />
          </div>
          <div className="mt-3 flex items-end justify-between">
            <Field label="Generate through">
              <input
                type="date"
                className={inputCls}
                value={asOn}
                onChange={(event) => setAsOn(event.target.value)}
              />
            </Field>
            <Button variant="primary" onClick={() => setForm(true)}>
              New customer schedule
            </Button>
          </div>
          <Panel className="mt-3 overflow-hidden p-0">
            {!schedules.data?.length ? (
              <EmptyState
                title="No recurring invoice schedules"
                hint="Create a customer-specific billing cycle with fixed or effective price-list rates."
              />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Schedule</th>
                    <th>Customer</th>
                    <th>Cycle</th>
                    <th>Next due</th>
                    <th>Preview</th>
                    <th className="r">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.data.map((schedule) => {
                    const rows =
                      preview.data?.rows.filter(
                        (row) => row.scheduleId === schedule.id,
                      ) ?? [];
                    const exception = rows.find(
                      (row) => row.status === "exception",
                    );
                    return (
                      <tr key={schedule.id}>
                        <td>
                          <p className="font-medium">{schedule.name}</p>
                          <p className="text-[9px] text-muted">
                            {schedule.voucherTypeName}
                          </p>
                        </td>
                        <td>{schedule.partyName}</td>
                        <td className="capitalize">{schedule.cadence}</td>
                        <td className="num">
                          {toDisplayDate(schedule.nextDue)}
                        </td>
                        <td>
                          {exception ? (
                            <span
                              className="text-cr"
                              title={exception.message ?? ""}
                            >
                              Needs price
                            </span>
                          ) : rows.length ? (
                            <span className="text-dr">{rows.length} ready</span>
                          ) : (
                            <span className="text-muted">Not due</span>
                          )}
                        </td>
                        <td className="r">
                          <Money
                            paise={rows.reduce(
                              (sum, row) => sum + row.amount,
                              0,
                            )}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
          {preview.data?.rows.some((row) => row.status === "exception") && (
            <div className="mt-3 rounded-md border border-cr/25 bg-cr/5 p-3 text-[10.5px] text-cr">
              {preview.data.rows
                .filter((row) => row.status === "exception")
                .map((row) => (
                  <p key={`${row.scheduleId}-${row.dueDate}`}>
                    {row.scheduleName} · {row.message}
                  </p>
                ))}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              data-testid="btn-recurring-sales-generate"
              disabled={!preview.data?.readyCount}
              onClick={() => void generate()}
            >
              Generate reviewed drafts
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="bg-panel p-3">
      <p className="text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
        {label}
      </p>
      <p className="mt-2 truncate font-mono text-[16px] font-semibold">
        {value}
      </p>
    </div>
  );
}

function ScheduleForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const toast = useToasts(),
    items = useStockItems(),
    [name, setName] = useState(""),
    [partyLedgerId, setParty] = useState<number | null>(null),
    [itemId, setItem] = useState<number | null>(null),
    [cadence, setCadence] =
      useState<SalesRecurringScheduleInput["cadence"]>("monthly"),
    [nextDue, setNextDue] = useState(todayISO()),
    [dueDays, setDueDays] = useState(30),
    [qtyMilli, setQty] = useState(1000),
    [rateMode, setRateMode] = useState<"fixed" | "price_list">("fixed"),
    [fixedRate, setFixedRate] = useState<number | null>(null),
    [discountBps, setDiscount] = useState(0),
    [narration, setNarration] = useState("");
  const types = useQuery({
      queryKey: ["voucherTypes"],
      queryFn: api.voucherTypes.list,
    }),
    salesType = types.data?.find((row) => row.kind === "sales");
  const save = async (): Promise<void> => {
    if (
      !partyLedgerId ||
      !itemId ||
      !salesType ||
      (rateMode === "fixed" && fixedRate == null)
    )
      return;
    try {
      const item = items.find((row) => row.id === itemId)!;
      await api.salesRecurring.save({
        name,
        partyLedgerId,
        voucherTypeId: salesType.id,
        cadence,
        nextDue,
        endDate: null,
        dueDays,
        lines: [
          {
            stockItemId: itemId,
            description: item.name,
            qtyMilli,
            rateMode,
            fixedRate: rateMode === "fixed" ? fixedRate : null,
            discountBps,
          },
        ],
        narration: narration.trim() || null,
        active: true,
      });
      toast.push("success", "Recurring invoice schedule saved");
      onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <>
      <div className="mb-3 rounded-md border border-line bg-panel2 p-3">
        <p className="text-[11.5px] font-semibold">Customer billing contract</p>
        <p className="mt-1 text-[10px] text-muted">
          Each due date becomes a reviewable invoice draft. Missing price-list
          rates become exceptions, never zero-value bills.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Schedule name">
          <TextInput
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Orbit monthly support"
          />
        </Field>
        <Field label="Customer">
          <LedgerPicker value={partyLedgerId} onPick={setParty} />
        </Field>
        <Field label="Cadence">
          <Select
            value={cadence}
            onChange={(event) =>
              setCadence(event.target.value as typeof cadence)
            }
          >
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </Select>
        </Field>
        <Field label="First due date">
          <input
            type="date"
            className={inputCls}
            value={nextDue}
            onChange={(event) => setNextDue(event.target.value)}
          />
        </Field>
        <Field label="Payment terms (days)">
          <TextInput
            className="num"
            value={String(dueDays)}
            onChange={(event) =>
              setDueDays(Math.max(0, Number(event.target.value) || 0))
            }
          />
        </Field>
        <Field label="Narration">
          <TextInput
            value={narration}
            onChange={(event) => setNarration(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-[2fr_.7fr_1fr_1fr_.7fr] gap-3">
        <Field label="Item">
          <ItemPicker value={itemId} onPick={setItem} />
        </Field>
        <Field label="Quantity">
          <TextInput
            className="num"
            value={String(qtyMilli / 1000)}
            onChange={(event) =>
              setQty(Math.round((Number(event.target.value) || 0) * 1000))
            }
          />
        </Field>
        <Field label="Rate source">
          <Select
            value={rateMode}
            onChange={(event) =>
              setRateMode(event.target.value as typeof rateMode)
            }
          >
            <option value="fixed">Fixed rate</option>
            <option value="price_list">Customer price list</option>
          </Select>
        </Field>
        <Field label="Fixed rate">
          {rateMode === "fixed" ? (
            <AmountInput paise={fixedRate} onPaise={setFixedRate} />
          ) : (
            <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[11px] text-muted">
              Resolved on due date
            </div>
          )}
        </Field>
        <Field label="Discount %">
          <TextInput
            className="num"
            value={String(discountBps / 100)}
            onChange={(event) =>
              setDiscount(Math.round((Number(event.target.value) || 0) * 100))
            }
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel}>Back</Button>
        <Button
          variant="primary"
          disabled={
            !name.trim() ||
            !partyLedgerId ||
            !itemId ||
            !salesType ||
            (rateMode === "fixed" && fixedRate == null)
          }
          onClick={() => void save()}
        >
          Save schedule
        </Button>
      </div>
    </>
  );
}

export function PricingModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient(),
    levels = useQuery({
      queryKey: ["priceLevels"],
      queryFn: api.priceLevels.list,
    }),
    [levelId, setLevelId] = useState<number | null>(null),
    [levelName, setLevelName] = useState(""),
    [itemId, setItem] = useState<number | null>(null),
    [rate, setRate] = useState<number | null>(null),
    [effectiveFrom, setEffective] = useState(todayISO());
  useEffect(() => {
    if (!levelId && levels.data?.[0]) setLevelId(levels.data[0].id);
  }, [levels.data, levelId]);
  const rates = useQuery({
    queryKey: ["priceLevelRates", levelId],
    queryFn: () => api.priceLevels.rates(levelId!),
    enabled: !!levelId,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["priceLevels"] }),
      qc.invalidateQueries({ queryKey: ["priceLevelRates"] }),
    ]);
  };
  const addLevel = async (): Promise<void> => {
    try {
      const level = await api.priceLevels.create({ name: levelName });
      setLevelId(level.id);
      setLevelName("");
      await refresh();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const addRate = async (): Promise<void> => {
    if (!levelId || !itemId || rate == null) return;
    try {
      await api.priceLevels.saveRate({
        priceLevelId: levelId,
        stockItemId: itemId,
        rate,
        effectiveFrom,
      });
      setItem(null);
      setRate(null);
      await refresh();
      toast.push("success", "Effective rate saved");
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Price lists" onClose={onClose} wide>
      <div className="grid grid-cols-[280px_1fr] gap-3">
        <Panel>
          <p className="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
            Lists
          </p>
          <div className="mt-2 space-y-1">
            {levels.data?.map((level) => (
              <button
                key={level.id}
                onClick={() => setLevelId(level.id)}
                className={`w-full rounded px-3 py-2 text-left text-[11px] ${levelId === level.id ? "bg-ink font-semibold text-canvas" : "hover:bg-panel2"}`}
              >
                {level.name}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <TextInput
              value={levelName}
              onChange={(event) => setLevelName(event.target.value)}
              placeholder="Wholesale / Retail"
            />
            <Button
              disabled={!levelName.trim()}
              onClick={() => void addLevel()}
            >
              Add
            </Button>
          </div>
          <p className="mt-3 text-[9.5px] leading-relaxed text-muted">
            Assign a list to each customer in Masters → Ledgers. Invoice entry
            then resolves the rate effective on its date.
          </p>
        </Panel>
        <Panel className="overflow-hidden p-0">
          {!levelId ? (
            <EmptyState title="Create a price list" />
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_1fr_1fr_auto] gap-2 border-b border-line p-3">
                <ItemPicker value={itemId} onPick={setItem} />
                <AmountInput paise={rate} onPaise={setRate} />
                <input
                  type="date"
                  className={inputCls}
                  value={effectiveFrom}
                  onChange={(event) => setEffective(event.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={!itemId || rate == null}
                  onClick={() => void addRate()}
                >
                  Add rate
                </Button>
              </div>
              {!rates.data?.length ? (
                <EmptyState title="No effective rates in this list" />
              ) : (
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Effective from</th>
                      <th className="r">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rates.data.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {row.itemName}
                          <span className="ml-1 text-[9px] text-muted">
                            /{row.unitSymbol}
                          </span>
                        </td>
                        <td className="num">
                          {toDisplayDate(row.effectiveFrom)}
                        </td>
                        <td className="r">
                          <Money paise={row.rate} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Panel>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

export function DiscountPoliciesModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient(),
    policies = useQuery({
      queryKey: ["salesDiscountPolicies"],
      queryFn: api.salesDiscounts.list,
    }),
    [name, setName] = useState(""),
    [scope, setScope] = useState<DiscountScopeKind>("role"),
    [role, setRole] = useState<DiscountActorRole>("accountant"),
    [itemId, setItem] = useState<number | null>(null),
    [customerId, setCustomer] = useState<number | null>(null),
    [max, setMax] = useState(10);
  const save = async (): Promise<void> => {
    try {
      await api.salesDiscounts.save({
        name,
        scopeKind: scope,
        role: scope === "role" ? role : null,
        stockItemId: scope === "item" ? itemId : null,
        customerLedgerId: scope === "customer" ? customerId : null,
        maxDiscountBps: Math.round(max * 100),
        active: true,
      });
      setName("");
      await qc.invalidateQueries({ queryKey: ["salesDiscountPolicies"] });
      toast.push("success", "Discount authority policy saved");
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const valid =
    !!name.trim() &&
    (scope === "global" ||
      (scope === "role" && !!role) ||
      (scope === "item" && !!itemId) ||
      (scope === "customer" && !!customerId));
  return (
    <Modal title="Discount authority" onClose={onClose} wide>
      <div className="rounded-md border border-line bg-panel2 p-3">
        <p className="text-[11.5px] font-semibold">
          Server-enforced commercial guardrails
        </p>
        <p className="mt-1 text-[10px] text-muted">
          When rules overlap, the strictest limit wins. The same check protects
          quotations and posted sales invoices.
        </p>
      </div>
      <div className="mt-3 grid grid-cols-[1.4fr_1fr_1.5fr_.7fr_auto] items-end gap-2">
        <Field label="Policy name">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Sales team ceiling"
          />
        </Field>
        <Field label="Scope">
          <Select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as DiscountScopeKind)
            }
          >
            <option value="role">User role</option>
            <option value="item">Item</option>
            <option value="customer">Customer</option>
            <option value="global">All sales</option>
          </Select>
        </Field>
        <Field label="Applies to">
          {scope === "role" ? (
            <Select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as DiscountActorRole)
              }
            >
              <option value="accountant">Accountant</option>
              <option value="owner">Owner</option>
              <option value="viewer">Viewer</option>
            </Select>
          ) : scope === "item" ? (
            <ItemPicker value={itemId} onPick={setItem} />
          ) : scope === "customer" ? (
            <LedgerPicker value={customerId} onPick={setCustomer} />
          ) : (
            <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[11px]">
              Every customer and item
            </div>
          )}
        </Field>
        <Field label="Max %">
          <TextInput
            className="num text-right"
            value={String(max)}
            onChange={(event) =>
              setMax(
                Math.max(0, Math.min(100, Number(event.target.value) || 0)),
              )
            }
          />
        </Field>
        <Button variant="primary" disabled={!valid} onClick={() => void save()}>
          Add policy
        </Button>
      </div>
      <Panel className="mt-3 overflow-hidden p-0">
        {!policies.data?.length ? (
          <EmptyState
            title="No discount limits configured"
            hint="Without policies, discounts remain unrestricted."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Scope</th>
                <th className="r">Maximum</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((policy) => (
                <tr key={policy.id}>
                  <td className="font-medium">{policy.name}</td>
                  <td>{policy.scopeLabel}</td>
                  <td className="r num">{policy.maxDiscountBps / 100}%</td>
                  <td className={policy.active ? "text-dr" : "text-muted"}>
                    {policy.active ? "Active" : "Inactive"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

type CustomerOpsTab =
  | "returns"
  | "warranty"
  | "territories"
  | "subscriptions"
  | "fields"
  | "portal";
export function CustomerOperationsModal({
  onClose,
  onOpenDraft,
}: {
  onClose: () => void;
  onOpenDraft: (id: number) => void;
}): React.JSX.Element {
  const { from, to } = useSession(),
    toast = useToasts(),
    qc = useQueryClient(),
    [tab, setTab] = useState<CustomerOpsTab>("returns"),
    [customerId, setCustomer] = useState<number | null>(null);
  const returns = useQuery({
    queryKey: ["salesReturnCandidates"],
    queryFn: () => api.customerOperations.returnCandidates(),
    enabled: tab === "returns",
  });
  const warranties = useQuery({
    queryKey: ["salesWarranties"],
    queryFn: api.customerOperations.warranties,
    enabled: tab === "warranty",
  });
  const territories = useQuery({
    queryKey: ["territorySales", from, to],
    queryFn: () => api.customerOperations.territorySales(from, to),
    enabled: tab === "territories",
  });
  const subscriptions = useQuery({
    queryKey: ["salesSubscriptions"],
    queryFn: api.customerOperations.subscriptions,
    enabled: tab === "subscriptions",
  });
  const fields = useQuery({
    queryKey: ["salesCustomFields"],
    queryFn: api.customerOperations.customFields,
    enabled: tab === "fields",
  });
  const prepareReturn = async (
    row: NonNullable<typeof returns.data>[number],
  ): Promise<void> => {
    try {
      const draft = await api.customerOperations.returnDraft({
        invoiceVoucherId: row.voucherId,
        date: todayISO(),
        reason: "Customer return — verify reason before posting",
        lines: row.lines.map((line) => ({
          invoiceInventoryLineId: line.inventoryLineId,
          qtyMilli: line.openQtyMilli,
        })),
      });
      onClose();
      onOpenDraft(draft.id);
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const toggleSubscription = async (
    id: number,
    status: "active" | "paused",
  ): Promise<void> => {
    await api.customerOperations.setSubscriptionStatus(id, status);
    await qc.invalidateQueries({ queryKey: ["salesSubscriptions"] });
  };
  const bundle = async (): Promise<void> => {
    if (!customerId) return;
    try {
      const result = await api.customerOperations.portalBundle(
        customerId,
        from,
        to,
      );
      toast.push(
        "success",
        `Private customer pack created · ${result.invoiceCount} invoices`,
      );
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const tabs: [CustomerOpsTab, string][] = [
    ["returns", "Returns"],
    ["warranty", "Warranty"],
    ["territories", "Territories"],
    ["subscriptions", "Subscriptions"],
    ["fields", "Document fields"],
    ["portal", "Customer pack"],
  ];
  return (
    <Modal title="Customer operations" onClose={onClose} wide>
      <div className="mb-3 flex rounded-md border border-line bg-panel p-0.5">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded px-2 py-1.5 text-[10.5px] ${tab === id ? "bg-ink font-semibold text-canvas" : "text-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "returns" ? (
        <Panel className="overflow-hidden p-0">
          {!returns.data?.length ? (
            <EmptyState title="No returnable sales quantities" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th className="r">Open qty</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {returns.data.map((row) => (
                  <tr key={row.voucherId}>
                    <td>
                      <p className="font-mono font-semibold">{row.number}</p>
                      <p className="text-[9px] text-muted">
                        {toDisplayDate(row.date)}
                      </p>
                    </td>
                    <td>{row.partyName}</td>
                    <td>{row.lines.map((line) => line.itemName).join(", ")}</td>
                    <td className="r num">
                      {row.lines.reduce(
                        (sum, line) => sum + line.openQtyMilli,
                        0,
                      ) / 1000}
                    </td>
                    <td className="r">
                      <Button onClick={() => void prepareReturn(row)}>
                        Prepare credit note
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : tab === "warranty" ? (
        <Panel className="overflow-hidden p-0">
          {!warranties.data?.length ? (
            <EmptyState
              title="No warranty cases"
              hint="Claims appear here after a sold serial is linked to an invoice."
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Invoice</th>
                  <th>Issue</th>
                  <th>Coverage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {warranties.data.map((row) => (
                  <tr key={row.id}>
                    <td className="font-mono">{row.serialNo}</td>
                    <td>{row.invoiceNumber}</td>
                    <td>{row.issue}</td>
                    <td>
                      {row.warrantyUntil
                        ? toDisplayDate(row.warrantyUntil)
                        : "Not set"}
                    </td>
                    <td className="capitalize">
                      {row.status.replace("_", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : tab === "territories" ? (
        <Panel className="overflow-hidden p-0">
          {!territories.data?.length ? (
            <EmptyState title="No territory assignments in this period" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Territory</th>
                  <th>Salesperson</th>
                  <th className="r">Invoices</th>
                  <th className="r">Sales</th>
                  <th className="r">Returns</th>
                  <th className="r">Net</th>
                </tr>
              </thead>
              <tbody>
                {territories.data.map((row) => (
                  <tr key={`${row.territoryId}-${row.salesperson}`}>
                    <td>{row.territoryName}</td>
                    <td>{row.salesperson}</td>
                    <td className="r num">{row.invoiceCount}</td>
                    <td className="r">
                      <Money paise={row.salesAmount} />
                    </td>
                    <td className="r">
                      <Money paise={row.returnAmount} />
                    </td>
                    <td className="r font-semibold">
                      <Money paise={row.netSales} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : tab === "subscriptions" ? (
        <Panel className="overflow-hidden p-0">
          {!subscriptions.data?.length ? (
            <EmptyState
              title="No subscription contracts"
              hint="Create a recurring schedule first, then attach plan and renewal terms."
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Customer</th>
                  <th>Billing schedule</th>
                  <th>Escalation</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.data.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.planName}</td>
                    <td>{row.customerName}</td>
                    <td>{row.scheduleName}</td>
                    <td className="num">{row.escalationBps / 100}%</td>
                    <td className="capitalize">{row.status}</td>
                    <td className="r">
                      {["active", "paused"].includes(row.status) && (
                        <Button
                          onClick={() =>
                            void toggleSubscription(
                              row.id,
                              row.status === "active" ? "paused" : "active",
                            )
                          }
                        >
                          {row.status === "active" ? "Pause" : "Resume"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : tab === "fields" ? (
        <Panel className="overflow-hidden p-0">
          {!fields.data?.length ? (
            <EmptyState
              title="No custom document fields"
              hint="Typed fields can be configured through the customer-operations API and are enforced on every matching document."
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Key</th>
                  <th>Documents</th>
                  <th>Type</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                {fields.data.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td className="font-mono">{row.fieldKey}</td>
                    <td className="capitalize">{row.documentKind ?? "All"}</td>
                    <td className="capitalize">{row.dataType}</td>
                    <td>{row.required ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : (
        <div className="rounded-md border border-line bg-panel2 p-5">
          <p className="text-[13px] font-semibold">
            Private offline customer bundle
          </p>
          <p className="mt-1 text-[10.5px] text-muted">
            Creates a tokenized folder with invoice PDFs, activity data, an
            offline index and SHA-256 manifest for the current working period.
          </p>
          <div className="mt-4 grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Customer">
              <LedgerPicker value={customerId} onPick={setCustomer} />
            </Field>
            <Button
              variant="primary"
              disabled={!customerId}
              onClick={() => void bundle()}
            >
              Generate secure bundle
            </Button>
          </div>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
