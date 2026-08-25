import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle,
  Clock,
  Export,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
  TextInput,
} from "../components/ui";
import { toDisplayDate, toDisplayDateTime, todayISO } from "@shared/dates";
import type {
  ExportFormat,
  ExportPermissionMatrix,
  PolicyKind,
  RetentionPolicy,
  ReviewQuestion,
} from "@shared/internalControls";

type Tab =
  "overview" | "review" | "signoff" | "exceptions" | "access" | "evidence";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "review", label: "Review inbox" },
  { id: "signoff", label: "Period sign-off" },
  { id: "exceptions", label: "Exceptions" },
  { id: "access", label: "Access" },
  { id: "evidence", label: "Evidence" },
];

function monthBounds(month: string): { from: string; to: string } {
  const [year, n] = month.split("-").map(Number);
  return {
    from: `${month}-01`,
    to: `${month}-${String(new Date(Date.UTC(year!, n!, 0)).getUTCDate()).padStart(2, "0")}`,
  };
}

export function ControlRoomScreen(): React.JSX.Element {
  const { from, to, user } = useSession();
  const [tab, setTab] = useState<Tab>("overview");
  const report = useQuery({
    queryKey: ["controlReport", from, to],
    queryFn: () => api.controls.report(from, to),
  });
  const owner = !user || user.role === "owner";
  return (
    <div className="mx-auto max-w-7xl" data-testid="control-room">
      <SectionTitle
        right={
          <span className="num text-[11px] text-muted">
            {toDisplayDate(from)} — {toDisplayDate(to)}
          </span>
        }
      >
        Control room
      </SectionTitle>
      <div className="mb-4 grid gap-3 lg:grid-cols-[1.45fr_0.55fr]">
        <Panel className="relative overflow-hidden !bg-ink px-6 py-5 text-[var(--t-panel)]">
          <div className="absolute -right-14 -top-24 size-56 rounded-full border border-panel/10" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-panel/50">
            Review status
          </p>
          <div className="mt-3 flex items-end justify-between gap-8">
            <div>
              <p className="font-serif text-[29px] font-semibold tracking-[-0.025em]">
                {report.data?.openQuestions ?? "—"} open review
                {report.data?.openQuestions === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-[11.5px] text-panel/55">
                {report.data?.overdueQuestions ?? 0} overdue ·{" "}
                {report.data?.pendingExceptions ?? 0} override decisions waiting
              </p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-[0.12em] text-panel/45">
                Period review
              </p>
              <p className="mt-1 text-[13px] font-semibold capitalize text-amberbar">
                {report.data?.periodSignoffStatus.replace("_", " ") ??
                  "Checking"}
              </p>
            </div>
          </div>
        </Panel>
        <Panel className="px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Audit controls
          </p>
          <p className="mt-2 text-[12px] leading-5 text-muted">
            Questions, decisions, access and evidence stay outside the books
            while remaining attributable and tamper-evident.
          </p>
          <div className="mt-3 flex items-center gap-2 text-[11px] font-medium text-dr">
            <ShieldCheck size={16} weight="duotone" />
            Audit chain enforced
          </div>
        </Panel>
      </div>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((item) => (
          <button
            key={item.id}
            data-testid={`control-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`border-b-2 px-3 py-2 text-[11.5px] font-medium whitespace-nowrap ${tab === item.id ? "border-amberbar text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview report={report.data} onTab={setTab} />}{" "}
      {tab === "review" && <ReviewInbox />} {tab === "signoff" && <Signoff />}
      {tab === "exceptions" && <Exceptions owner={owner} />}{" "}
      {tab === "access" && <Access owner={owner} />}{" "}
      {tab === "evidence" && <Evidence owner={owner} />}
    </div>
  );
}

function Overview({
  report,
  onTab,
}: {
  report: Awaited<ReturnType<typeof api.controls.report>> | undefined;
  onTab: (tab: Tab) => void;
}): React.JSX.Element {
  const rows = [
    {
      label: "Approved overrides",
      value: report?.overrides ?? 0,
      icon: WarningCircle,
      tab: "exceptions" as Tab,
    },
    {
      label: "Deleted drafts",
      value: report?.deletedDrafts ?? 0,
      icon: Archive,
      tab: "review" as Tab,
    },
    {
      label: "Reversals",
      value: report?.reversals ?? 0,
      icon: Clock,
      tab: "overview" as Tab,
    },
    {
      label: "Late postings",
      value: report?.latePostings ?? 0,
      icon: Clock,
      tab: "review" as Tab,
    },
    {
      label: "Privileged actions",
      value: report?.privilegedActions ?? 0,
      icon: LockKey,
      tab: "access" as Tab,
    },
  ];
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_0.55fr]">
      <Panel className="overflow-hidden p-0">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-[12.5px] font-semibold">
            Period control summary
          </h3>
          <p className="mt-0.5 text-[10.5px] text-muted">
            Signals worth reviewing before close—not accounting totals.
          </p>
        </div>
        <div className="grid grid-cols-5 gap-px bg-line">
          {rows.map(({ label, value, icon: Icon, tab }) => (
            <button
              key={label}
              onClick={() => onTab(tab)}
              className="bg-panel px-4 py-4 text-left hover:bg-panel2"
            >
              <Icon size={17} className={value ? "text-amber" : "text-muted"} />
              <p className="num mt-3 text-[22px] font-semibold">{value}</p>
              <p className="mt-1 text-[10.5px] text-muted">{label}</p>
            </button>
          ))}
        </div>
      </Panel>
      <Panel className="p-4">
        <h3 className="text-[12.5px] font-semibold">Suggested next action</h3>
        <div className="mt-3 space-y-2">
          {report?.overdueQuestions ? (
            <Action
              label={`Resolve ${report.overdueQuestions} overdue question${report.overdueQuestions === 1 ? "" : "s"}`}
              onClick={() => onTab("review")}
            />
          ) : report?.pendingExceptions ? (
            <Action
              label={`Decide ${report.pendingExceptions} policy exception${report.pendingExceptions === 1 ? "" : "s"}`}
              onClick={() => onTab("exceptions")}
            />
          ) : report?.periodSignoffStatus !== "reviewed" ? (
            <Action
              label="Prepare and review the period sign-off"
              onClick={() => onTab("signoff")}
            />
          ) : (
            <p className="flex items-center gap-2 py-4 text-[11.5px] text-dr">
              <CheckCircle size={17} weight="fill" />
              No immediate control action
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
function Action({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md border border-line bg-panel2 px-3 py-2.5 text-left text-[11.5px] font-medium hover:border-amber/50"
    >
      <span>{label}</span>
      <span>→</span>
    </button>
  );
}

function ReviewInbox(): React.JSX.Element {
  const nav = useNav(),
    toast = useToasts(),
    qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [answering, setAnswering] = useState<ReviewQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const query = useQuery({
    queryKey: ["controlReviews"],
    queryFn: () => api.controls.reviews(),
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["controlReviews"] });
    await qc.invalidateQueries({ queryKey: ["controlReport"] });
  };
  const submitAnswer = async () => {
    if (!answering || answer.trim().length < 2) return;
    try {
      await api.controls.reviewAnswer(answering.id, answer.trim());
      setAnswering(null);
      setAnswer("");
      await refresh();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const resolve = async (row: ReviewQuestion) => {
    try {
      await api.controls.reviewResolve(row.id);
      toast.push("success", "Review question resolved");
      await refresh();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-between">
        <div>
          <p className="text-[12px] font-semibold">Voucher review inbox</p>
          <p className="text-[10.5px] text-muted">
            Ask, answer, then independently resolve.
          </p>
        </div>
        <Button
          variant="primary"
          data-testid="btn-review-new"
          onClick={() => setCreating(true)}
        >
          New question
        </Button>
      </div>
      <Panel className="overflow-hidden p-0">
        {!query.data?.length ? (
          <EmptyState
            title="No review questions"
            hint="Use questions to retain review ownership and evidence outside voucher narration."
          />
        ) : (
          query.data.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[1fr_160px_200px] items-center gap-4 border-b border-line px-4 py-3 last:border-0"
            >
              <button
                className="min-w-0 text-left"
                onClick={() =>
                  nav.go({ name: "voucher-entry", voucherId: row.voucherId })
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`size-1.5 rounded-full ${row.priority === "urgent" ? "bg-cr" : row.priority === "high" ? "bg-amber" : "bg-blue"}`}
                  />
                  <b className="truncate text-[12px]">{row.question}</b>
                </span>
                <span className="mt-1 block text-[10.5px] text-muted">
                  {row.voucherNumber} · {toDisplayDate(row.voucherDate)} ·
                  raised by {row.createdBy}
                </span>
                {row.answer && (
                  <span className="mt-1 block truncate text-[10.5px] text-dr">
                    Answer: {row.answer}
                  </span>
                )}
              </button>
              <span className="text-[10.5px] text-muted">
                {row.assignedToName ?? "Unassigned"}
                {row.dueDate ? (
                  <>
                    <br />
                    Due {toDisplayDate(row.dueDate)}
                  </>
                ) : null}
              </span>
              <div className="flex justify-end gap-2">
                <span className="rounded-full border border-line px-2 py-1 text-[9.5px] capitalize text-muted">
                  {row.status}
                </span>
                {row.status === "open" && (
                  <Button onClick={() => setAnswering(row)}>Answer</Button>
                )}
                {row.status === "answered" && (
                  <Button variant="primary" onClick={() => void resolve(row)}>
                    Resolve
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>
      {creating && (
        <ReviewCreate onClose={() => setCreating(false)} onSaved={refresh} />
      )}{" "}
      {answering && (
        <Modal
          title="Answer review question"
          onClose={() => setAnswering(null)}
        >
          <p className="mb-3 text-[11.5px] text-muted">{answering.question}</p>
          <textarea
            autoFocus
            className="min-h-28 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-[12px] outline-none focus:border-amber"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setAnswering(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void submitAnswer()}>
              Submit answer
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ReviewCreate({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users.list });
  const [voucherId, setVoucherId] = useState("");
  const [question, setQuestion] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<"normal" | "high" | "urgent">(
    "normal",
  );
  const save = async () => {
    try {
      await api.controls.reviewCreate({
        voucherId: Number(voucherId),
        question,
        assignedToUserId: assignee ? Number(assignee) : null,
        dueDate: due || null,
        priority,
      });
      toast.push("success", "Question added to review inbox");
      await onSaved();
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="New voucher question" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Voucher ID">
          <TextInput
            data-testid="review-voucher-id"
            inputMode="numeric"
            value={voucherId}
            onChange={(e) => setVoucherId(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Field label="Priority">
          <Select
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>
        <div className="col-span-2">
          <Field label="Question">
            <textarea
              data-testid="review-question"
              className="min-h-24 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-[12px] outline-none focus:border-amber"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Assign to">
          <Select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Unassigned</option>
            {(users.data ?? [])
              .filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Due date">
          <DateInput value={due} context={todayISO()} onChange={setDue} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="review-save"
          disabled={!voucherId || question.trim().length < 3}
          onClick={() => void save()}
        >
          Add question
        </Button>
      </div>
    </Modal>
  );
}

function Signoff(): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient();
  const { user } = useSession();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const period = useMemo(() => monthBounds(month), [month]);
  const query = useQuery({
    queryKey: ["controlSignoff", period.from, period.to],
    queryFn: () => api.controls.signoff(period.from, period.to),
  });
  const [issues, setIssues] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    const row = query.data;
    setIssues(row?.outstandingIssues.join("\n") ?? "");
    setEvidence(row?.evidence.join("\n") ?? "");
    setNote(row?.reviewNote ?? "");
  }, [query.data]);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["controlSignoff"] });
    await qc.invalidateQueries({ queryKey: ["controlReport"] });
  };
  const act = async (kind: "prepare" | "review" | "reopen") => {
    try {
      if (kind === "prepare")
        await api.controls.signoffPrepare({
          ...period,
          outstandingIssues: issues
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          evidence: evidence
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        });
      else if (kind === "review")
        await api.controls.signoffReview(period.from, period.to, note);
      else await api.controls.signoffReopen(period.from, period.to, note);
      toast.push(
        "success",
        kind === "prepare"
          ? "Period prepared for review"
          : kind === "review"
            ? "Period independently signed off"
            : "Sign-off reopened",
      );
      await refresh();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  const row = query.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[0.72fr_1.28fr]">
      <Panel className="p-4">
        <Field label="Close month">
          <TextInput
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </Field>
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[10px] uppercase tracking-[0.1em] text-muted">
            Status
          </p>
          <p className="mt-1 font-serif text-[24px] font-semibold capitalize">
            {row?.status ?? "Not started"}
          </p>
          {row?.preparedBy && (
            <p className="mt-2 text-[10.5px] text-muted">
              Prepared by {row.preparedBy}
              {row.preparedAt
                ? ` · ${toDisplayDateTime(new Date(row.preparedAt))}`
                : ""}
            </p>
          )}
          {row?.reviewedBy && (
            <p className="mt-1 text-[10.5px] text-dr">
              Reviewed by {row.reviewedBy}
            </p>
          )}
        </div>
      </Panel>
      <Panel className="p-5">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Outstanding issues"
            hint="One issue per line; disclosure is allowed, silence is not."
          >
            <textarea
              className="min-h-28 w-full rounded-md border border-line bg-panel2 p-3 text-[12px]"
              value={issues}
              onChange={(e) => setIssues(e.target.value)}
            />
          </Field>
          <Field
            label="Evidence references"
            hint="Backup names, file paths, acknowledgement IDs or working-paper references."
          >
            <textarea
              className="min-h-28 w-full rounded-md border border-line bg-panel2 p-3 text-[12px]"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Reviewer note / reopen reason">
          <TextInput
            className="mt-3"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          {row?.status === "reviewed" ? (
            <Button
              variant="danger"
              disabled={user?.role !== "owner" || note.trim().length < 5}
              onClick={() => void act("reopen")}
            >
              Reopen with reason
            </Button>
          ) : (
            <>
              <Button
                data-testid="btn-signoff-prepare"
                onClick={() => void act("prepare")}
              >
                Prepare
              </Button>
              <Button
                data-testid="btn-signoff-review"
                variant="primary"
                disabled={row?.status !== "prepared" || user?.role !== "owner"}
                onClick={() => void act("review")}
              >
                Review & sign off
              </Button>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Exceptions({ owner }: { owner: boolean }): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  const query = useQuery({
    queryKey: ["controlExceptions"],
    queryFn: () => api.controls.exceptions(),
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["controlExceptions"] });
    await qc.invalidateQueries({ queryKey: ["controlReport"] });
  };
  const decide = async (id: number, approved: boolean) => {
    try {
      await api.controls.exceptionDecide(
        id,
        approved,
        approved ? "Evidence reviewed" : "Request does not meet policy",
      );
      await refresh();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-between">
        <div>
          <p className="text-[12px] font-semibold">Policy exception register</p>
          <p className="text-[10.5px] text-muted">
            An approved exception is evidence, not a silent bypass.
          </p>
        </div>
        <Button variant="primary" onClick={() => setRequesting(true)}>
          Request exception
        </Button>
      </div>
      <Panel className="overflow-hidden p-0">
        {!query.data?.length ? (
          <EmptyState title="No policy exceptions" />
        ) : (
          query.data.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[150px_1fr_210px] items-center gap-4 border-b border-line px-4 py-3 last:border-0"
            >
              <span>
                <b className="block text-[11px] capitalize">
                  {row.policyKind.replaceAll("_", " ")}
                </b>
                <span className="text-[9.5px] text-muted">
                  {row.entityType}
                  {row.entityId ? ` #${row.entityId}` : ""}
                </span>
              </span>
              <span>
                <span className="block text-[11.5px]">{row.reason}</span>
                <span className="text-[10px] text-muted">
                  {row.requestedBy} ·{" "}
                  {toDisplayDateTime(new Date(row.requestedAt))}
                </span>
              </span>
              <div className="flex justify-end gap-2">
                {row.status === "pending" && owner ? (
                  <>
                    <Button
                      variant="danger"
                      onClick={() => void decide(row.id, false)}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void decide(row.id, true)}
                    >
                      Approve
                    </Button>
                  </>
                ) : (
                  <span className="rounded-full border border-line px-2 py-1 text-[10px] capitalize text-muted">
                    {row.status}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>
      {requesting && (
        <ExceptionCreate
          onClose={() => setRequesting(false)}
          onSaved={refresh}
        />
      )}
    </>
  );
}
function ExceptionCreate({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [kind, setKind] = useState<PolicyKind>("validation_warning");
  const [entityType, setEntityType] = useState("voucher");
  const [entityId, setEntityId] = useState("");
  const [reason, setReason] = useState("");
  const save = async () => {
    try {
      await api.controls.exceptionRequest({
        policyKind: kind,
        entityType,
        entityId: entityId ? Number(entityId) : null,
        reason,
      });
      await onSaved();
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="Request policy exception" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Policy">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as PolicyKind)}
          >
            {[
              "period_lock",
              "credit_limit",
              "validation_warning",
              "negative_stock",
              "other",
            ].map((k) => (
              <option key={k} value={k}>
                {k.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Record type">
          <TextInput
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          />
        </Field>
        <Field label="Record ID (optional)">
          <TextInput
            inputMode="numeric"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <div className="col-span-2">
          <Field label="Business reason">
            <textarea
              className="min-h-24 w-full rounded-md border border-line bg-panel2 p-3 text-[12px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={reason.trim().length < 5}
          onClick={() => void save()}
        >
          Send for approval
        </Button>
      </div>
    </Modal>
  );
}

const EXPORT_FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: "pdf", label: "PDF", detail: "Print-ready reports and documents" },
  { id: "spreadsheet", label: "Spreadsheet", detail: "CSV and workbook data" },
  {
    id: "json_mirror",
    label: "JSON mirror",
    detail: "AI/agent-editable company mirror",
  },
  {
    id: "full_data",
    label: "Full data",
    detail: "CA packs and complete migrations",
  },
];
function Access({ owner }: { owner: boolean }): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ["controlSessions"],
    queryFn: api.controls.sessions,
    enabled: owner,
  });
  const exports = useQuery({
    queryKey: ["controlExportPermissions"],
    queryFn: api.controls.exportPermissions,
  });
  const [matrix, setMatrix] = useState<ExportPermissionMatrix | null>(null);
  if (exports.data && !matrix)
    queueMicrotask(() => setMatrix(structuredClone(exports.data)));
  const save = async () => {
    if (!matrix) return;
    try {
      setMatrix(await api.controls.exportPermissionsSet(matrix));
      await qc.invalidateQueries({ queryKey: ["controlExportPermissions"] });
      toast.push("success", "Export permissions saved");
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-[12.5px] font-semibold">
              Export authority by format
            </h3>
            <p className="text-[10.5px] text-muted">
              Main-process enforced. Owner recovery access remains on.
            </p>
          </div>
          {matrix && (
            <>
              {EXPORT_FORMATS.map((format) => (
                <div
                  key={format.id}
                  className="grid grid-cols-[1fr_90px_110px_90px] items-center border-b border-line px-4 py-2.5"
                >
                  <span>
                    <b className="block text-[11.5px]">{format.label}</b>
                    <span className="text-[9.5px] text-muted">
                      {format.detail}
                    </span>
                  </span>
                  {(["owner", "accountant", "viewer"] as const).map((role) => (
                    <label
                      key={role}
                      className="text-center text-[9px] capitalize text-muted"
                    >
                      <span className="mb-1 block">{role}</span>
                      <input
                        type="checkbox"
                        checked={matrix[role][format.id]}
                        disabled={!owner || role === "owner"}
                        onChange={(e) =>
                          setMatrix({
                            ...matrix,
                            [role]: {
                              ...matrix[role],
                              [format.id]: e.target.checked,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              ))}
              <div className="flex justify-end p-3">
                <Button
                  variant="primary"
                  disabled={!owner}
                  onClick={() => void save()}
                >
                  Save export rights
                </Button>
              </div>
            </>
          )}
        </Panel>
        <Panel className="overflow-hidden p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-[12.5px] font-semibold">Device sessions</h3>
            <p className="text-[10.5px] text-muted">
              Current and recent activity on this installation.
            </p>
          </div>
          {!owner ? (
            <p className="p-4 text-[11px] text-muted">Owner access required.</p>
          ) : !sessions.data?.length ? (
            <EmptyState title="No session history" />
          ) : (
            sessions.data.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between border-b border-line px-4 py-3"
              >
                <span>
                  <b className="block text-[11.5px]">{row.userName}</b>
                  <span className="text-[9.5px] capitalize text-muted">
                    {row.role} · last{" "}
                    {toDisplayDateTime(new Date(row.lastActivityAt))}
                  </span>
                </span>
                <span
                  className={`rounded-full border px-2 py-1 text-[9px] capitalize ${row.lockState === "active" ? "border-dr/40 text-dr" : "border-line text-muted"}`}
                >
                  {row.lockState.replace("_", " ")}
                </span>
              </div>
            ))
          )}
        </Panel>
      </div>
      <BoundaryPanel owner={owner} />
    </>
  );
}

function BoundaryPanel({ owner }: { owner: boolean }): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient();
  const boundaries = useQuery({
    queryKey: ["controlBoundaries"],
    queryFn: api.controls.boundaries,
  });
  const voucherTypes = useQuery({
    queryKey: ["voucherTypes"],
    queryFn: api.voucherTypes.list,
  });
  const godowns = useQuery({
    queryKey: ["godowns"],
    queryFn: api.godowns.list,
  });
  const [role, setRole] = useState<"accountant" | "viewer">("accountant");
  const [kind, setKind] = useState<"voucher_type" | "godown">("voucher_type");
  const [id, setId] = useState("");
  const options =
    kind === "voucher_type" ? (voucherTypes.data ?? []) : (godowns.data ?? []);
  const add = async () => {
    try {
      await api.controls.boundarySet({
        role,
        dimensionKind: kind,
        dimensionId: Number(id),
        allowed: true,
      });
      setId("");
      await qc.invalidateQueries({ queryKey: ["controlBoundaries"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Panel className="mt-4 overflow-hidden p-0">
      <div className="flex items-start justify-between border-b border-line px-4 py-3">
        <div>
          <h3 className="text-[12.5px] font-semibold">Department boundaries</h3>
          <p className="text-[10.5px] text-muted">
            Once a role has boundaries for a dimension, only its listed records
            can be used. Nested IPC payloads are checked in the main process.
          </p>
        </div>
        {owner && (
          <div className="flex items-end gap-2">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
            >
              <option value="accountant">Accountant</option>
              <option value="viewer">Viewer</option>
            </Select>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setId("");
              }}
            >
              <option value="voucher_type">Voucher type</option>
              <option value="godown">Godown</option>
            </Select>
            <Select value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
            <Button disabled={!id} onClick={() => void add()}>
              Allow
            </Button>
          </div>
        )}
      </div>
      {!boundaries.data?.length ? (
        <EmptyState
          title="No department boundaries"
          hint="Accountant and viewer roles currently have company-wide scope."
        />
      ) : (
        <div className="grid grid-cols-3 gap-px bg-line">
          {boundaries.data.map((row) => (
            <div key={row.id} className="bg-panel px-4 py-3">
              <b className="block text-[11px] capitalize">
                {row.role} · {row.dimensionKind.replace("_", " ")}
              </b>
              <span className="text-[10px] text-muted">
                {row.dimensionName}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Evidence({ owner }: { owner: boolean }): React.JSX.Element {
  const toast = useToasts(),
    qc = useQueryClient();
  const { from, to } = useSession();
  const query = useQuery({
    queryKey: ["controlRetention"],
    queryFn: api.controls.retention,
    enabled: owner,
  });
  const [bundle, setBundle] = useState(false);
  const update = async (row: RetentionPolicy, keep: string) => {
    try {
      await api.controls.retentionSet({
        evidenceKind: row.evidenceKind,
        keepDays: keep ? Number(keep) : null,
        warnDays: row.warnDays,
        purgeRequiresApproval: row.purgeRequiresApproval,
      });
      await qc.invalidateQueries({ queryKey: ["controlRetention"] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-between">
        <div>
          <p className="text-[12px] font-semibold">Evidence lifecycle</p>
          <p className="text-[10.5px] text-muted">
            Defaults retain forever. Policies warn before eligibility; no
            automatic purge occurs.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!owner}
          onClick={() => setBundle(true)}
        >
          <Export size={14} /> Export review bundle
        </Button>
      </div>
      <Panel className="overflow-hidden p-0">
        {!owner ? (
          <p className="p-5 text-[11.5px] text-muted">Owner access required.</p>
        ) : (
          (query.data ?? []).map((row) => (
            <div
              key={row.evidenceKind}
              className="grid grid-cols-[1fr_180px_160px] items-center gap-4 border-b border-line px-4 py-3"
            >
              <span>
                <b className="block text-[11.5px] capitalize">
                  {row.evidenceKind.replaceAll("_", " ")}
                </b>
                <span className="text-[9.5px] text-muted">
                  {row.warningCount
                    ? `${row.warningCount} item(s) near policy age`
                    : "No evidence near policy age"}{" "}
                  · approval before purge
                </span>
              </span>
              <Select
                defaultValue={row.keepDays ?? ""}
                onChange={(e) => void update(row, e.target.value)}
              >
                <option value="">Keep forever</option>
                <option value="365">1 year</option>
                <option value="1095">3 years</option>
                <option value="2555">7 years</option>
                <option value="3650">10 years</option>
              </Select>
              <span className="text-right text-[9.5px] text-muted">
                Updated by {row.updatedBy}
              </span>
            </div>
          ))
        )}
      </Panel>
      {bundle && (
        <BundleModal from={from} to={to} onClose={() => setBundle(false)} />
      )}
    </>
  );
}
function BundleModal({
  from,
  to,
  onClose,
}: {
  from: string;
  to: string;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const result = await api.controls.reviewBundle(from, to, pass);
      toast.push(
        "success",
        `Encrypted bundle created with ${result.questionCount} questions`,
      );
      onClose();
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Encrypted review bundle" onClose={onClose}>
      <div className="rounded-md border border-blue/20 bg-blue/5 p-3 text-[11px] leading-5 text-muted">
        <b className="text-ink">Offline accountant exchange</b>
        <br />
        Includes period questions, sign-off evidence and relevant audit changes.
        AES-256-GCM encryption protects the file outside Total.
      </div>
      <Field
        label="Bundle passphrase"
        hint="At least 8 characters. Share it separately from the bundle file."
      >
        <TextInput
          autoFocus
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy || pass.length < 8}
          onClick={() => void save()}
        >
          {busy ? "Encrypting…" : "Create encrypted bundle"}
        </Button>
      </div>
    </Modal>
  );
}
