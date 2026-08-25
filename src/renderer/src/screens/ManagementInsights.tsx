import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import type {
  ManagementScenario,
  ManagementScenarioInput,
  ScheduleIiiMapping,
} from "@shared/management";
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
import { todayISO, toDisplayDate } from "@shared/dates";

type Tab = "overview" | "drivers" | "scenarios" | "schedule" | "notes";
const yearShift = (iso: string, delta: number): string =>
  `${Number(iso.slice(0, 4)) + delta}${iso.slice(4)}`;
const monthShift = (iso: string, delta: number): string => {
  const [year, month, day] = iso.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const target = new Date(Date.UTC(year, month - 1 + delta, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
};
const dayShift = (iso: string, delta: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86400000)
    .toISOString()
    .slice(0, 10);
const numberInput = (value: string): number =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

export function ManagementInsightsScreen(): React.JSX.Element {
  const { from, to } = useSession();
  const nav = useNav();
  const toast = useToasts();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [rowKey, setRowKey] = useState("period-summary");
  const [packBusy, setPackBusy] = useState(false);
  const [comparisonFrom, setComparisonFrom] = useState(yearShift(from, -1));
  const [comparisonTo, setComparisonTo] = useState(yearShift(to, -1));
  const [comparisonPreset, setComparisonPreset] = useState("prior-year");
  const priorTo = yearShift(to, -1);
  const dashboard = useQuery({
    queryKey: ["dashboard", to, from],
    queryFn: ({ signal }) => api.reports.dashboard(to, from, signal),
    enabled: tab === "overview",
  });
  const variance = useQuery({
    queryKey: ["managementVariance", from, to, comparisonFrom, comparisonTo],
    queryFn: () =>
      api.management.variance(from, to, comparisonFrom, comparisonTo),
    enabled: tab === "drivers",
  });
  const scenarios = useQuery({
    queryKey: ["managementScenarios"],
    queryFn: api.management.scenarios,
    enabled: tab === "scenarios",
  });
  const selected =
    scenarios.data?.find((row) => row.id === selectedScenario) ??
    scenarios.data?.[0];
  const projection = useQuery({
    queryKey: [
      "managementProjection",
      from,
      to,
      selected?.id,
      selected?.updatedAt,
    ],
    queryFn: () => api.management.scenarioProjection(from, to, selected!),
    enabled: tab === "scenarios" && !!selected,
  });
  const mappings = useQuery({
    queryKey: ["scheduleMappings"],
    queryFn: api.management.scheduleMappings,
    enabled: tab === "schedule",
  });
  const schedule = useQuery({
    queryKey: ["scheduleStatement", to, priorTo, mappings.dataUpdatedAt],
    queryFn: () => api.management.scheduleStatement(to, priorTo),
    enabled: tab === "schedule",
  });
  const annotations = useQuery({
    queryKey: ["reportAnnotations", "management-insights", from, to],
    queryFn: () => api.management.annotations("management-insights", from, to),
    enabled: tab === "notes",
  });
  const saveNote = async () => {
    try {
      await api.management.annotationSave({
        reportKey: "management-insights",
        rowKey,
        from,
        to,
        note,
        includeInExport: true,
      });
      setNote("");
      await qc.invalidateQueries({ queryKey: ["reportAnnotations"] });
      toast.push("success", "Report annotation retained");
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const pack = async () => {
    setPackBusy(true);
    try {
      const result = await api.exporter.caPack(from, to);
      toast.push(
        "success",
        `Portable report pack ready · ${result.path.split("/").pop()}`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPackBusy(false);
    }
  };
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "drivers", label: "Variance drivers" },
    { key: "scenarios", label: "Scenarios" },
    { key: "schedule", label: "Schedule III" },
    { key: "notes", label: "Notes & pack" },
  ];
  return (
    <div className="mx-auto max-w-6xl">
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
        Management insights
      </SectionTitle>
      {tab === "overview" && (
        <Overview
          data={dashboard.data}
          loading={dashboard.isLoading}
          onGo={(name) => nav.go({ name })}
        />
      )}
      {tab === "drivers" && (
        <Drivers
          data={variance.data}
          loading={variance.isLoading}
          comparisonFrom={comparisonFrom}
          comparisonTo={comparisonTo}
          preset={comparisonPreset}
          onComparison={(preset) => {
            setComparisonPreset(preset);
            if (preset === "prior-year") {
              setComparisonFrom(yearShift(from, -1));
              setComparisonTo(yearShift(to, -1));
            } else if (preset === "prior-quarter") {
              setComparisonFrom(monthShift(from, -3));
              setComparisonTo(monthShift(to, -3));
            } else if (preset === "prior-month") {
              setComparisonFrom(monthShift(from, -1));
              setComparisonTo(monthShift(to, -1));
            } else if (preset === "prior-period") {
              const days =
                Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
              setComparisonTo(dayShift(from, -1));
              setComparisonFrom(dayShift(from, -days));
            }
          }}
          onFrom={setComparisonFrom}
          onTo={setComparisonTo}
          onVoucher={(ids) =>
            nav.go({
              name: "daybook",
              from,
              to,
              periodLabel: "Variance driver",
              voucherIds: ids,
            })
          }
        />
      )}
      {tab === "scenarios" && (
        <div className="space-y-3">
          <Panel className="flex items-end gap-3">
            <Field label="Reviewed scenario">
              <Select
                value={selected?.id ?? ""}
                onChange={(e) => setSelectedScenario(Number(e.target.value))}
              >
                <option value="">Select scenario</option>
                {scenarios.data?.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" onClick={() => setScenarioOpen(true)}>
              New scenario
            </Button>
          </Panel>
          <ScenarioResult scenario={selected} data={projection.data} />
        </div>
      )}
      {tab === "schedule" && (
        <div className="space-y-3">
          <Panel className="flex items-center justify-between">
            <div>
              <p className="text-[12px] font-semibold">
                Company-format Schedule III mapping
              </p>
              <p className="mt-1 text-[10.5px] text-muted">
                Presentation mappings never alter the chart of accounts or
                posted balances.
              </p>
            </div>
            <Button variant="primary" onClick={() => setMappingOpen(true)}>
              Map account group
            </Button>
          </Panel>
          <ScheduleTable data={schedule.data} loading={schedule.isLoading} />
          {schedule.data && schedule.data.unmapped.length > 0 && (
            <Panel>
              <p className="mb-2 text-[11.5px] font-semibold text-amber">
                {schedule.data.unmapped.length} non-zero groups remain unmapped
              </p>
              <div className="grid grid-cols-2 gap-x-6">
                {schedule.data.unmapped.map((row) => (
                  <div
                    key={row.groupId}
                    className="flex justify-between border-b border-line py-1.5 text-[10.5px]"
                  >
                    <span>{row.groupName}</span>
                    <Money paise={row.amount} signed />
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}
      {tab === "notes" && (
        <div className="grid grid-cols-[1fr_340px] gap-3">
          <Panel>
            <p className="mb-3 text-[12px] font-semibold">Period annotations</p>
            <div className="grid grid-cols-[180px_1fr_auto] items-end gap-2">
              <Field label="Report row">
                <TextInput
                  value={rowKey}
                  onChange={(e) => setRowKey(e.target.value)}
                />
              </Field>
              <Field label="Explanation">
                <TextInput
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                disabled={!note.trim()}
                onClick={() => void saveNote()}
              >
                Retain note
              </Button>
            </div>
            <div className="mt-4">
              {!annotations.data?.length ? (
                <EmptyState title="No explanations retained for this period" />
              ) : (
                annotations.data.map((row) => (
                  <div key={row.id} className="border-t border-line py-2">
                    <p className="text-[10px] font-semibold">{row.rowKey}</p>
                    <p className="mt-1 text-[11px] text-muted">{row.note}</p>
                    <p className="mt-1 text-[9px] text-muted">
                      {row.author} · {row.updatedAt}
                    </p>
                  </div>
                ))
              )}
            </div>
          </Panel>
          <Panel>
            <p className="text-[12px] font-semibold">Portable report pack</p>
            <p className="mt-2 text-[10.5px] leading-4 text-muted">
              Creates an indexed PDF, manifest, statements, registers, returns,
              outstandings, ledger schedules and Tally interchange files in one
              portable folder.
            </p>
            <p className="mt-3 font-mono text-[10px] text-muted">
              {toDisplayDate(from)} → {toDisplayDate(to)}
            </p>
            <Button
              className="mt-4 w-full"
              variant="primary"
              disabled={packBusy}
              onClick={() => void pack()}
            >
              {packBusy ? "Building pack…" : "Build indexed pack"}
            </Button>
          </Panel>
        </div>
      )}
      {scenarioOpen && <ScenarioModal onClose={() => setScenarioOpen(false)} />}{" "}
      {mappingOpen && (
        <MappingModal
          mappings={mappings.data ?? []}
          onClose={() => setMappingOpen(false)}
        />
      )}
    </div>
  );
}

function Overview({
  data,
  loading,
  onGo,
}: {
  data: Awaited<ReturnType<typeof api.reports.dashboard>> | undefined;
  loading: boolean;
  onGo: (
    name:
      | "balance-sheet"
      | "profit-loss"
      | "outstandings"
      | "stock-summary"
      | "action-centre"
      | "compliance-centre",
  ) => void;
}): React.JSX.Element {
  if (loading || !data)
    return (
      <Panel>
        <SkeletonRows rows={8} />
      </Panel>
    );
  const metrics = [
    [
      "Cash & bank",
      data.cashBalance + data.bankBalance,
      "Cash available now",
      "balance-sheet",
    ],
    ["Sales this month", data.monthSales, "Revenue booked", "profit-loss"],
    ["Receivables", data.receivables, "Money customers owe", "outstandings"],
    ["Payables", data.payables, "Money due to suppliers", "outstandings"],
    [
      "GST payable",
      data.gstPayable,
      "Current tax position",
      "compliance-centre",
    ],
  ] as const;
  const ratios = [
    [
      "Current ratio",
      data.ratios.currentRatio,
      "Current assets ÷ current liabilities",
      "balance-sheet",
    ],
    [
      "Quick ratio",
      data.ratios.quickRatio,
      "(Current assets − stock) ÷ current liabilities",
      "balance-sheet",
    ],
    [
      "Debtor days",
      data.ratios.debtorDays,
      "Receivables ÷ sales × period days",
      "outstandings",
    ],
    [
      "Inventory turns",
      data.ratios.inventoryTurnover,
      "Cost of goods sold ÷ average stock",
      "stock-summary",
    ],
    [
      "Gross margin",
      data.ratios.grossMarginPct,
      "Gross profit ÷ sales × 100",
      "profit-loss",
    ],
    [
      "Net margin",
      data.ratios.netMarginPct,
      "Net profit ÷ sales × 100",
      "profit-loss",
    ],
  ] as const;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-3">
        {metrics.map(([label, value, copy, target]) => (
          <button
            key={label}
            onClick={() => onGo(target)}
            className="rounded-lg border border-line bg-panel p-4 text-left hover:border-amber/45"
          >
            <p className="text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
              {label}
            </p>
            <p className="mt-3 text-[20px] font-semibold">
              <Money paise={value} />
            </p>
            <p className="mt-2 text-[9.5px] text-muted">{copy} →</p>
          </button>
        ))}
      </div>
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[12px] font-semibold">Ratio definitions</p>
            <p className="text-[10px] text-muted">
              Every formula is visible; select a ratio to inspect its source
              report.
            </p>
          </div>
          <Button onClick={() => onGo("action-centre")}>
            Open accountant desk
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-line bg-line">
          {ratios.map(([label, value, formula, target]) => (
            <button
              key={label}
              onClick={() => onGo(target)}
              className="bg-panel p-4 text-left hover:bg-panel2"
            >
              <span className="text-[10.5px] font-semibold">{label}</span>
              <span className="float-right font-mono text-[14px]">
                {value == null ? "—" : value.toFixed(2)}
              </span>
              <span className="mt-3 block text-[9.5px] text-muted">
                {formula}
              </span>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Drivers({
  data,
  loading,
  comparisonFrom,
  comparisonTo,
  preset,
  onComparison,
  onFrom,
  onTo,
  onVoucher,
}: {
  data: Awaited<ReturnType<typeof api.management.variance>> | undefined;
  loading: boolean;
  comparisonFrom: string;
  comparisonTo: string;
  preset: string;
  onComparison: (preset: string) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onVoucher: (ids: number[]) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Panel className="grid grid-cols-[220px_160px_160px_1fr] items-end gap-3">
        <Field label="Comparison">
          <Select value={preset} onChange={(e) => onComparison(e.target.value)}>
            <option value="prior-month">Previous month</option>
            <option value="prior-quarter">Previous quarter</option>
            <option value="prior-period">Previous equal period</option>
            <option value="prior-year">Prior year / FY</option>
            <option value="custom">Custom range</option>
          </Select>
        </Field>
        <Field label="Comparison from">
          <DateInput
            value={comparisonFrom}
            context={comparisonTo}
            onChange={(value) => {
              onComparison("custom");
              onFrom(value);
            }}
          />
        </Field>
        <Field label="Comparison to">
          <DateInput
            value={comparisonTo}
            context={comparisonFrom}
            onChange={(value) => {
              onComparison("custom");
              onTo(value);
            }}
          />
        </Field>
        <p className="pb-2 text-[10px] text-muted">
          {data
            ? <>Current {toDisplayDate(data.current.from)} → {toDisplayDate(data.current.to)}</>
            : "Calculating current period…"}
        </p>
      </Panel>
      {loading || !data ? (
        <Panel>
          <SkeletonRows rows={8} />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Panel>
              <p className="text-[10px] text-muted">
                Sales change vs comparison
              </p>
              <p className="mt-2 text-[20px] font-semibold">
                <Money paise={data.salesChange} signed />
              </p>
            </Panel>
            <Panel>
              <p className="text-[10px] text-muted">
                Purchase change vs comparison
              </p>
              <p className="mt-2 text-[20px] font-semibold">
                <Money paise={data.purchaseChange} signed />
              </p>
            </Panel>
          </div>
          <Panel className="overflow-hidden p-0">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Dimension</th>
                  <th className="r">Comparison</th>
                  <th className="r">Current</th>
                  <th className="r">Change</th>
                  <th className="r">Price</th>
                  <th className="r">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {data.drivers.slice(0, 30).map((row) => (
                  <tr
                    key={row.key}
                    className={row.voucherIds.length ? "cursor-pointer" : ""}
                    onClick={() =>
                      row.voucherIds.length && onVoucher(row.voucherIds)
                    }
                  >
                    <td className="font-medium">{row.name}</td>
                    <td className="capitalize text-muted">{row.dimension}</td>
                    <td className="r">
                      <Money paise={row.comparison} />
                    </td>
                    <td className="r">
                      <Money paise={row.current} />
                    </td>
                    <td className="r">
                      <Money paise={row.change} signed />
                    </td>
                    <td className="r">
                      {row.priceImpact == null ? (
                        "—"
                      ) : (
                        <Money paise={row.priceImpact} signed />
                      )}
                    </td>
                    <td className="r">
                      {row.quantityImpact == null ? (
                        "—"
                      ) : (
                        <Money paise={row.quantityImpact} signed />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}

function ScenarioResult({
  scenario,
  data,
}: {
  scenario: ManagementScenario | undefined;
  data:
    Awaited<ReturnType<typeof api.management.scenarioProjection>> | undefined;
}): React.JSX.Element {
  if (!scenario)
    return (
      <Panel>
        <EmptyState
          title="No saved scenarios"
          hint="Create a conservative, base or growth view without changing the books."
        />
      </Panel>
    );
  if (!data)
    return (
      <Panel>
        <SkeletonRows />
      </Panel>
    );
  return (
    <Panel>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-[13px] font-semibold">{scenario.name}</p>
          <p className="mt-1 text-[10px] text-muted">
            {scenario.note || "Non-posting management projection"}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {data.assumptions.map((item) => (
            <span
              key={item}
              className="rounded border border-line px-2 py-1 text-[9px] text-muted"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th className="r">Books</th>
            <th className="r">Scenario</th>
            <th className="r">Change</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              "sales",
              "grossProfit",
              "netProfit",
              "receivables",
              "payables",
            ] as const
          ).map((key) => (
            <tr key={key}>
              <td className="capitalize">{key.replace(/([A-Z])/g, " $1")}</td>
              <td className="r">
                <Money paise={data.base[key]} />
              </td>
              <td className="r">
                <Money paise={data.projected[key]} />
              </td>
              <td className="r">
                <Money paise={data.projected[key] - data.base[key]} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ScheduleTable({
  data,
  loading,
}: {
  data:
    Awaited<ReturnType<typeof api.management.scheduleStatement>> | undefined;
  loading: boolean;
}): React.JSX.Element {
  if (loading || !data)
    return (
      <Panel>
        <SkeletonRows rows={8} />
      </Panel>
    );
  if (!data.rows.length)
    return (
      <Panel>
        <EmptyState
          title="No Schedule III mappings yet"
          hint="Map chart-of-account groups to the company-format statement."
        />
      </Panel>
    );
  return (
    <Panel className="overflow-hidden p-0">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Statement side</th>
            <th>Section</th>
            <th>Note</th>
            <th className="r">Prior</th>
            <th className="r">Current</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={`${row.side}:${row.section}:${row.noteCode}`}>
              <td className="capitalize text-muted">
                {row.side.replace("_", " ")}
              </td>
              <td className="font-medium">{row.section}</td>
              <td className="num">{row.noteCode ?? "—"}</td>
              <td className="r">
                <Money paise={row.prior} />
              </td>
              <td className="r">
                <Money paise={row.current} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

const EMPTY_SCENARIO: ManagementScenarioInput = {
  name: "",
  salesGrowthPct: 0,
  grossMarginPct: null,
  expenseChangePct: 0,
  collectionDaysChange: 0,
  paymentDaysChange: 0,
  note: null,
};
function ScenarioModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(EMPTY_SCENARIO);
  const toast = useToasts();
  const qc = useQueryClient();
  const save = async () => {
    try {
      await api.management.scenarioSave(value);
      await qc.invalidateQueries({ queryKey: ["managementScenarios"] });
      onClose();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <Modal title="New management scenario" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Scenario name">
          <TextInput
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Sales growth %">
            <TextInput
              type="number"
              value={value.salesGrowthPct}
              onChange={(e) =>
                setValue({
                  ...value,
                  salesGrowthPct: numberInput(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Gross margin % (optional)">
            <TextInput
              type="number"
              value={value.grossMarginPct ?? ""}
              onChange={(e) =>
                setValue({
                  ...value,
                  grossMarginPct:
                    e.target.value === "" ? null : numberInput(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Expense change %">
            <TextInput
              type="number"
              value={value.expenseChangePct}
              onChange={(e) =>
                setValue({
                  ...value,
                  expenseChangePct: numberInput(e.target.value),
                })
              }
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Collection days change">
            <TextInput
              type="number"
              value={value.collectionDaysChange}
              onChange={(e) =>
                setValue({
                  ...value,
                  collectionDaysChange: numberInput(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Payment days change">
            <TextInput
              type="number"
              value={value.paymentDaysChange}
              onChange={(e) =>
                setValue({
                  ...value,
                  paymentDaysChange: numberInput(e.target.value),
                })
              }
            />
          </Field>
        </div>
        <Field label="Decision note">
          <TextInput
            value={value.note ?? ""}
            onChange={(e) =>
              setValue({ ...value, note: e.target.value || null })
            }
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!value.name.trim()}
            onClick={() => void save()}
          >
            Save scenario
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MappingModal({
  mappings,
  onClose,
}: {
  mappings: ScheduleIiiMapping[];
  onClose: () => void;
}): React.JSX.Element {
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups.list });
  const [groupId, setGroupId] = useState(0);
  const [side, setSide] = useState<ScheduleIiiMapping["side"]>("asset");
  const [section, setSection] = useState("");
  const [noteCode, setNoteCode] = useState("");
  const [sortOrder, setSort] = useState(10);
  const toast = useToasts();
  const qc = useQueryClient();
  const eligible = useMemo(
    () =>
      groups.data?.filter(
        (group) => !mappings.some((row) => row.groupId === group.id),
      ) ?? [],
    [groups.data, mappings],
  );
  const selected = groupId || eligible[0]?.id || 0;
  const save = async () => {
    try {
      await api.management.scheduleMappingSave({
        groupId: selected,
        side,
        section,
        noteCode: noteCode || null,
        sortOrder,
      });
      await qc.invalidateQueries({ queryKey: ["scheduleMappings"] });
      onClose();
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <Modal title="Map Schedule III group" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Account group">
          <Select
            value={selected}
            onChange={(e) => setGroupId(Number(e.target.value))}
          >
            {eligible.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Statement side">
            <Select
              value={side}
              onChange={(e) => setSide(e.target.value as typeof side)}
            >
              <option value="equity_liability">Equity & liabilities</option>
              <option value="asset">Assets</option>
              <option value="income">Income</option>
              <option value="expense">Expenses</option>
            </Select>
          </Field>
          <Field label="Note code">
            <TextInput
              value={noteCode}
              onChange={(e) => setNoteCode(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <Field label="Section">
            <TextInput
              value={section}
              onChange={(e) => setSection(e.target.value)}
            />
          </Field>
          <Field label="Order">
            <TextInput
              type="number"
              value={sortOrder}
              onChange={(e) => setSort(numberInput(e.target.value))}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected || !section.trim()}
            onClick={() => void save()}
          >
            Save mapping
          </Button>
        </div>
      </div>
    </Modal>
  );
}
