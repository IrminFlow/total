import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Employee, PayrollRun } from "@shared/domain";
import type {
  AttendanceImportPreview,
  AttendanceRecord,
  Contractor,
  EmployeeReimbursement,
  LeaveType,
} from "@shared/workforce";
import type {
  ProvisioningKind,
  ProvisioningPreview,
  ShiftRule,
  StatutoryWorkspaceRow,
} from "@shared/workforceOps";
import { daysInMonth } from "@shared/payroll";
import { todayISO } from "@shared/dates";
import { api, type EmployeeHeadRow, type PayHead } from "../lib/client";
import { formatPaise, parseRupees } from "@shared/money";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  ScrollList,
  Select,
  SkeletonRows,
  Spinner,
  TextInput,
} from "../components/ui";
import { inputCls } from "../components/inputStyles";
import { confirmDialog } from "../lib/dialogs";
import { TabBar } from "../components/TabBar";
import { ActionMenu } from "../components/ActionMenu";
import { CaretDown } from "@phosphor-icons/react";

type Tab =
  | "employees"
  | "runs"
  | "attendance"
  | "workforce"
  | "claims"
  | "contractors"
  | "controls";

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

/** '2026-08' → 'Aug 2026'. */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

export function PayrollScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("employees");
  const user = useSession((state) => state.user);
  const companySlug = useSession((state) => state.slug);
  const permissions = useQuery({
    queryKey: ["permissionMatrix", companySlug],
    queryFn: api.permissions.get,
    enabled: user !== null && user.role !== "owner",
  });
  const canApprove =
    user === null ||
    user.role === "owner" ||
    permissions.data?.[user.role].approve === true;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-1">
        <h2 className="mr-4 text-[20px] font-semibold tracking-[-0.015em]">
          Payroll
        </h2>
        <TabBar
          screen="payroll"
          tabs={[
            { id: "employees", label: "Employees" },
            { id: "runs", label: "Pay runs" },
            { id: "attendance", label: "Attendance" },
            { id: "workforce", label: "Leave & salary" },
            { id: "claims", label: "Claims" },
            { id: "contractors", label: "Contractors" },
            { id: "controls", label: "Controls" },
          ]}
          active={tab}
          onSelect={setTab}
        />
      </div>
      {tab === "employees" ? (
        <EmployeesTab />
      ) : tab === "runs" ? (
        <RunsTab />
      ) : tab === "attendance" ? (
        <AttendanceTab canApprove={canApprove} />
      ) : tab === "workforce" ? (
        <WorkforceTab canApprove={canApprove} />
      ) : tab === "claims" ? (
        <ClaimsTab canApprove={canApprove} />
      ) : tab === "contractors" ? (
        <ContractorsTab />
      ) : (
        <WorkforceControlsTab />
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        Statutory defaults: EPF 12% + 12% on basic (₹15,000 ceiling) · ESI 0.75%
        / 3.25% when gross ≤ ₹21,000 · simplified professional-tax slab. Posting
        books one Journal voucher: salaries and employer contributions against
        PF/ESI/PT/Salaries payable.
      </p>
    </div>
  );
}

type ControlsView = "statutory" | "shifts" | "departments" | "provisioning";
function WorkforceControlsTab(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ControlsView>("statutory");
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [editingChallan, setEditingChallan] =
    useState<StatutoryWorkspaceRow | null>(null);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [holidayOpen, setHolidayOpen] = useState(false);
  const [provisioning, setProvisioning] = useState<{
    kind: ProvisioningKind;
    sourceName: string;
    csvText: string;
    preview: ProvisioningPreview;
  } | null>(null);
  const { data: statutory } = useQuery({
    queryKey: ["payrollStatutory", month],
    queryFn: () => api.payroll.statutory.workspace(month),
    enabled: view === "statutory",
  });
  const { data: shifts } = useQuery({
    queryKey: ["shiftRules"],
    queryFn: api.payroll.shifts.list,
    enabled: view === "shifts",
  });
  const { data: assignments } = useQuery({
    queryKey: ["shiftAssignments"],
    queryFn: api.payroll.shifts.assignments,
    enabled: view === "shifts",
  });
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const year = Number(month.slice(0, 4));
  const { data: holidays } = useQuery({
    queryKey: ["workforceHolidays", year],
    queryFn: () =>
      api.payroll.shifts.holidays(`${year}-01-01`, `${year}-12-31`),
    enabled: view === "shifts",
  });
  const { data: departments } = useQuery({
    queryKey: ["departmentPayroll", month],
    queryFn: () => api.payroll.departmentAnalysis(month, month),
    enabled: view === "departments",
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payrollStatutory"] }),
      queryClient.invalidateQueries({ queryKey: ["shiftRules"] }),
      queryClient.invalidateQueries({ queryKey: ["shiftAssignments"] }),
      queryClient.invalidateQueries({ queryKey: ["workforceHolidays"] }),
      queryClient.invalidateQueries({ queryKey: ["departmentPayroll"] }),
      queryClient.invalidateQueries({ queryKey: ["employees"] }),
    ]);
  };
  const pickProvisioning = async (kind: ProvisioningKind): Promise<void> => {
    const picked = await api.importer.pickCsv();
    if (!picked) return;
    try {
      const preview = await api.payroll.provisioning.preview(
        kind,
        picked.fileName,
        picked.csvText,
      );
      setProvisioning({
        kind,
        sourceName: picked.fileName,
        csvText: picked.csvText,
        preview,
      });
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const applyProvisioning = async (): Promise<void> => {
    if (!provisioning) return;
    try {
      await api.payroll.provisioning.apply(
        provisioning.kind,
        provisioning.sourceName,
        provisioning.csvText,
      );
      await refresh();
      toast.push(
        "success",
        `${provisioning.preview.validCount} ${provisioning.kind} applied`,
      );
      setProvisioning(null);
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const tabs: [ControlsView, string][] = [
    ["statutory", "Statutory"],
    ["shifts", "Shifts & calendar"],
    ["departments", "Departments"],
    ["provisioning", "Provisioning"],
  ];
  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-[.12em] text-muted">
            PAYROLL CONTROL ROOM
          </div>
          <div className="mt-1 text-[13px] text-muted">
            Close statutory, calendar and workforce changes with retained
            evidence.
          </div>
        </div>
        <div className="flex rounded border border-line bg-paper p-0.5">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              className={`rounded px-3 py-1.5 text-[12px] ${view === id ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {(view === "statutory" || view === "departments") && (
        <div className="mb-3 w-44">
          <Field label="Payroll month">
            <input
              className={inputCls}
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </Field>
        </div>
      )}
      {view === "statutory" && (
        <>
          <div className="mb-3 grid grid-cols-4 border border-line bg-paper">
            {(statutory ?? []).map((row, index) => (
              <div
                key={row.kind}
                className={`px-4 py-3 ${index ? "border-l border-line" : ""}`}
              >
                <div className="flex justify-between text-[10px] font-semibold tracking-[.1em] text-muted">
                  <span>{row.kind.toUpperCase()}</span>
                  <span className={row.reconciled ? "text-dr" : "text-warn"}>
                    {row.reconciled ? "TIED" : "OPEN"}
                  </span>
                </div>
                <div className="mt-1 text-[17px] font-semibold">
                  {formatPaise(row.booksAmount)}
                </div>
              </div>
            ))}
          </div>
          <Panel>
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Obligation</th>
                  <th className="r">Books</th>
                  <th className="r">Challan</th>
                  <th className="r">Difference</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(statutory ?? []).map((row) => (
                  <tr key={row.kind}>
                    <td>
                      <div className="font-medium">{row.label}</div>
                      <div className="text-[10px] text-muted">
                        {row.reference ?? "No payment evidence"}
                        {row.filedReference ? ` · ${row.filedReference}` : ""}
                      </div>
                    </td>
                    <td className="r">
                      <Money paise={row.booksAmount} />
                    </td>
                    <td className="r">
                      <Money paise={row.challanAmount} />
                    </td>
                    <td
                      className={`r ${row.difference ? "text-cr" : "text-dr"}`}
                    >
                      <Money paise={row.difference} />
                    </td>
                    <td className="text-[10px] font-semibold uppercase tracking-wider">
                      {row.status}
                    </td>
                    <td className="r">
                      <button
                        className="text-[12px] text-blue hover:underline"
                        onClick={() => setEditingChallan(row)}
                      >
                        Record
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
      {view === "shifts" && (
        <>
          <div className="mb-3 flex justify-end gap-2">
            <Button onClick={() => setHolidayOpen(true)}>Add holiday</Button>
            <Button
              onClick={() => setAssignOpen(true)}
              disabled={
                !shifts?.length || !employees?.some((row) => row.active)
              }
            >
              Assign shift
            </Button>
            <Button variant="primary" onClick={() => setShiftOpen(true)}>
              New shift rule
            </Button>
          </div>
          <div className="grid grid-cols-[.85fr_1.15fr] gap-3">
            <Panel>
              <div className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[.1em] text-muted">
                SHIFT POLICIES
              </div>
              {!shifts?.length ? (
                <EmptyState
                  title="No shift rules"
                  hint="Define working minutes, weekly off and overtime rate"
                />
              ) : (
                <div className="divide-y divide-line">
                  {shifts.map((row) => (
                    <div key={row.id} className="px-3 py-3">
                      <div className="flex justify-between">
                        <span className="font-medium">{row.name}</span>
                        <span className="text-[10px] text-muted">
                          {(row.overtimeRateBps / 10000).toFixed(2)}× OT
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        {row.workMinutes / 60}h day · weekly off{" "}
                        {
                          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                            row.weeklyOffDay
                          ]
                        }
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel>
              <div className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[.1em] text-muted">
                ASSIGNMENTS & HOLIDAYS
              </div>
              <div className="divide-y divide-line">
                {(assignments ?? []).slice(0, 8).map((row) => (
                  <div
                    key={`a${row.id}`}
                    className="flex justify-between px-3 py-2.5"
                  >
                    <span>
                      {row.employeeName} · {row.shiftRuleName}
                    </span>
                    <span className="num text-[11px] text-muted">
                      from {row.effectiveFrom}
                    </span>
                  </div>
                ))}
                {(holidays ?? []).slice(0, 8).map((row) => (
                  <div
                    key={`h${row.id}`}
                    className="flex justify-between px-3 py-2.5"
                  >
                    <span>
                      {row.name}
                      {row.department ? ` · ${row.department}` : ""}
                    </span>
                    <span className="num text-[11px] text-muted">
                      {row.date}
                    </span>
                  </div>
                ))}
                {!assignments?.length && !holidays?.length && (
                  <EmptyState
                    title="Calendar is empty"
                    hint="Assign a shift or add a holiday"
                  />
                )}
              </div>
            </Panel>
          </div>
        </>
      )}
      {view === "departments" && (
        <Panel>
          {!departments?.length ? (
            <EmptyState
              title="No posted department payroll"
              hint="Department is snapshotted when a pay run is posted"
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th className="r">People</th>
                  <th className="r">Gross</th>
                  <th className="r">Overtime</th>
                  <th className="r">Employer cost</th>
                  <th className="r">Net pay</th>
                  <th className="r">YoY</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((row) => (
                  <tr key={row.department}>
                    <td className="font-medium">{row.department}</td>
                    <td className="r">{row.headcount}</td>
                    <td className="r">
                      <Money paise={row.gross} />
                    </td>
                    <td className="r">
                      <div>
                        <Money paise={row.overtimeAmount} />
                      </div>
                      <div className="text-[10px] text-muted">
                        {Math.round(row.overtimeMinutes / 60)}h
                      </div>
                    </td>
                    <td className="r">
                      <Money paise={row.employerCost} />
                    </td>
                    <td className="r">
                      <Money paise={row.netPay} />
                    </td>
                    <td className="r">
                      {row.grossChange == null
                        ? "—"
                        : `${row.grossChange > 0 ? "+" : ""}${row.grossChange}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
      {view === "provisioning" && (
        <div className="grid grid-cols-2 gap-3">
          <button
            className="border border-line bg-paper p-6 text-left hover:border-blue"
            onClick={() => void pickProvisioning("joiners")}
          >
            <div className="text-[10px] font-semibold tracking-[.12em] text-dr">
              JOINERS
            </div>
            <div className="mt-2 text-[18px] font-semibold">
              Import new employees
            </div>
            <div className="mt-2 text-[12px] text-muted">
              Validate codes, effective dates, salary, department and statutory
              profiles before creating masters.
            </div>
          </button>
          <button
            className="border border-line bg-paper p-6 text-left hover:border-blue"
            onClick={() => void pickProvisioning("leavers")}
          >
            <div className="text-[10px] font-semibold tracking-[.12em] text-cr">
              LEAVERS
            </div>
            <div className="mt-2 text-[18px] font-semibold">
              Import employee exits
            </div>
            <div className="mt-2 text-[12px] text-muted">
              Match active employee codes and review exit dates before changing
              workforce status.
            </div>
          </button>
        </div>
      )}
      {editingChallan && (
        <StatutoryChallanModal
          row={editingChallan}
          onClose={() => setEditingChallan(null)}
          onSaved={async () => {
            await refresh();
            setEditingChallan(null);
            toast.push("success", "Statutory evidence saved");
          }}
        />
      )}
      {shiftOpen && (
        <ShiftRuleModal
          onClose={() => setShiftOpen(false)}
          onSaved={async () => {
            await refresh();
            setShiftOpen(false);
            toast.push("success", "Shift rule saved");
          }}
        />
      )}
      {assignOpen && (
        <ShiftAssignmentModal
          employees={(employees ?? []).filter((row) => row.active)}
          shifts={shifts ?? []}
          onClose={() => setAssignOpen(false)}
          onSaved={async () => {
            await refresh();
            setAssignOpen(false);
            toast.push("success", "Shift assigned");
          }}
        />
      )}
      {holidayOpen && (
        <HolidayModal
          onClose={() => setHolidayOpen(false)}
          onSaved={async () => {
            await refresh();
            setHolidayOpen(false);
            toast.push("success", "Holiday saved");
          }}
        />
      )}
      {provisioning && (
        <ProvisioningModal
          data={provisioning}
          onClose={() => setProvisioning(null)}
          onApply={applyProvisioning}
        />
      )}
    </>
  );
}

function StatutoryChallanModal({
  row,
  onClose,
  onSaved,
}: {
  row: StatutoryWorkspaceRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [amount, setAmount] = useState<number | null>(
    row.challanAmount || row.booksAmount,
  );
  const [status, setStatus] = useState<"due" | "paid" | "filed">(row.status);
  const [paidDate, setPaidDate] = useState(row.paidDate ?? todayISO());
  const [reference, setReference] = useState(row.reference ?? "");
  const [filedReference, setFiledReference] = useState(
    row.filedReference ?? "",
  );
  const save = async (): Promise<void> => {
    try {
      await api.payroll.statutory.save({
        month: row.month,
        kind: row.kind,
        amount: amount ?? 0,
        status,
        paidDate: status === "due" ? null : paidDate,
        reference: status === "due" ? null : reference,
        filedReference: status === "filed" ? filedReference : null,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title={`${row.label} · ${monthLabel(row.month)}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Books liability">
            <div className={`${inputCls} num text-right`}>
              {formatPaise(row.booksAmount)}
            </div>
          </Field>
          <Field label="Challan amount">
            <AmountInput paise={amount} onPaise={setAmount} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="due">Due</option>
              <option value="paid">Paid</option>
              <option value="filed">Filed</option>
            </Select>
          </Field>
          <Field label="Paid date">
            <TextInput
              type="date"
              disabled={status === "due"}
              value={paidDate}
              onChange={(e) => setPaidDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Payment reference">
          <TextInput
            disabled={status === "due"}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        {status === "filed" && (
          <Field label="Filing acknowledgement">
            <TextInput
              value={filedReference}
              onChange={(e) => setFiledReference(e.target.value)}
            />
          </Field>
        )}
        <div
          className={`border-l-2 px-3 py-2 text-[11px] ${amount === row.booksAmount ? "border-dr bg-dr/5 text-dr" : "border-cr bg-cr/5 text-cr"}`}
        >
          {amount === row.booksAmount
            ? "Challan exactly matches the books liability."
            : `Difference: ${formatPaise((amount ?? 0) - row.booksAmount)}`}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save evidence
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ShiftRuleModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState("General 8h");
  const [workHours, setWorkHours] = useState("8");
  const [weeklyOffDay, setWeeklyOffDay] = useState(0);
  const [rate, setRate] = useState("1.5");
  const save = async (): Promise<void> => {
    try {
      const minutes = Math.round(Number(workHours) * 60);
      await api.payroll.shifts.save({
        name,
        workMinutes: minutes,
        weeklyOffDay,
        overtimeAfterMinutes: minutes,
        overtimeRateBps: Math.round(Number(rate) * 10000),
        active: true,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="New shift rule" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Shift name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Daily hours">
            <TextInput
              className="num"
              type="number"
              min="1"
              max="24"
              step="0.5"
              value={workHours}
              onChange={(e) => setWorkHours(e.target.value)}
            />
          </Field>
          <Field label="Weekly off">
            <Select
              value={weeklyOffDay}
              onChange={(e) => setWeeklyOffDay(Number(e.target.value))}
            >
              {[
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
              ].map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Overtime multiplier">
            <TextInput
              className="num"
              type="number"
              min="0"
              step="0.25"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
        </div>
        <div className="text-[11px] text-muted">
          Approved overtime uses monthly basic ÷ 26 working days ÷ shift
          minutes, multiplied by this rate.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save rule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ShiftAssignmentModal({
  employees,
  shifts,
  onClose,
  onSaved,
}: {
  employees: Employee[];
  shifts: ShiftRule[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const [shiftRuleId, setShiftRuleId] = useState(shifts[0]?.id ?? 0);
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const save = async (): Promise<void> => {
    try {
      await api.payroll.shifts.assign({
        employeeId,
        shiftRuleId,
        effectiveFrom,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Assign shift" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Employee">
          <Select
            value={employeeId}
            onChange={(e) => setEmployeeId(Number(e.target.value))}
          >
            {employees.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Shift policy">
          <Select
            value={shiftRuleId}
            onChange={(e) => setShiftRuleId(Number(e.target.value))}
          >
            {shifts.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effective from">
          <TextInput
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Assign
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function HolidayModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [date, setDate] = useState(todayISO());
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const save = async (): Promise<void> => {
    try {
      await api.payroll.shifts.saveHoliday({ date, name, department });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Workforce holiday" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Date">
          <TextInput
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Holiday / closure">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Department" hint="Leave blank for the whole company">
          <TextInput
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save holiday
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProvisioningModal({
  data,
  onClose,
  onApply,
}: {
  data: {
    kind: ProvisioningKind;
    sourceName: string;
    csvText: string;
    preview: ProvisioningPreview;
  };
  onClose: () => void;
  onApply: () => Promise<void>;
}): React.JSX.Element {
  return (
    <Modal title={`Review ${data.kind} · ${data.sourceName}`} onClose={onClose}>
      <div className="mb-3 flex gap-5 text-[12px]">
        <span>{data.preview.validCount} valid</span>
        <span className="text-warn">{data.preview.warningCount} warnings</span>
        <span className="text-cr">{data.preview.errorCount} errors</span>
        {data.preview.alreadyImported && (
          <span className="text-cr">Previously imported</span>
        )}
      </div>
      <ScrollList maxH="43vh">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Code</th>
              <th>Name</th>
              <th>Effective</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {data.preview.rows.map((row) => (
              <tr key={row.sourceRow}>
                <td>{row.sourceRow}</td>
                <td className="num">{row.employeeCode}</td>
                <td>{row.name ?? "—"}</td>
                <td className="num">{row.effectiveDate ?? "—"}</td>
                <td
                  className={
                    row.status === "error"
                      ? "text-cr"
                      : row.status === "warning"
                        ? "text-warn"
                        : "text-dr"
                  }
                >
                  {row.message ?? "Ready"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollList>
      <div className="mt-3 border-l-2 border-blue bg-soft px-3 py-2 text-[11px] text-muted">
        Joiner money columns use rupees. Required columns: employee_code,
        effective_date and, for joiners, name. Applied source hashes cannot be
        imported twice.
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!!data.preview.errorCount || data.preview.alreadyImported}
          onClick={() => void onApply()}
        >
          Apply batch
        </Button>
      </div>
    </Modal>
  );
}

function ClaimsTab({ canApprove }: { canApprove: boolean }): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [claimOpen, setClaimOpen] = useState(false);
  const [paying, setPaying] = useState<EmployeeReimbursement | null>(null);
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const { data: claims } = useQuery({
    queryKey: ["reimbursements"],
    queryFn: () => api.payroll.reimbursements.list(),
  });
  const { data: banks } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["reimbursements"] });
  };
  const decide = async (
    id: number,
    decision: "approved" | "rejected",
  ): Promise<void> => {
    try {
      await api.payroll.reimbursements.decide(id, decision);
      await refresh();
      toast.push("success", `Claim ${decision}`);
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const counts = {
    submitted: (claims ?? []).filter((row) => row.status === "submitted")
      .length,
    approved: (claims ?? []).filter((row) => row.status === "approved").length,
    paid: (claims ?? []).filter((row) => row.status === "paid").length,
    total: (claims ?? []).reduce((sum, row) => sum + row.amount, 0),
  };
  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-[.12em] text-muted">
            CLAIM CONTROL
          </div>
          <div className="mt-1 text-[13px] text-muted">
            Review evidence and tax treatment before any money reaches the
            books.
          </div>
        </div>
        <Button
          variant="primary"
          onClick={() => setClaimOpen(true)}
          disabled={!employees?.some((row) => row.active)}
        >
          New claim
        </Button>
      </div>
      <div className="mb-3 grid grid-cols-4 border border-line bg-paper">
        {[
          ["SUBMITTED", counts.submitted],
          ["APPROVED TO PAY", counts.approved],
          ["PAID", counts.paid],
          ["CLAIM VALUE", formatPaise(counts.total)],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={`px-4 py-3 ${index ? "border-l border-line" : ""}`}
          >
            <div className="text-[10px] font-semibold tracking-[.12em] text-muted">
              {label}
            </div>
            <div className="mt-1 text-[18px] font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <Panel scroll={{ maxH: "52vh" }}>
        {!claims?.length ? (
          <EmptyState
            title="No reimbursement claims"
            hint="Capture employee expenses, evidence and taxable treatment here"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Employee / claim</th>
                <th>Date</th>
                <th>Tax</th>
                <th className="r">Amount</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {claims.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="font-medium">
                      {row.employeeName} · {row.category}
                    </div>
                    <div className="text-[10px] text-muted">
                      {row.description}
                      {row.attachmentPath ? " · evidence attached" : ""}
                    </div>
                  </td>
                  <td className="num">{row.claimDate}</td>
                  <td>{row.taxable ? "Taxable" : "Non-taxable"}</td>
                  <td className="r font-medium">
                    <Money paise={row.amount} />
                  </td>
                  <td>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider ${row.status === "paid" || row.status === "approved" ? "text-dr" : row.status === "rejected" ? "text-cr" : "text-warn"}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="r">
                    {row.status === "submitted" && canApprove && (
                      <>
                        <button
                          className="mr-3 text-[12px] text-dr hover:underline"
                          onClick={() => void decide(row.id, "approved")}
                        >
                          Approve
                        </button>
                        <button
                          className="text-[12px] text-cr hover:underline"
                          onClick={() => void decide(row.id, "rejected")}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {row.status === "submitted" && !canApprove && (
                      <span className="text-[10px] text-muted">
                        Awaiting approver
                      </span>
                    )}
                    {row.status === "approved" && (
                      <button
                        className="text-[12px] text-blue hover:underline"
                        onClick={() => setPaying(row)}
                      >
                        Pay & post
                      </button>
                    )}
                    {row.paymentVoucherId && (
                      <button
                        className="text-[12px] text-blue hover:underline"
                        onClick={() =>
                          useNav.getState().go({ name: "daybook" })
                        }
                      >
                        Voucher #{row.paymentVoucherId}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {claimOpen && (
        <ClaimModal
          employees={(employees ?? []).filter((row) => row.active)}
          onClose={() => setClaimOpen(false)}
          onSaved={async () => {
            await refresh();
            setClaimOpen(false);
            toast.push("success", "Claim submitted for review");
          }}
        />
      )}
      {paying && (
        <ClaimPaymentModal
          claim={paying}
          banks={banks ?? []}
          onClose={() => setPaying(null)}
          onPaid={async () => {
            await refresh();
            setPaying(null);
            toast.push("success", "Claim paid and posted to books");
          }}
        />
      )}
    </>
  );
}

function ClaimModal({
  employees,
  onClose,
  onSaved,
}: {
  employees: Employee[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const [claimDate, setClaimDate] = useState(todayISO());
  const [category, setCategory] = useState("Travel");
  const [amount, setAmount] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [attachmentPath, setAttachmentPath] = useState("");
  const [taxable, setTaxable] = useState(false);
  const save = async (): Promise<void> => {
    try {
      await api.payroll.reimbursements.submit({
        employeeId,
        claimDate,
        category,
        amount: amount ?? 0,
        taxable,
        description,
        attachmentPath: attachmentPath.trim() || null,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="New reimbursement claim" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => setEmployeeId(Number(e.target.value))}
            >
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Claim date">
            <TextInput
              type="date"
              value={claimDate}
              onChange={(e) => setClaimDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <TextInput
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
          <Field label="Amount">
            <AmountInput paise={amount} onPaise={setAmount} />
          </Field>
        </div>
        <Field label="Business purpose">
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Evidence file path"
          hint="Stored as a reference; the source file is never changed"
        >
          <TextInput
            value={attachmentPath}
            onChange={(e) => setAttachmentPath(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={taxable}
            onChange={(e) => setTaxable(e.target.checked)}
          />
          Treat as taxable for payroll review
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Submit claim
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ClaimPaymentModal({
  claim,
  banks,
  onClose,
  onPaid,
}: {
  claim: EmployeeReimbursement;
  banks: { id: number; name: string }[];
  onClose: () => void;
  onPaid: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [date, setDate] = useState(todayISO());
  const [bankLedgerId, setBankLedgerId] = useState(banks[0]?.id ?? 0);
  const pay = async (): Promise<void> => {
    try {
      await api.payroll.reimbursements.pay(claim.id, date, bankLedgerId);
      await onPaid();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title={`Pay ${claim.employeeName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="border border-line bg-soft px-3 py-3">
          <div className="text-[11px] text-muted">
            {claim.category} · {claim.description}
          </div>
          <div className="mt-1 text-[20px] font-semibold">
            <Money paise={claim.amount} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cash / bank account">
            <Select
              value={bankLedgerId}
              onChange={(e) => setBankLedgerId(Number(e.target.value))}
            >
              {banks.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment date">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="text-[11px] text-muted">
          Posts a balanced Payment voucher: reimbursement expense debit,
          selected cash/bank credit.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!bankLedgerId}
            onClick={() => void pay()}
          >
            Pay & post
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ContractorsTab(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [contractorOpen, setContractorOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const { data: contractors } = useQuery({
    queryKey: ["contractors"],
    queryFn: api.payroll.contractors.list,
  });
  const { data: payments } = useQuery({
    queryKey: ["contractorPayments"],
    queryFn: api.payroll.contractors.payments,
  });
  const { data: sections } = useQuery({
    queryKey: ["tdsSections"],
    queryFn: api.tds.sections,
  });
  const { data: banks } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["contractors"] }),
      queryClient.invalidateQueries({ queryKey: ["contractorPayments"] }),
    ]);
  };
  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-[.12em] text-muted">
            NON-PAYROLL PAYEES
          </div>
          <div className="mt-1 text-[13px] text-muted">
            Work periods, PAN and TDS move together into the books and statutory
            register.
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setContractorOpen(true)}>
            Add contractor
          </Button>
          <Button
            variant="primary"
            onClick={() => setPaymentOpen(true)}
            disabled={!contractors?.some((row) => row.active) || !banks?.length}
          >
            Post fee
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[.75fr_1.25fr] gap-3">
        <Panel>
          <div className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[.1em] text-muted">
            CONTRACTORS
          </div>
          {!contractors?.length ? (
            <EmptyState
              title="No contractors"
              hint="Add a non-payroll payee and assign its TDS section"
            />
          ) : (
            <div className="divide-y divide-line">
              {contractors.map((row) => (
                <div key={row.id} className="px-3 py-3">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{row.name}</span>
                    <span className="text-[10px] font-semibold text-muted">
                      {row.tdsSectionCode ?? "NO TDS"}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {row.pan ?? "PAN missing"}
                    {row.bankIfsc ? ` · ${row.bankIfsc}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel scroll={{ maxH: "48vh" }}>
          {!payments?.length ? (
            <EmptyState
              title="No contractor payments"
              hint="Posted fees appear here and flow into the TDS workspace"
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Contractor / period</th>
                  <th className="r">Gross</th>
                  <th className="r">TDS</th>
                  <th className="r">Net</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="font-medium">{row.contractorName}</div>
                      <div className="text-[10px] text-muted">
                        {row.periodFrom} → {row.periodTo}
                      </div>
                    </td>
                    <td className="r">
                      <Money paise={row.gross} />
                    </td>
                    <td className="r">
                      <Money paise={row.tds} />
                    </td>
                    <td className="r font-medium">
                      <Money paise={row.gross - row.tds} />
                    </td>
                    <td>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-dr">
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      {contractorOpen && (
        <ContractorModal
          sections={sections ?? []}
          onClose={() => setContractorOpen(false)}
          onSaved={async () => {
            await refresh();
            setContractorOpen(false);
            toast.push("success", "Contractor saved");
          }}
        />
      )}
      {paymentOpen && (
        <ContractorPaymentModal
          contractors={(contractors ?? []).filter((row) => row.active)}
          banks={banks ?? []}
          onClose={() => setPaymentOpen(false)}
          onPosted={async () => {
            await refresh();
            setPaymentOpen(false);
            toast.push("success", "Contractor fee posted with TDS");
          }}
        />
      )}
    </>
  );
}

function ContractorModal({
  sections,
  onClose,
  onSaved,
}: {
  sections: { id: number; code: string; description: string }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState("");
  const [pan, setPan] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [tdsSectionId, setTdsSectionId] = useState(sections[0]?.id ?? 0);
  const save = async (): Promise<void> => {
    try {
      await api.payroll.contractors.save({
        name,
        pan: pan.trim().toUpperCase() || null,
        bankAccount: bankAccount.trim() || null,
        bankIfsc: bankIfsc.trim().toUpperCase() || null,
        tdsSectionId: tdsSectionId || null,
        active: true,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Add contractor" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Legal / trade name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="PAN">
            <TextInput
              className="num uppercase"
              value={pan}
              onChange={(e) => setPan(e.target.value)}
            />
          </Field>
          <Field label="TDS section">
            <Select
              value={tdsSectionId}
              onChange={(e) => setTdsSectionId(Number(e.target.value))}
            >
              <option value={0}>No TDS</option>
              {sections.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} · {row.description}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank account">
            <TextInput
              className="num"
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
            />
          </Field>
          <Field label="IFSC">
            <TextInput
              className="num uppercase"
              value={bankIfsc}
              onChange={(e) => setBankIfsc(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save contractor
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ContractorPaymentModal({
  contractors,
  banks,
  onClose,
  onPosted,
}: {
  contractors: Contractor[];
  banks: { id: number; name: string }[];
  onClose: () => void;
  onPosted: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const today = todayISO();
  const [contractorId, setContractorId] = useState(contractors[0]?.id ?? 0);
  const [periodFrom, setPeriodFrom] = useState(`${today.slice(0, 7)}-01`);
  const [periodTo, setPeriodTo] = useState(today);
  const [date, setDate] = useState(today);
  const [gross, setGross] = useState<number | null>(null);
  const [bankLedgerId, setBankLedgerId] = useState(banks[0]?.id ?? 0);
  const [note, setNote] = useState("");
  const post = async (): Promise<void> => {
    try {
      await api.payroll.contractors.postPayment({
        contractorId,
        periodFrom,
        periodTo,
        gross: gross ?? 0,
        bankLedgerId,
        date,
        note: note.trim() || null,
      });
      await onPosted();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Post contractor fee" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contractor">
            <Select
              value={contractorId}
              onChange={(e) => setContractorId(Number(e.target.value))}
            >
              {contractors.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gross fee">
            <AmountInput paise={gross} onPaise={setGross} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Work from">
            <TextInput
              type="date"
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
            />
          </Field>
          <Field label="Work to">
            <TextInput
              type="date"
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
            />
          </Field>
          <Field label="Posting date">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Pay from">
          <Select
            value={bankLedgerId}
            onChange={(e) => setBankLedgerId(Number(e.target.value))}
          >
            {banks.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="border-l-2 border-blue bg-soft px-3 py-2 text-[11px] text-muted">
          TDS is calculated from the assigned section, PAN status and configured
          single/annual threshold. The posted voucher and deduction feed the
          existing TDS workspace.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!gross || !bankLedgerId}
            onClick={() => void post()}
          >
            Post fee
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function WorkforceTab({
  canApprove,
}: {
  canApprove: boolean;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [loanOpen, setLoanOpen] = useState(false);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const { data: types } = useQuery({
    queryKey: ["leaveTypes"],
    queryFn: api.payroll.leave.types,
  });
  const { data: balances } = useQuery({
    queryKey: ["leaveBalances"],
    queryFn: () => api.payroll.leave.balances(todayISO()),
  });
  const { data: transactions } = useQuery({
    queryKey: ["leaveTransactions"],
    queryFn: () => api.payroll.leave.transactions(),
  });
  const { data: revisions } = useQuery({
    queryKey: ["salaryRevisions"],
    queryFn: () => api.payroll.salaryRevisions.list(),
  });
  const { data: loans } = useQuery({
    queryKey: ["employeeLoans"],
    queryFn: () => api.payroll.loans.list(),
  });
  const { data: banks } = useQuery({
    queryKey: ["bankLedgers"],
    queryFn: api.bank.ledgers,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["leaveTypes"] }),
      queryClient.invalidateQueries({ queryKey: ["leaveBalances"] }),
      queryClient.invalidateQueries({ queryKey: ["leaveTransactions"] }),
      queryClient.invalidateQueries({ queryKey: ["salaryRevisions"] }),
      queryClient.invalidateQueries({ queryKey: ["employeeLoans"] }),
      queryClient.invalidateQueries({ queryKey: ["finalSettlements"] }),
      queryClient.invalidateQueries({ queryKey: ["employees"] }),
      queryClient.invalidateQueries({ queryKey: ["payrollPreview"] }),
    ]);
  };
  const active = (employees ?? []).filter((employee) => employee.active);
  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.12em] text-muted">
            WORKFORCE LEDGER
          </div>
          <div className="mt-1 text-[13px] text-muted">
            Leave movements, employee advances and effective-dated pay changes
            remain fully traceable.
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setTypeOpen(true)}>Leave types</Button>
          <Button
            onClick={() => setLeaveOpen(true)}
            disabled={!active.length || !types?.length}
          >
            Record leave
          </Button>
          <Button onClick={() => setLoanOpen(true)} disabled={!active.length}>
            New loan
          </Button>
          <Button
            onClick={() => setSettlementOpen(true)}
            disabled={!active.length || !banks?.length}
          >
            Final settlement
          </Button>
          <Button
            variant="primary"
            onClick={() => setRevisionOpen(true)}
            disabled={!active.length}
          >
            Salary revision
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[1.15fr_.85fr] gap-3">
        <Panel>
          <div className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[.1em] text-muted">
            LEAVE BALANCES · AS OF TODAY
          </div>
          {!balances?.length ? (
            <EmptyState
              title="No leave policy yet"
              hint="Create a leave type, then record opening accruals or requests"
            />
          ) : (
            <ScrollList maxH="43vh">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th className="r">Available</th>
                    <th className="r">Taken</th>
                    <th className="r">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((row) => (
                    <tr key={`${row.employeeId}-${row.leaveTypeId}`}>
                      <td>{row.employeeName}</td>
                      <td>{row.leaveTypeName}</td>
                      <td className="r font-medium">
                        {(row.balanceMilli / 1000).toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="r">
                        {(row.takenMilli / 1000).toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="r text-warn">
                        {(row.pendingMilli / 1000).toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
          )}
        </Panel>
        <Panel>
          <div className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[.1em] text-muted">
            RECENT DECISIONS
          </div>
          <ScrollList maxH="43vh">
            <div className="divide-y divide-line">
              {[
                ...(transactions ?? []).slice(0, 6).map((row) => ({
                  id: `l${row.id}`,
                  title: `${row.employeeName} · ${row.leaveTypeName}`,
                  meta: `${row.kind.replace("_", " ")} · ${(row.qtyMilli / 1000).toLocaleString("en-IN")} day(s) · ${row.date}`,
                  status: row.status,
                })),
                ...(revisions ?? []).slice(0, 6).map((row) => ({
                  id: `r${row.id}`,
                  title: `${row.employeeName} · salary revision`,
                  meta: `Effective ${row.effectiveFrom} · ${row.reason}`,
                  status: row.status,
                })),
                ...(loans ?? []).slice(0, 4).map((row) => ({
                  id: `a${row.id}`,
                  title: `${row.employeeName} · employee loan`,
                  meta: `${formatPaise(row.outstanding)} outstanding · ${formatPaise(row.installmentAmount)}/month`,
                  status: row.status,
                })),
              ].map((row) => (
                <div key={row.id} className="px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.title}</span>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider ${row.status === "approved" || row.status === "active" ? "text-dr" : row.status === "rejected" ? "text-cr" : "text-warn"}`}
                    >
                      {row.status}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">{row.meta}</div>
                </div>
              ))}
              {!transactions?.length &&
                !revisions?.length &&
                !loans?.length && (
                  <EmptyState
                    title="No workforce movements"
                    hint="Approved changes will appear here with their effective date"
                  />
                )}
            </div>
          </ScrollList>
        </Panel>
      </div>
      {typeOpen && (
        <LeaveTypeModal
          onClose={() => setTypeOpen(false)}
          onSaved={async () => {
            await refresh();
            setTypeOpen(false);
            toast.push("success", "Leave type saved");
          }}
        />
      )}
      {leaveOpen && (
        <LeaveRecordModal
          canApprove={canApprove}
          employees={active}
          types={types ?? []}
          onClose={() => setLeaveOpen(false)}
          onSaved={async () => {
            await refresh();
            setLeaveOpen(false);
            toast.push("success", "Leave movement recorded");
          }}
        />
      )}
      {revisionOpen && (
        <SalaryRevisionModal
          canApprove={canApprove}
          employees={active}
          onClose={() => setRevisionOpen(false)}
          onSaved={async () => {
            await refresh();
            setRevisionOpen(false);
            toast.push("success", "Salary revision saved");
          }}
        />
      )}
      {loanOpen && (
        <EmployeeLoanModal
          employees={active}
          onClose={() => setLoanOpen(false)}
          onSaved={async () => {
            await refresh();
            setLoanOpen(false);
            toast.push("success", "Loan schedule created");
          }}
        />
      )}
      {settlementOpen && (
        <FinalSettlementModal
          employees={active}
          banks={banks ?? []}
          onClose={() => setSettlementOpen(false)}
          onPosted={async () => {
            await refresh();
            setSettlementOpen(false);
            toast.push(
              "success",
              "Final settlement posted and employee exited",
            );
          }}
        />
      )}
    </>
  );
}

function EmployeeLoanModal({
  employees,
  onClose,
  onSaved,
}: {
  employees: Employee[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const [disbursedDate, setDisbursedDate] = useState(todayISO());
  const [firstMonth, setFirstMonth] = useState(todayISO().slice(0, 7));
  const [principal, setPrincipal] = useState<number | null>(null);
  const [installment, setInstallment] = useState<number | null>(null);
  const [interest, setInterest] = useState("0");
  const [note, setNote] = useState("");
  const save = async (): Promise<void> => {
    try {
      await api.payroll.loans.create({
        employeeId,
        disbursedDate,
        principal: principal ?? 0,
        annualInterestBps: Math.round(Number(interest) * 100),
        installmentAmount: installment ?? 0,
        firstDeductionMonth: firstMonth,
        note: note.trim() || null,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Employee loan / advance" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => setEmployeeId(Number(e.target.value))}
            >
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Disbursed">
            <TextInput
              type="date"
              value={disbursedDate}
              onChange={(e) => setDisbursedDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Principal">
            <AmountInput paise={principal} onPaise={setPrincipal} />
          </Field>
          <Field label="Monthly instalment">
            <AmountInput paise={installment} onPaise={setInstallment} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Annual interest %">
            <TextInput
              className="num"
              type="number"
              min="0"
              step="0.01"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
            />
          </Field>
          <Field label="First payroll deduction">
            <TextInput
              type="month"
              value={firstMonth}
              onChange={(e) => setFirstMonth(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="border-l-2 border-blue bg-soft px-3 py-2 text-[11px] text-muted">
          A reducing-balance schedule is created now. Due instalments enter
          payroll automatically; future rows can be paused or waived without
          altering history.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Create schedule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FinalSettlementModal({
  employees,
  banks,
  onClose,
  onPosted,
}: {
  employees: Employee[];
  banks: { id: number; name: string }[];
  onClose: () => void;
  onPosted: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const [lastWorkingDate, setLastWorkingDate] = useState(todayISO());
  const [bankLedgerId, setBankLedgerId] = useState(banks[0]?.id ?? 0);
  const [salaryDue, setSalaryDue] = useState<number | null>(null);
  const [noticePay, setNoticePay] = useState<number | null>(0);
  const [leaveEncashment, setLeaveEncashment] = useState<number | null>(0);
  const [gratuity, setGratuity] = useState<number | null>(0);
  const [recovery, setRecovery] = useState<number | null>(0);
  const [advanceRecovery, setAdvanceRecovery] = useState<number | null>(0);
  const [serviceYears, setServiceYears] = useState(0);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!employeeId) return;
    void api.payroll.settlements
      .preview(employeeId, lastWorkingDate)
      .then((result) => {
        setSalaryDue(result.salaryDue);
        setGratuity(result.gratuity);
        setAdvanceRecovery(result.outstandingAdvance);
        setServiceYears(result.completedYears);
      })
      .catch((error) => toast.push("error", (error as Error).message));
  }, [employeeId, lastWorkingDate]);
  const net =
    (salaryDue ?? 0) +
    (noticePay ?? 0) +
    (leaveEncashment ?? 0) +
    (gratuity ?? 0) -
    (recovery ?? 0) -
    (advanceRecovery ?? 0);
  const post = async (): Promise<void> => {
    try {
      const draft = await api.payroll.settlements.create({
        employeeId,
        lastWorkingDate,
        salaryDue: salaryDue ?? 0,
        noticePay: noticePay ?? 0,
        leaveEncashment: leaveEncashment ?? 0,
        gratuity: gratuity ?? 0,
        recovery: recovery ?? 0,
        advanceRecovery: advanceRecovery ?? 0,
        note: note.trim() || null,
      });
      await api.payroll.settlements.post(
        draft.id,
        lastWorkingDate,
        bankLedgerId,
      );
      await onPosted();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Full and final settlement" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => setEmployeeId(Number(e.target.value))}
            >
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Last working date">
            <TextInput
              type="date"
              value={lastWorkingDate}
              onChange={(e) => setLastWorkingDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Salary due">
            <div className={`${inputCls} num text-right`}>
              {formatPaise(salaryDue ?? 0)}
            </div>
          </Field>
          <Field label="Notice pay">
            <AmountInput paise={noticePay} onPaise={setNoticePay} />
          </Field>
          <Field label="Leave encashment">
            <AmountInput paise={leaveEncashment} onPaise={setLeaveEncashment} />
          </Field>
          <Field label={`Gratuity · ${serviceYears}y`}>
            <div className={`${inputCls} num text-right`}>
              {formatPaise(gratuity ?? 0)}
            </div>
          </Field>
          <Field label="Other recovery">
            <AmountInput paise={recovery} onPaise={setRecovery} />
          </Field>
          <Field label="Advance recovery">
            <div className={`${inputCls} num text-right`}>
              {formatPaise(advanceRecovery ?? 0)}
            </div>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pay from">
            <Select
              value={bankLedgerId}
              onChange={(e) => setBankLedgerId(Number(e.target.value))}
            >
              {banks.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Exit note">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center justify-between border border-line bg-soft px-3 py-3">
          <div>
            <div className="text-[10px] font-semibold tracking-[.12em] text-muted">
              NET SETTLEMENT
            </div>
            <div className="mt-1 text-[20px] font-semibold">
              {formatPaise(net)}
            </div>
          </div>
          <div className="max-w-[260px] text-right text-[11px] text-muted">
            Posting records the employee exit, settles active advances and
            creates a balanced books voucher.
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={net < 0 || !bankLedgerId}
            onClick={() => void post()}
          >
            Approve & post
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LeaveTypeModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState("Earned leave");
  const [annual, setAnnual] = useState("18");
  const [carry, setCarry] = useState("45");
  const [encashable, setEncashable] = useState(true);
  const [paid, setPaid] = useState(true);
  const save = async (): Promise<void> => {
    try {
      await api.payroll.leave.saveType({
        name,
        annualAccrualMilli: Math.round(Number(annual) * 1000),
        carryForwardLimitMilli: carry.trim()
          ? Math.round(Number(carry) * 1000)
          : null,
        encashable,
        paid,
        active: true,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Leave policy" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Leave type">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Annual accrual (days)">
            <TextInput
              className="num"
              type="number"
              min="0"
              step="0.5"
              value={annual}
              onChange={(e) => setAnnual(e.target.value)}
            />
          </Field>
          <Field label="Carry-forward cap">
            <TextInput
              className="num"
              type="number"
              min="0"
              step="0.5"
              value={carry}
              onChange={(e) => setCarry(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex gap-5 text-[13px]">
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
            />
            Paid leave
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={encashable}
              onChange={(e) => setEncashable(e.target.checked)}
            />
            Encashable
          </label>
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

function LeaveRecordModal({
  canApprove,
  employees,
  types,
  onClose,
  onSaved,
}: {
  canApprove: boolean;
  employees: Employee[];
  types: LeaveType[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? 0);
  const [date, setDate] = useState(todayISO());
  const [days, setDays] = useState("1");
  const [kind, setKind] = useState<
    "accrual" | "taken" | "carry_forward" | "encashment" | "adjustment"
  >("taken");
  const [status, setStatus] = useState<"requested" | "approved" | "rejected">(
    canApprove ? "approved" : "requested",
  );
  useEffect(() => {
    if (!canApprove) setStatus("requested");
  }, [canApprove]);
  const [note, setNote] = useState("");
  const save = async (): Promise<void> => {
    try {
      await api.payroll.leave.record({
        employeeId,
        leaveTypeId,
        date,
        qtyMilli: Math.round(Number(days) * 1000),
        kind,
        status,
        note: note.trim() || null,
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Record leave movement" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => setEmployeeId(Number(e.target.value))}
            >
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Leave type">
            <Select
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(Number(e.target.value))}
            >
              {types.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Movement">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="taken">Leave taken</option>
              <option value="accrual">Accrual</option>
              <option value="carry_forward">Carry forward</option>
              <option value="encashment">Encashment</option>
              <option value="adjustment">Adjustment</option>
            </Select>
          </Field>
          <Field label="Date">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Days">
            <TextInput
              className="num"
              type="number"
              step="0.5"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Decision">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="requested">Requested</option>
              {canApprove && <option value="approved">Approved</option>}
              {canApprove && <option value="rejected">Rejected</option>}
            </Select>
          </Field>
          <Field label="Note">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Record movement
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SalaryRevisionModal({
  canApprove,
  employees,
  onClose,
  onSaved,
}: {
  canApprove: boolean;
  employees: Employee[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? 0);
  const selected = employees.find((row) => row.id === employeeId);
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [basic, setBasic] = useState<number | null>(selected?.basic ?? null);
  const [hra, setHra] = useState<number | null>(selected?.hra ?? null);
  const [special, setSpecial] = useState<number | null>(
    selected?.special ?? null,
  );
  const [reason, setReason] = useState("Annual compensation review");
  const [status, setStatus] = useState<"draft" | "approved">(
    canApprove ? "approved" : "draft",
  );
  useEffect(() => {
    if (!canApprove) setStatus("draft");
  }, [canApprove]);
  const choose = (id: number): void => {
    setEmployeeId(id);
    const row = employees.find((employee) => employee.id === id);
    setBasic(row?.basic ?? null);
    setHra(row?.hra ?? null);
    setSpecial(row?.special ?? null);
  };
  const save = async (): Promise<void> => {
    try {
      await api.payroll.salaryRevisions.save({
        employeeId,
        effectiveFrom,
        reason,
        status,
        heads: [
          { name: "Basic", kind: "earning", calc: "flat", value: basic ?? 0 },
          { name: "HRA", kind: "earning", calc: "flat", value: hra ?? 0 },
          {
            name: "Special Allowance",
            kind: "earning",
            calc: "flat",
            value: special ?? 0,
          },
        ],
      });
      await onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal title="Future-dated salary revision" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => choose(Number(e.target.value))}
            >
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effective from">
            <TextInput
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Basic / month">
            <AmountInput paise={basic} onPaise={setBasic} />
          </Field>
          <Field label="HRA / month">
            <AmountInput paise={hra} onPaise={setHra} />
          </Field>
          <Field label="Special / month">
            <AmountInput paise={special} onPaise={setSpecial} />
          </Field>
        </div>
        <Field label="Reason">
          <TextInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="Decision">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="draft">Save draft</option>
            {canApprove && <option value="approved">Approve now</option>}
          </Select>
        </Field>
        <div className="border-l-2 border-blue bg-soft px-3 py-2 text-[11px] text-muted">
          Payroll selects this structure only from its effective date. Earlier
          periods retain the prior salary.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save revision
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- attendance ----------

type AttendanceDraft = Pick<
  AttendanceRecord,
  | "payableDays"
  | "presentDays"
  | "leaveDays"
  | "unpaidDays"
  | "overtimeMinutes"
  | "status"
  | "note"
>;

function AttendanceTab({
  canApprove,
}: {
  canApprove: boolean;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const currentMonth = todayISO().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [drafts, setDrafts] = useState<Record<number, AttendanceDraft>>({});
  const [importData, setImportData] = useState<{
    sourceName: string;
    csvText: string;
    preview: AttendanceImportPreview;
  } | null>(null);
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const { data: records, isLoading } = useQuery({
    queryKey: ["attendance", month],
    queryFn: () => api.payroll.attendance.list(month),
  });
  const { data: summary } = useQuery({
    queryKey: ["attendanceSummary", month],
    queryFn: () => api.payroll.attendance.summary(month),
  });

  useEffect(() => {
    const byEmployee = new Map(
      (records ?? []).map((row) => [row.employeeId, row]),
    );
    const defaultDays = daysInMonth(month);
    setDrafts(
      Object.fromEntries(
        (employees ?? [])
          .filter((employee) => employee.active)
          .map((employee) => {
            const row = byEmployee.get(employee.id);
            return [
              employee.id,
              row
                ? {
                    payableDays: row.payableDays,
                    presentDays: row.presentDays,
                    leaveDays: row.leaveDays,
                    unpaidDays: row.unpaidDays,
                    overtimeMinutes: row.overtimeMinutes,
                    status: row.status,
                    note: row.note,
                  }
                : {
                    payableDays: defaultDays,
                    presentDays: defaultDays,
                    leaveDays: 0,
                    unpaidDays: 0,
                    overtimeMinutes: 0,
                    status: "review" as const,
                    note: null,
                  },
            ];
          }),
      ),
    );
  }, [employees, records, month]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["attendance", month] }),
      queryClient.invalidateQueries({ queryKey: ["attendanceSummary", month] }),
      queryClient.invalidateQueries({ queryKey: ["payrollPreflight"] }),
    ]);
  };
  const update = (employeeId: number, patch: Partial<AttendanceDraft>): void =>
    setDrafts((current) => ({
      ...current,
      [employeeId]: { ...current[employeeId]!, ...patch },
    }));
  const save = async (employeeId: number): Promise<void> => {
    try {
      await api.payroll.attendance.save({
        employeeId,
        month,
        ...drafts[employeeId]!,
      });
      await refresh();
      toast.push("success", "Attendance row saved");
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const approve = async (): Promise<void> => {
    try {
      for (const employee of (employees ?? []).filter(
        (row) =>
          row.active &&
          !records?.some((record) => record.employeeId === row.id),
      ))
        await api.payroll.attendance.save({
          employeeId: employee.id,
          month,
          ...drafts[employee.id]!,
        });
      await api.payroll.attendance.approveMonth(month);
      await refresh();
      toast.push(
        "success",
        `${monthLabel(month)} attendance approved for payroll`,
      );
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const pickImport = async (): Promise<void> => {
    const picked = await api.importer.pickCsv();
    if (!picked) return;
    try {
      const preview = await api.payroll.attendance.previewImport(
        month,
        picked.fileName,
        picked.csvText,
      );
      setImportData({
        sourceName: picked.fileName,
        csvText: picked.csvText,
        preview,
      });
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const applyImport = async (): Promise<void> => {
    if (!importData) return;
    try {
      await api.payroll.attendance.applyImport(
        month,
        importData.sourceName,
        importData.csvText,
      );
      setImportData(null);
      await refresh();
      toast.push("success", "Attendance imported into review");
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };

  const activeEmployees = (employees ?? []).filter(
    (employee) => employee.active,
  );
  return (
    <>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <Field label="Payroll month">
            <input
              className={inputCls}
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </Field>
          <div className="pb-2 text-[12px] text-muted">
            {summary?.approved ?? 0} approved · {summary?.review ?? 0} in review
            · {summary?.exceptions ?? 0} exceptions
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void pickImport()}>Import attendance…</Button>
          <Button
            variant="primary"
            onClick={() => void approve()}
            disabled={
              !canApprove || !activeEmployees.length || !!summary?.exceptions
            }
            disabledTitle={
              canApprove
                ? undefined
                : "Your role cannot approve payroll attendance"
            }
          >
            Approve month
          </Button>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-4 border border-line bg-paper">
        {[
          ["TEAM", String(activeEmployees.length)],
          ["PAYABLE DAYS", String(summary?.payableDays ?? 0)],
          ["OVERTIME", `${Math.round((summary?.overtimeMinutes ?? 0) / 60)}h`],
          [
            "STATUS",
            summary?.approved === activeEmployees.length &&
            activeEmployees.length
              ? "READY"
              : "REVIEW",
          ],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={`px-4 py-3 ${index ? "border-l border-line" : ""}`}
          >
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted">
              {label}
            </div>
            <div
              className={`mt-1 text-[18px] font-semibold ${label === "STATUS" && value === "READY" ? "text-dr" : ""}`}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
      <Panel scroll={{ maxH: "54vh" }}>
        {isLoading ? (
          <SkeletonRows />
        ) : !activeEmployees.length ? (
          <EmptyState
            title="No active employees"
            hint="Add employees before recording attendance"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="r">Present</th>
                <th className="r">Paid leave</th>
                <th className="r">Unpaid</th>
                <th className="r">Payable</th>
                <th className="r">OT min</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeEmployees.map((employee) => {
                const draft = drafts[employee.id];
                if (!draft) return null;
                const approvedLocked =
                  !canApprove &&
                  records?.some(
                    (record) =>
                      record.employeeId === employee.id &&
                      record.status === "approved",
                  );
                const input = (
                  key: keyof Pick<
                    AttendanceDraft,
                    | "payableDays"
                    | "presentDays"
                    | "leaveDays"
                    | "unpaidDays"
                    | "overtimeMinutes"
                  >,
                ): React.JSX.Element => (
                  <input
                    className={`${inputCls} h-7 w-16 text-right num`}
                    type="number"
                    min="0"
                    step={key === "overtimeMinutes" ? 1 : 0.5}
                    disabled={approvedLocked}
                    value={draft[key]}
                    onChange={(event) =>
                      update(employee.id, { [key]: Number(event.target.value) })
                    }
                  />
                );
                return (
                  <tr key={employee.id}>
                    <td>
                      <div className="font-medium">{employee.name}</div>
                      <div className="text-[10px] text-muted">
                        {employee.code || "NO CODE"} ·{" "}
                        {employee.department || "General"}
                      </div>
                    </td>
                    <td className="r">{input("presentDays")}</td>
                    <td className="r">{input("leaveDays")}</td>
                    <td className="r">{input("unpaidDays")}</td>
                    <td className="r">{input("payableDays")}</td>
                    <td className="r">{input("overtimeMinutes")}</td>
                    <td>
                      <Select
                        className="w-24"
                        disabled={approvedLocked}
                        value={draft.status}
                        onChange={(event) =>
                          update(employee.id, {
                            status: event.target
                              .value as AttendanceDraft["status"],
                          })
                        }
                      >
                        <option value="review">Review</option>
                        <option value="approved" disabled={!canApprove}>
                          Approved
                        </option>
                        <option value="exception">Exception</option>
                      </Select>
                    </td>
                    <td className="r">
                      <button
                        className="text-[12px] text-blue hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                        disabled={approvedLocked}
                        title={
                          approvedLocked
                            ? "Your role cannot change approved attendance"
                            : undefined
                        }
                        onClick={() => void save(employee.id)}
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11px] text-muted">
        Import columns: employee_code, payable_days, present_days, leave_days,
        unpaid_days, overtime_minutes. Imported rows remain in review;
        mismatches are isolated as exceptions.
      </p>
      {importData && (
        <Modal
          title={`Review ${importData.sourceName}`}
          onClose={() => setImportData(null)}
        >
          <div className="mb-3 flex gap-5 text-[12px]">
            <span>{importData.preview.validCount} valid</span>
            <span className="text-warn">
              {importData.preview.warningCount} warnings
            </span>
            <span className="text-cr">
              {importData.preview.errorCount} errors
            </span>
            {importData.preview.alreadyImported && (
              <span className="text-cr">Previously imported</span>
            )}
          </div>
          <ScrollList maxH="42vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Code</th>
                  <th>Employee</th>
                  <th className="r">Payable</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {importData.preview.rows.map((row) => (
                  <tr key={row.sourceRow}>
                    <td>{row.sourceRow}</td>
                    <td className="num">{row.employeeCode}</td>
                    <td>{row.employeeName ?? "Unmatched"}</td>
                    <td className="r">{row.payableDays}</td>
                    <td
                      className={
                        row.status === "error"
                          ? "text-cr"
                          : row.status === "warning"
                            ? "text-warn"
                            : "text-dr"
                      }
                    >
                      {row.message ?? "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollList>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setImportData(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !!importData.preview.errorCount ||
                importData.preview.alreadyImported
              }
              onClick={() => void applyImport()}
            >
              Apply to review
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- employees ----------

function EmployeesTab(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [headsOpen, setHeadsOpen] = useState(false);
  const [overridesFor, setOverridesFor] = useState<Employee | null>(null);

  const remove = async (e: Employee): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Delete employee",
      message: `Delete ${e.name}? Employees with payroll history can't be deleted — mark them inactive instead.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!proceed) return;
    try {
      await api.payroll.removeEmployee(e.id);
      await queryClient.invalidateQueries({ queryKey: ["employees"] });
      toast.push("success", `${e.name} deleted`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button
          data-testid="btn-payroll-pay-heads"
          onClick={() => setHeadsOpen(true)}
        >
          Pay heads…
        </Button>
        <Button
          variant="primary"
          data-testid="btn-payroll-add-employee"
          onClick={() => setEditing("new")}
        >
          Add employee
        </Button>
      </div>
      <Panel scroll={{ maxH: "58vh" }}>
        {!employees?.length ? (
          <EmptyState
            title="No employees yet"
            hint="Add employees with their monthly salary structure, then post a pay run"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Designation</th>
                <th className="r w-28">Basic</th>
                <th className="r w-28">HRA</th>
                <th className="r w-28">Special</th>
                <th className="r w-28">Gross / mo</th>
                <th className="w-44"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-payroll-employees">
              {employees.map((e) => (
                <tr
                  key={e.id}
                  data-row-id={e.id}
                  className={e.active ? "" : "opacity-50"}
                >
                  <td>
                    {e.name}
                    {!e.active && (
                      <span className="ml-2 text-[11px] text-muted">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="text-muted">{e.designation}</td>
                  <td className="r">
                    <Money paise={e.basic} />
                  </td>
                  <td className="r">
                    <Money paise={e.hra} />
                  </td>
                  <td className="r">
                    <Money paise={e.special} />
                  </td>
                  <td className="r font-medium">
                    <Money paise={e.basic + e.hra + e.special} />
                  </td>
                  <td className="r">
                    <button
                      className="mr-3 text-[12px] text-muted hover:text-ink"
                      data-testid="btn-payroll-overrides"
                      onClick={() => setOverridesFor(e)}
                    >
                      Heads
                    </button>
                    <button
                      className="mr-3 text-[12px] text-blue hover:underline"
                      data-testid="btn-payroll-edit-employee"
                      onClick={() => setEditing(e)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-[12px] text-cr hover:underline"
                      data-testid="btn-payroll-delete-employee"
                      onClick={() => void remove(e)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && (
        <EmployeeModal
          employee={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {headsOpen && <PayHeadsModal onClose={() => setHeadsOpen(false)} />}
      {overridesFor && (
        <EmployeeHeadsModal
          employee={overridesFor}
          onClose={() => setOverridesFor(null)}
        />
      )}
    </>
  );
}

function EmployeeModal({
  employee,
  onClose,
}: {
  employee: Employee | null;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [name, setName] = useState(employee?.name ?? "");
  const [designation, setDesignation] = useState(employee?.designation ?? "");
  const [code, setCode] = useState(employee?.code ?? "");
  const [pan, setPan] = useState(employee?.pan ?? "");
  const [uan, setUan] = useState(employee?.uan ?? "");
  const [basic, setBasic] = useState<number | null>(employee?.basic ?? null);
  const [hra, setHra] = useState<number | null>(employee?.hra ?? null);
  const [special, setSpecial] = useState<number | null>(
    employee?.special ?? null,
  );
  const [bankAccount, setBankAccount] = useState(employee?.bankAccount ?? "");
  const [bankIfsc, setBankIfsc] = useState(employee?.bankIfsc ?? "");
  const [department, setDepartment] = useState(employee?.department ?? "");
  const [pfEnabled, setPf] = useState(employee?.pfEnabled ?? true);
  const [esiEnabled, setEsi] = useState(employee?.esiEnabled ?? true);
  const [ptEnabled, setPt] = useState(employee?.ptEnabled ?? true);
  const [active, setActive] = useState(employee?.active ?? true);

  const save = async (): Promise<void> => {
    try {
      await api.payroll.saveEmployee(
        {
          name: name.trim(),
          code: code.trim() || null,
          designation: designation.trim() || null,
          joined: employee?.joined ?? null,
          pan: pan.trim() || null,
          uan: uan.trim() || null,
          esicNo: employee?.esicNo ?? null,
          bankAccount: bankAccount.trim() || null,
          bankIfsc: bankIfsc.trim().toUpperCase() || null,
          department: department.trim() || null,
          exitDate: employee?.exitDate ?? null,
          basic: basic ?? 0,
          hra: hra ?? 0,
          special: special ?? 0,
          pfEnabled,
          esiEnabled,
          ptEnabled,
          active,
        },
        employee?.id,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["employees"] }),
        queryClient.invalidateQueries({ queryKey: ["payrollPreview"] }),
        queryClient.invalidateQueries({ queryKey: ["employeeHeads"] }),
      ]);
      toast.push("success", `${name.trim()} saved`);
      onClose();
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const check = (
    label: string,
    value: boolean,
    set: (v: boolean) => void,
  ): React.JSX.Element => (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => set(e.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <Modal
      title={employee ? `Edit ${employee.name}` : "Add employee"}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Designation">
            <TextInput
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Employee code">
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="num"
            />
          </Field>
          <Field label="PAN">
            <TextInput
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              className="num"
            />
          </Field>
          <Field label="UAN">
            <TextInput
              value={uan}
              onChange={(e) => setUan(e.target.value)}
              className="num"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Department">
            <TextInput
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
          </Field>
          <Field label="Bank account">
            <TextInput
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              className="num"
            />
          </Field>
          <Field label="IFSC">
            <TextInput
              value={bankIfsc}
              onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
              className="num uppercase"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Basic / month">
            <AmountInput paise={basic} onPaise={setBasic} />
          </Field>
          <Field label="HRA / month">
            <AmountInput paise={hra} onPaise={setHra} />
          </Field>
          <Field label="Special / month">
            <AmountInput paise={special} onPaise={setSpecial} />
          </Field>
        </div>
        <div className="flex gap-5">
          {check("EPF", pfEnabled, setPf)}
          {check("ESI", esiEnabled, setEsi)}
          {check("Professional tax", ptEnabled, setPt)}
          {check("Active", active, setActive)}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-payroll-save-employee"
            onClick={() => void save()}
          >
            Save employee
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- pay heads (masters) ----------

/** Percent-of-basic values are stored as percent × 100 (4000 = 40%). */
function percentLabel(value: number): string {
  return `${(value / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function PayHeadsModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: heads } = useQuery({
    queryKey: ["payHeads"],
    queryFn: api.payroll.heads.list,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"earning" | "deduction">("earning");
  const [calc, setCalc] = useState<"flat" | "percent_of_basic">("flat");
  const [flatPaise, setFlatPaise] = useState<number | null>(null);
  const [percentText, setPercentText] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const invalidate = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payHeads"] }),
      queryClient.invalidateQueries({ queryKey: ["employeeHeads"] }),
      queryClient.invalidateQueries({ queryKey: ["payrollPreview"] }),
    ]).then(() => undefined);

  const resetForm = (): void => {
    setEditingId(null);
    setName("");
    setKind("earning");
    setCalc("flat");
    setFlatPaise(null);
    setPercentText("");
    setActive(true);
  };

  const edit = (h: PayHead): void => {
    setEditingId(h.id);
    setName(h.name);
    setKind(h.kind);
    setCalc(h.calc);
    setFlatPaise(h.calc === "flat" ? h.value : null);
    setPercentText(h.calc === "percent_of_basic" ? String(h.value / 100) : "");
    setActive(h.active);
  };

  const percentInvalid =
    calc === "percent_of_basic" &&
    (percentText.trim() === "" ||
      !Number.isFinite(Number(percentText)) ||
      Number(percentText) < 0 ||
      Number(percentText) > 100);

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push("error", "Name the pay head");
    let value: number;
    if (calc === "flat") {
      value = flatPaise ?? 0;
    } else {
      if (percentInvalid)
        return void toast.push("error", "Percent must be between 0 and 100");
      value = Math.round(Number(percentText) * 100);
    }
    setSaving(true);
    try {
      await api.payroll.heads.save(
        { name: name.trim(), kind, calc, value, active },
        editingId ?? undefined,
      );
      await invalidate();
      toast.push(
        "success",
        editingId ? "Pay head updated" : "Pay head created",
      );
      resetForm();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (h: PayHead): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Delete pay head",
      message: `Delete "${h.name}"? Employees assigned this head lose it.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!proceed) return;
    try {
      await api.payroll.heads.remove(h.id);
      await invalidate();
      if (editingId === h.id) resetForm();
      toast.push("success", `${h.name} deleted`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <Modal title="Pay heads" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {!heads?.length ? (
          <EmptyState
            title="No pay heads yet"
            hint="Add earnings (e.g. Conveyance) or deductions (e.g. Canteen) beyond the built-in salary structure"
          />
        ) : (
          <ScrollList maxH="38vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="w-24">Kind</th>
                  <th className="w-36">Calculation</th>
                  <th className="r w-32">Value</th>
                  <th className="w-16">Active</th>
                  <th className="w-28"></th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-heads">
                {heads.map((h) => (
                  <tr key={h.id} data-row-id={h.id} className="hover:bg-panel2">
                    <td>{h.name}</td>
                    <td className="capitalize text-muted">{h.kind}</td>
                    <td className="text-muted">
                      {h.calc === "flat" ? "Flat / month" : "% of basic"}
                    </td>
                    <td className="num r">
                      {h.calc === "flat" ? (
                        <Money paise={h.value} />
                      ) : (
                        percentLabel(h.value)
                      )}
                    </td>
                    <td className="text-muted">{h.active ? "Yes" : "No"}</td>
                    <td className="r">
                      <button
                        className="mr-3 text-[12px] text-blue hover:underline"
                        onClick={() => edit(h)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[12px] text-cr hover:underline"
                        onClick={() => void remove(h)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollList>
        )}

        <div className="border-t border-line pt-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {editingId ? "Edit pay head" : "Add pay head"}
          </p>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Conveyance"
              />
            </Field>
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as "earning" | "deduction")
                }
              >
                <option value="earning">Earning</option>
                <option value="deduction">Deduction</option>
              </Select>
            </Field>
            <Field label="Calculation">
              <Select
                value={calc}
                onChange={(e) =>
                  setCalc(e.target.value as "flat" | "percent_of_basic")
                }
              >
                <option value="flat">Flat / month</option>
                <option value="percent_of_basic">% of basic</option>
              </Select>
            </Field>
            {calc === "flat" ? (
              <Field label="Amount / month">
                <AmountInput
                  paise={flatPaise}
                  onPaise={setFlatPaise}
                  testId="input-payroll-head-value"
                />
              </Field>
            ) : (
              <Field
                label="Percent of basic"
                error={
                  percentInvalid && percentText.trim() !== "" ? "0 – 100" : null
                }
              >
                <TextInput
                  value={percentText}
                  onChange={(e) => setPercentText(e.target.value)}
                  className="num text-right"
                  placeholder="e.g. 10"
                  data-testid="input-payroll-head-value"
                />
              </Field>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Active
            </label>
            <span className="flex gap-2">
              {editingId && <Button onClick={resetForm}>Cancel edit</Button>}
              <Button
                variant="primary"
                disabled={saving}
                data-testid="btn-payroll-save-head"
                onClick={() => void save()}
              >
                {editingId ? "Save changes" : "Add pay head"}
              </Button>
            </span>
          </div>
          <p className="mt-2 text-[11.5px] text-muted">
            Basic, HRA and Special Allowance are the built-in salary heads —
            their per-employee values live on the employee form and mirror here
            automatically.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------- per-employee head assignments ----------

interface HeadAssignment {
  assigned: boolean;
  /** Flat: paise. Percent: percent × 100. null = use the head's default value. */
  overrideValue: number | null;
}

function EmployeeHeadsModal({
  employee,
  onClose,
}: {
  employee: Employee;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: heads } = useQuery({
    queryKey: ["payHeads"],
    queryFn: api.payroll.heads.list,
  });
  const { data: assignedRows } = useQuery({
    queryKey: ["employeeHeads", employee.id],
    queryFn: () => api.payroll.employeeHeads.get(employee.id),
  });
  const [edits, setEdits] = useState<Record<number, HeadAssignment>>({});
  const [saving, setSaving] = useState(false);

  const loaded = heads !== undefined && assignedRows !== undefined;
  const assignedById = useMemo(
    () =>
      new Map(
        (assignedRows ?? []).map((r: EmployeeHeadRow) => [r.payHeadId, r]),
      ),
    [assignedRows],
  );

  const stateOf = (h: PayHead): HeadAssignment => {
    const edit = edits[h.id];
    if (edit) return edit;
    const row = assignedById.get(h.id);
    return row
      ? { assigned: true, overrideValue: row.overrideValue }
      : { assigned: false, overrideValue: null };
  };

  const setState = (headId: number, next: HeadAssignment): void =>
    setEdits((e) => ({ ...e, [headId]: next }));

  const save = async (): Promise<void> => {
    if (!heads) return;
    setSaving(true);
    try {
      const list = heads
        .map((h) => ({ head: h, s: stateOf(h) }))
        .filter(({ s }) => s.assigned)
        .map(({ head, s }) => ({
          payHeadId: head.id,
          overrideValue: s.overrideValue,
        }));
      await api.payroll.employeeHeads.set({
        employeeId: employee.id,
        heads: list,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["employeeHeads"] }),
        queryClient.invalidateQueries({ queryKey: ["employees"] }),
        queryClient.invalidateQueries({ queryKey: ["payrollPreview"] }),
      ]);
      toast.push("success", `${employee.name}'s pay heads saved`);
      onClose();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = Object.keys(edits).length > 0;

  return (
    <Modal
      title={`Pay heads — ${employee.name}`}
      onClose={onClose}
      wide
      dirty={dirty}
    >
      {!loaded ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Spinner /> Loading…
        </div>
      ) : !heads.length ? (
        <EmptyState
          title="No pay heads defined"
          hint="Create pay heads first (Employees tab → Pay heads…)"
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ScrollList maxH="48vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="w-10"></th>
                  <th>Head</th>
                  <th className="w-24">Kind</th>
                  <th className="r w-32">Default</th>
                  <th className="r w-44">
                    Override for {employee.name.split(" ")[0]}
                  </th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-employee-heads">
                {heads.map((h) => {
                  const s = stateOf(h);
                  return (
                    <tr
                      key={h.id}
                      data-row-id={h.id}
                      className={s.assigned ? "" : "opacity-50"}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={s.assigned}
                          onChange={(e) =>
                            setState(h.id, { ...s, assigned: e.target.checked })
                          }
                        />
                      </td>
                      <td>
                        {h.name}
                        {!h.active && (
                          <span className="ml-2 text-[11px] text-muted">
                            paused
                          </span>
                        )}
                      </td>
                      <td className="capitalize text-muted">{h.kind}</td>
                      <td className="num r">
                        {h.calc === "flat" ? (
                          <Money paise={h.value} />
                        ) : (
                          percentLabel(h.value)
                        )}
                      </td>
                      <td className="r">
                        {s.assigned && (
                          <OverrideInput
                            calc={h.calc}
                            value={s.overrideValue}
                            onChange={(v) =>
                              setState(h.id, { ...s, overrideValue: v })
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollList>
          <p className="text-[11.5px] text-muted">
            Empty override = the head's default value. Basic, HRA and Special
            Allowance overrides write back to the salary fields on the employee
            form.
          </p>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saving}
              data-testid="btn-payroll-save-overrides"
              onClick={() => void save()}
            >
              Save pay heads
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Override editor for one assignment: rupee amount for flat heads, percent for %-of-basic. */
function OverrideInput({
  calc,
  value,
  onChange,
}: {
  calc: "flat" | "percent_of_basic";
  value: number | null;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  const [text, setText] = useState(
    value == null
      ? ""
      : calc === "flat"
        ? formatPaise(value)
        : String(value / 100),
  );
  const commit = (raw: string): void => {
    const t = raw.trim();
    if (t === "") return void onChange(null);
    if (calc === "flat") {
      const paise = parseRupees(t);
      if (paise != null && paise >= 0) onChange(paise);
    } else {
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0 && n <= 100)
        onChange(Math.round(n * 100));
    }
  };
  return (
    <input
      className={`${inputCls} num w-36 text-right`}
      data-testid="input-payroll-override"
      value={text}
      placeholder="default"
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
    />
  );
}

// ---------- pay runs ----------

function RunsTab(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { data: employees } = useQuery({
    queryKey: ["employees"],
    queryFn: api.payroll.employees,
  });
  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: ["payrollRuns"],
    queryFn: api.payroll.runs,
  });
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [daysOverride, setDaysOverride] = useState<Record<number, string>>({});
  const [posting, setPosting] = useState(false);

  // Last 12 months, current first — replaces the free-text YYYY-MM field.
  const monthOptions = useMemo(() => {
    const [y, m] = todayISO().slice(0, 7).split("-").map(Number);
    return Array.from({ length: 12 }, (_, i) => {
      const total = (y ?? 2026) * 12 + ((m ?? 1) - 1) - i;
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
    });
  }, []);

  const active = (employees ?? []).filter((e) => e.active);
  const monthDays = daysInMonth(month);
  const alreadyRun = (runs ?? []).some((r) => r.month === month);

  // Per-employee payable days: validated inline, clamped copy goes to the server preview.
  const dayError = (raw: string | undefined): string | null => {
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return "Not a number";
    if (n < 0) return "Min 0";
    if (n > monthDays) return `Max ${monthDays}`;
    return null;
  };
  const anyDayInvalid = active.some(
    (e) => dayError(daysOverride[e.id]) !== null,
  );

  const daysPayload = useMemo(
    () =>
      active.map((e) => {
        const raw = daysOverride[e.id];
        const n = raw !== undefined && raw !== "" ? Number(raw) : monthDays;
        const safe = Number.isFinite(n)
          ? Math.min(monthDays, Math.max(0, n))
          : monthDays;
        return { employeeId: e.id, payableDays: safe };
      }),
    [active, daysOverride, monthDays],
  );

  // Server-side preview — the single payroll engine in src/main computes what a commit would post
  // (pay heads, ESI eligibility, PT slabs included), so preview and posted figures can't drift.
  const { data: previewLines, isFetching: previewFetching } = useQuery({
    queryKey: ["payrollPreview", month, daysPayload],
    queryFn: () => api.payroll.preview(month, daysPayload),
    enabled: active.length > 0,
    placeholderData: (prev) => prev,
  });
  const { data: preflight } = useQuery({
    queryKey: ["payrollPreflight", month, daysPayload],
    queryFn: () => api.payroll.preflight(month, daysPayload),
    enabled: active.length > 0,
    placeholderData: (previous) => previous,
  });
  const blockingIssues =
    preflight?.issues.filter((issue) => issue.severity === "error") ?? [];
  const linesByEmployee = new Map(
    (previewLines ?? []).map((l) => [l.employeeId, l]),
  );

  const totals = (previewLines ?? []).reduce(
    (acc, l) => ({
      gross: acc.gross + l.gross,
      deductions:
        acc.deductions + l.pfEmp + l.esiEmp + l.pt + l.otherDeductions,
      net: acc.net + l.net,
      cost: acc.cost + l.gross + l.pfEr + l.pfAdmin + l.edli + l.esiEr,
    }),
    { gross: 0, deductions: 0, net: 0, cost: 0 },
  );

  const post = async (): Promise<void> => {
    if (posting || anyDayInvalid) return;
    setPosting(true);
    try {
      const run = await api.payroll.commit(month, daysPayload);
      toast.push(
        "success",
        `Payroll for ${monthLabel(run.month)} posted — ${run.lines.length} employee${run.lines.length === 1 ? "" : "s"}`,
      );
      await queryClient.invalidateQueries();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <Panel className="mb-4 p-4">
        <div className="mb-3 flex items-end justify-between">
          <Field label="Month">
            <Select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-36"
              data-testid="payroll-month"
            >
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <span className="flex items-center gap-2">
            {previewFetching && <Spinner />}
            <Button
              variant="primary"
              data-testid="btn-payroll-post-run"
              disabled={
                alreadyRun ||
                active.length === 0 ||
                posting ||
                anyDayInvalid ||
                blockingIssues.length > 0
              }
              disabledTitle={
                anyDayInvalid ? "Fix the days column first" : undefined
              }
              onClick={() => void post()}
            >
              {alreadyRun ? `Posted for ${monthLabel(month)}` : "Post payroll"}
            </Button>
          </span>
        </div>
        {active.length === 0 ? (
          <EmptyState title="No active employees" />
        ) : (
          <ScrollList maxH="46vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="r w-24">Days</th>
                  <th className="r w-32">Gross</th>
                  <th className="r w-24">PF</th>
                  <th className="r w-24">ESI</th>
                  <th className="r w-20">PT</th>
                  <th className="r w-32">Net pay</th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-preview">
                {active.map((e) => {
                  const line = linesByEmployee.get(e.id);
                  const err = dayError(daysOverride[e.id]);
                  return (
                    <tr key={e.id} data-row-id={e.id}>
                      <td>{e.name}</td>
                      <td className="r">
                        <input
                          type="number"
                          min={0}
                          max={monthDays}
                          step={0.5}
                          data-testid="input-payroll-days"
                          aria-invalid={err ? true : undefined}
                          className={`num w-16 rounded border px-1.5 py-0.5 text-right text-[12.5px] bg-panel2 ${err ? "border-cr/70" : "border-line"}`}
                          value={daysOverride[e.id] ?? String(monthDays)}
                          onChange={(ev) =>
                            setDaysOverride((d) => ({
                              ...d,
                              [e.id]: ev.target.value,
                            }))
                          }
                        />
                        {err && (
                          <span className="block text-hint text-cr">{err}</span>
                        )}
                      </td>
                      <td className="r">
                        {line ? <Money paise={line.gross} /> : "—"}
                      </td>
                      <td className="r">
                        {line ? <Money paise={line.pfEmp} /> : "—"}
                      </td>
                      <td className="r">
                        {line ? <Money paise={line.esiEmp} /> : "—"}
                      </td>
                      <td className="r">
                        {line ? <Money paise={line.pt} /> : "—"}
                      </td>
                      <td className="r font-medium">
                        {line ? <Money paise={line.net} /> : "—"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="total-row">
                  <td>
                    Total · employer cost <Money paise={totals.cost} />
                  </td>
                  <td></td>
                  <td className="r">
                    <Money paise={totals.gross} />
                  </td>
                  <td className="r" colSpan={3}>
                    <Money paise={totals.deductions} />
                  </td>
                  <td className="r">
                    <Money paise={totals.net} />
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollList>
        )}
      </Panel>

      {preflight && preflight.issues.length > 0 && (
        <Panel className="mb-4 overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-4 py-2.5">
            <div>
              <p className="text-[11.5px] font-semibold">Payroll preflight</p>
              <p className="text-[9.5px] text-muted">
                Attendance, salary, bank, statutory identity and net-pay
                readiness before posting.
              </p>
            </div>
            <span
              className={`rounded border px-2 py-1 text-[9px] font-semibold uppercase ${blockingIssues.length ? "border-cr/35 bg-cr/5 text-cr" : "border-amber/35 bg-amber/5 text-ink"}`}
            >
              {blockingIssues.length
                ? `${blockingIssues.length} blocking`
                : `${preflight.issues.length} warnings`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 px-4 py-2">
            {preflight.issues.map((issue, index) => (
              <div
                key={`${issue.employeeId}:${issue.category}:${index}`}
                className="flex gap-2 border-b border-line/60 py-2 text-[10.5px]"
              >
                <span
                  className={
                    issue.severity === "error" ? "text-cr" : "text-amber"
                  }
                >
                  {issue.severity === "error" ? "●" : "▲"}
                </span>
                <span>
                  <b>{issue.employeeName ?? "Payroll"}</b>
                  <span className="ml-2 text-muted">{issue.message}</span>
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel scroll={{ maxH: "52vh" }}>
        <p className="border-b border-line px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Posted runs
        </p>
        {runsLoading ? (
          <SkeletonRows rows={3} />
        ) : !runs?.length ? (
          <EmptyState title="Nothing posted yet" />
        ) : (
          runs.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </Panel>
    </>
  );
}

function RunRow({ run }: { run: PayrollRun }): React.JSX.Element {
  const toast = useToasts();
  const nav = useNav();
  const queryClient = useQueryClient();
  const [ptOpen, setPtOpen] = useState(false);
  const { data: tieOut } = useQuery({
    queryKey: ["payrollTieOut", run.id],
    queryFn: () => api.payroll.tieOut(run.id),
  });

  const exportFile = async (kind: "ecr" | "esi"): Promise<void> => {
    try {
      const r =
        kind === "ecr"
          ? await api.payroll.ecr(run.id)
          : await api.payroll.esiCsv(run.id);
      toast.push(
        "success",
        `${kind === "ecr" ? "PF ECR" : "ESI CSV"}: ${r.path}`,
      );
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const remove = async (): Promise<void> => {
    const proceed = await confirmDialog({
      title: "Delete pay run",
      message: `Delete the ${monthLabel(run.month)} pay run and its voucher?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!proceed) return;
    try {
      await api.payroll.removeRun(run.id);
      await queryClient.invalidateQueries();
      toast.push("success", `${monthLabel(run.month)} pay run deleted`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };
  const lock = async (): Promise<void> => {
    try {
      await api.payroll.lockRun(run.id);
      await queryClient.invalidateQueries({ queryKey: ["payrollRuns"] });
      toast.push("success", `${monthLabel(run.month)} payroll locked`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <div
      className="border-b border-line/50 px-4 py-2.5 last:border-b-0"
      data-row-id={run.id}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{monthLabel(run.month)}</span>
        <span className="flex items-center gap-3 text-[12px]">
          <Money paise={run.lines.reduce((s, l) => s + l.net, 0)} />
          <span
            className={`rounded border px-2 py-0.5 text-[9px] font-semibold uppercase ${tieOut?.reconciled ? "border-dr/25 bg-dr/5 text-dr" : "border-cr/25 bg-cr/5 text-cr"}`}
          >
            {tieOut?.reconciled ? "Books tied" : "Checking tie-out"}
          </span>
          {run.lockedAt ? (
            <span className="rounded border border-ink/20 px-2 py-0.5 text-[9px] font-semibold uppercase">
              Locked
            </span>
          ) : (
            <Button
              variant="ghost"
              disabled={!tieOut?.reconciled}
              onClick={() => void lock()}
            >
              Lock run
            </Button>
          )}
          {run.voucherId && (
            <button
              className="text-blue hover:underline"
              data-testid="btn-payroll-voucher"
              onClick={() =>
                nav.go({ name: "voucher-entry", voucherId: run.voucherId! })
              }
            >
              Voucher
            </button>
          )}
          <ActionMenu
            ariaLabel={`Payslips for ${monthLabel(run.month)}`}
            testId="btn-payroll-payslips"
            triggerClassName="inline-flex items-center gap-0.5 text-blue hover:underline"
            trigger={
              <>
                Payslips <CaretDown size={11} weight="bold" aria-hidden="true" />
              </>
            }
            contentClassName="w-56 max-h-[40vh] overflow-y-auto"
            items={[
              ...(run.lockedAt
                ? [
                    {
                      id: "delivery-pack",
                      label: "Export delivery pack",
                      onSelect: () => {
                        void api.payroll
                          .payslipPack(run.id)
                          .then((result) =>
                            toast.push(
                              "success",
                              `Delivery pack: ${result.folder}`,
                            ),
                          )
                          .catch((error: Error) =>
                            toast.push("error", error.message),
                          );
                      },
                    },
                  ]
                : []),
              ...run.lines.map((line, index) => ({
                id: `employee-${line.id}`,
                label: line.employeeName,
                dividerBefore: run.lockedAt != null && index === 0,
                title: "Open payslip PDF",
                onSelect: () => {
                  void api.payroll
                    .payslip(run.id, line.employeeId)
                    .catch((error: Error) =>
                      toast.push("error", error.message),
                    );
                },
              })),
            ]}
          />
          <button
            className="text-muted hover:text-ink"
            data-testid="btn-payroll-ecr"
            onClick={() => void exportFile("ecr")}
            title="EPFO ECR upload file"
          >
            PF ECR
          </button>
          <button
            className="text-muted hover:text-ink"
            data-testid="btn-payroll-esi"
            onClick={() => void exportFile("esi")}
            title="ESIC upload CSV"
          >
            ESI CSV
          </button>
          <button
            className="text-muted hover:text-ink"
            data-testid="btn-payroll-pt"
            onClick={() => setPtOpen(true)}
            title="Professional tax summary by state"
          >
            PT
          </button>
          {!run.lockedAt && (
            <button
              className="text-cr hover:underline"
              data-testid="btn-payroll-delete-run"
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
        </span>
      </div>
      {ptOpen && <PtSummaryModal run={run} onClose={() => setPtOpen(false)} />}
    </div>
  );
}

function PtSummaryModal({
  run,
  onClose,
}: {
  run: PayrollRun;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["ptSummary", run.id],
    queryFn: () => api.payroll.ptSummary(run.id),
  });

  const exportCsv = async (): Promise<void> => {
    try {
      const r = await api.payroll.ptCsv(run.id);
      toast.push("success", `PT return CSV: ${r.path}`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <Modal
      title={`Professional tax — ${monthLabel(run.month)}`}
      onClose={onClose}
    >
      {isLoading || !rows ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Spinner /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No professional tax this run" />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>State</th>
              <th className="r w-28">Employees</th>
              <th className="r w-32">Gross</th>
              <th className="r w-32">PT payable</th>
            </tr>
          </thead>
          <tbody data-testid="rows-payroll-pt">
            {rows.map((r) => (
              <tr key={r.state}>
                <td>{r.state}</td>
                <td className="num r">{r.employees}</td>
                <td className="r">
                  <Money paise={r.gross} />
                </td>
                <td className="r font-medium">
                  <Money paise={r.pt} />
                </td>
              </tr>
            ))}
            <tr className="total-row">
              <td>Total</td>
              <td className="num r">
                {rows.reduce((s, r) => s + r.employees, 0)}
              </td>
              <td className="r">
                <Money paise={rows.reduce((s, r) => s + r.gross, 0)} />
              </td>
              <td className="r">
                <Money paise={rows.reduce((s, r) => s + r.pt, 0)} />
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {rows && rows.length > 0 && (
        <div className="mt-4 flex justify-end border-t border-line pt-3">
          <Button
            data-testid="btn-payroll-pt-csv"
            onClick={() => void exportCsv()}
            title="State-wise PT return CSV (exports folder)"
          >
            Export PT return CSV
          </Button>
        </div>
      )}
    </Modal>
  );
}
