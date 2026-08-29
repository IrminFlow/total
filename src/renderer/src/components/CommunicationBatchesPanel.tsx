import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  CheckCircle,
  Checks,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  Stack,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  CommunicationBatch,
  CommunicationBatchDocumentKind,
  CommunicationBatchStatus,
  OutboundMessage,
  SmtpProfileSummary,
} from "@shared/communications";
import { toDisplayDateTime } from "@shared/dates";
import { formatPaise, parseRupees } from "@shared/money";
import { api } from "../lib/client";
import { confirmDialog } from "../lib/dialogs";
import { useSession, useToasts } from "../state/stores";
import { Button, EmptyState, Field, Panel, Select, TextInput } from "./ui";

const BATCH_STATUS: Record<
  CommunicationBatchStatus,
  { label: string; detail: string; tone: string }
> = {
  pending_approval: {
    label: "Awaiting checker",
    detail: "A different active user must approve this exact preview.",
    tone: "text-amberbar",
  },
  approved: {
    label: "Approved",
    detail: "Content is locked and ready for bounded local queueing.",
    tone: "text-dr",
  },
  partially_queued: {
    label: "Partly queued",
    detail:
      "Some items are queued; failures and remaining items can be retried.",
    tone: "text-amberbar",
  },
  queued: {
    label: "Queued locally",
    detail:
      "Every included item entered Total's local SMTP queue. Delivery is not confirmed.",
    tone: "text-dr",
  },
  rejected: {
    label: "Rejected",
    detail: "The checker rejected this preview. No included draft was queued.",
    tone: "text-cr",
  },
  cancelled: {
    label: "Cancelled",
    detail: "This batch was closed without further queueing.",
    tone: "text-muted",
  },
};

interface DraftSelection {
  selected: boolean;
  documentKind: CommunicationBatchDocumentKind;
  documentLabel: string;
  amountText: string;
  excluded: boolean;
  exclusionReason: string;
}

function inferredKind(
  message: OutboundMessage,
): CommunicationBatchDocumentKind {
  const text = `${message.subject} ${message.bodyText}`.toLowerCase();
  if (text.includes("statement")) return "statement";
  if (text.includes("reminder")) return "reminder";
  if (text.includes("invoice")) return "invoice";
  return "other";
}

function makeSelections(
  messages: OutboundMessage[],
): Record<string, DraftSelection> {
  return Object.fromEntries(
    messages.map((message) => [
      message.id,
      {
        selected: false,
        documentKind: inferredKind(message),
        documentLabel: message.subject,
        amountText: "0.00",
        excluded: false,
        exclusionReason: "",
      },
    ]),
  );
}

function uniqueRecipients(message: OutboundMessage): string[] {
  return [...new Set([...message.to, ...message.cc, ...message.bcc])];
}

function exactPaiseTotal(amounts: Array<number | null>): number | null {
  let total = 0;
  for (const amount of amounts) {
    if (amount === null || amount < 0) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function BatchMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="border-r border-line px-3 py-2 last:border-r-0">
      <p className="text-[8.5px] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </p>
      <p className="mt-1 num text-[13px] font-semibold text-ink">{value}</p>
    </div>
  );
}

export function CommunicationBatchesPanel({
  messages,
  profiles,
  canCreate,
  canApprove,
  canEdit,
  smtpQueueEnabled,
  smtpDisabledReason,
}: {
  messages: OutboundMessage[];
  profiles: SmtpProfileSummary[];
  canCreate: boolean;
  canApprove: boolean;
  canEdit: boolean;
  smtpQueueEnabled: boolean;
  smtpDisabledReason: string;
}): React.JSX.Element {
  const toast = useToasts();
  const user = useSession((state) => state.user);
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const batches = useQuery({
    queryKey: ["communicationBatches"],
    queryFn: () => api.communications.batches.list({ limit: 100 }),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchName, setBatchName] = useState("");
  const [selections, setSelections] = useState<Record<string, DraftSelection>>(
    {},
  );
  const [decisionNote, setDecisionNote] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [profileId, setProfileId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const selected =
    batches.data?.find((batch) => batch.id === selectedId) ?? null;
  const events = useQuery({
    queryKey: ["communicationBatchEvents", selectedId],
    queryFn: () => api.communications.batches.events(selectedId!),
    enabled: selectedId !== null,
  });
  const drafts = useMemo(
    () =>
      messages.filter((message) => message.status === "draft").slice(0, 100),
    [messages],
  );

  useEffect(() => {
    if (!selectedId && batches.data?.[0]) setSelectedId(batches.data[0].id);
  }, [batches.data, selectedId]);

  useEffect(() => {
    if (!createOpen) return;
    setSelections(makeSelections(drafts));
    window.setTimeout(() => nameRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [createOpen, drafts]);

  const selectedRows = drafts.filter(
    (message) => selections[message.id]?.selected,
  );
  const includedRows = selectedRows.filter(
    (message) => !selections[message.id]?.excluded,
  );
  const excludedRows = selectedRows.filter(
    (message) => selections[message.id]?.excluded,
  );
  const recipientCount = includedRows.reduce(
    (sum, message) => sum + uniqueRecipients(message).length,
    0,
  );
  const parsedAmounts = includedRows.map((message) =>
    parseRupees(selections[message.id]?.amountText ?? ""),
  );
  const totalAmountPaise = exactPaiseTotal(parsedAmounts);
  const createIssues = [
    !batchName.trim() ? "Name the batch" : null,
    !selectedRows.length ? "Select at least one draft" : null,
    selectedRows.length > 0 && !includedRows.length
      ? "Include at least one selected draft"
      : null,
    totalAmountPaise === null ? "Use valid, non-negative rupee amounts" : null,
    selectedRows.some(
      (message) => !selections[message.id]?.documentLabel.trim(),
    )
      ? "Give every selected draft a document label"
      : null,
    excludedRows.some(
      (message) =>
        (selections[message.id]?.exclusionReason.trim().length ?? 0) < 3,
    )
      ? "Give every excluded draft a reason"
      : null,
  ].filter((issue): issue is string => issue !== null);

  const refresh = async (id?: string): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["communicationBatches"] }),
      queryClient.invalidateQueries({ queryKey: ["outboundMessages"] }),
    ]);
    if (id) setSelectedId(id);
    if (id ?? selectedId)
      await queryClient.invalidateQueries({
        queryKey: ["communicationBatchEvents", id ?? selectedId],
      });
  };
  const fail = (error: unknown) =>
    toast.push("error", error instanceof Error ? error.message : String(error));
  const act = async (
    operation: () => Promise<CommunicationBatch>,
    success: string,
  ): Promise<void> => {
    setBusy(true);
    try {
      const batch = await operation();
      await refresh(batch.id);
      toast.push("success", success);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const updateSelection = (id: string, patch: Partial<DraftSelection>) =>
    setSelections((current) => ({
      ...current,
      [id]: { ...current[id]!, ...patch },
    }));

  const createBatch = async (): Promise<void> => {
    if (createIssues.length || totalAmountPaise === null) {
      toast.push("error", createIssues[0] ?? "Review the batch preview");
      return;
    }
    setBusy(true);
    try {
      const batch = await api.communications.batches.create({
        name: batchName.trim(),
        items: selectedRows.map((message) => {
          const row = selections[message.id]!;
          return {
            messageId: message.id,
            documentKind: row.documentKind,
            documentLabel: row.documentLabel.trim(),
            amountPaise: parseRupees(row.amountText)!,
            exclusionReason: row.excluded ? row.exclusionReason.trim() : null,
          };
        }),
      });
      setCreateOpen(false);
      setBatchName("");
      await refresh(batch.id);
      toast.push(
        "success",
        batch.status === "pending_approval"
          ? "Batch sent to a different user for approval"
          : "Batch approved locally; no user controls are configured",
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (): Promise<void> => {
    if (!selected) return;
    const confirmed = await confirmDialog({
      title: "Approve exact batch preview",
      message: `Approve ${selected.includedCount} included message${selected.includedCount === 1 ? "" : "s"} for ${selected.recipientCount} recipient${selected.recipientCount === 1 ? "" : "s"}? Content will be locked, but nothing is submitted yet.`,
      confirmLabel: "Approve preview",
    });
    if (confirmed)
      await act(
        () =>
          api.communications.batches.approve(
            selected.id,
            decisionNote.trim() || null,
          ),
        "Batch approved. Nothing has been submitted.",
      );
  };

  const retryIds =
    selected?.items
      .filter((item) => item.status === "failed")
      .slice(0, 25)
      .map((item) => item.id) ?? [];
  const queueableCount =
    selected?.items.filter(
      (item) => item.status === "ready" || item.status === "failed",
    ).length ?? 0;

  return (
    <div data-testid="communication-batches-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-3 py-2">
        <div>
          <p className="text-[11px] font-semibold">Bulk approval batches</p>
          <p className="mt-0.5 text-[9.5px] text-muted">
            Select up to 100 existing drafts, lock one exact preview, then queue
            no more than 25 at a time.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!canCreate || drafts.length === 0}
          disabledTitle={
            drafts.length === 0
              ? "Create message drafts first"
              : "Your role cannot create batches"
          }
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={13} className="mr-1 inline" /> New approval batch
        </Button>
      </div>

      {createOpen && (
        <Panel
          className="mb-4 overflow-hidden"
          data-testid="communication-batch-create"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h3 className="text-[14px] font-semibold">
                Prepare one exact preview
              </h3>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                Excluded rows remain visible as evidence. Amounts are review
                metadata in integer paise and do not post to the books.
              </p>
            </div>
            <Button
              variant="ghost"
              aria-label="Close batch builder"
              onClick={() => setCreateOpen(false)}
            >
              <X size={14} />
            </Button>
          </div>
          <div className="p-4">
            <Field label="Batch name">
              <TextInput
                ref={nameRef}
                value={batchName}
                placeholder="August invoices — west region"
                onChange={(event) => setBatchName(event.target.value)}
              />
            </Field>
            <div className="mt-3 overflow-x-auto rounded-md border border-line">
              <div className="min-w-[620px]">
                <div className="grid grid-cols-[28px_minmax(190px,1fr)_110px_160px] gap-2 bg-panel2 px-3 py-2 text-[8.5px] font-semibold uppercase tracking-[0.07em] text-muted">
                  <span aria-hidden="true" />
                  <span>Draft and recipients</span>
                  <span>Kind</span>
                  <span className="text-right">Amount (₹)</span>
                </div>
                <div className="max-h-[390px] overflow-y-auto">
                  {drafts.map((message) => {
                    const row = selections[message.id];
                    if (!row) return null;
                    const addresses = uniqueRecipients(message);
                    return (
                      <div
                        key={message.id}
                        className={`border-t border-line px-3 py-3 first:border-t-0 ${row.selected ? "bg-amber/5" : "bg-panel"}`}
                      >
                        <div className="grid grid-cols-[28px_minmax(190px,1fr)_110px_160px] items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1 accent-[var(--t-amberbar)]"
                            aria-label={`Select ${message.subject}`}
                            checked={row.selected}
                            onChange={(event) =>
                              updateSelection(message.id, {
                                selected: event.target.checked,
                              })
                            }
                          />
                          <div className="min-w-0">
                            <p className="truncate text-[10.5px] font-semibold">
                              {message.subject}
                            </p>
                            <p className="mt-1 break-all text-[9px] leading-4 text-muted">
                              {addresses.join(", ")}
                            </p>
                            <p className="mt-1 text-[8.5px] text-muted">
                              Revision {message.revision} ·{" "}
                              {message.contentSha256.slice(0, 12)}…
                            </p>
                          </div>
                          <Select
                            aria-label={`Document kind for ${message.subject}`}
                            disabled={!row.selected}
                            value={row.documentKind}
                            onChange={(event) =>
                              updateSelection(message.id, {
                                documentKind: event.target
                                  .value as CommunicationBatchDocumentKind,
                              })
                            }
                          >
                            <option value="invoice">Invoice</option>
                            <option value="statement">Statement</option>
                            <option value="reminder">Reminder</option>
                            <option value="other">Other</option>
                          </Select>
                          <TextInput
                            aria-label={`Amount for ${message.subject}`}
                            className="num text-right"
                            inputMode="decimal"
                            disabled={!row.selected || row.excluded}
                            value={row.amountText}
                            onChange={(event) =>
                              updateSelection(message.id, {
                                amountText: event.target.value,
                              })
                            }
                          />
                        </div>
                        {row.selected && (
                          <div className="ml-[36px] mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                            <TextInput
                              aria-label={`Document label for ${message.subject}`}
                              value={row.documentLabel}
                              onChange={(event) =>
                                updateSelection(message.id, {
                                  documentLabel: event.target.value,
                                })
                              }
                            />
                            <label className="flex min-h-8 items-center gap-2 rounded-md border border-line px-2 text-[9.5px] text-muted">
                              <input
                                type="checkbox"
                                className="accent-[var(--t-amberbar)]"
                                checked={row.excluded}
                                onChange={(event) =>
                                  updateSelection(message.id, {
                                    excluded: event.target.checked,
                                  })
                                }
                              />
                              Exclude, but retain evidence
                            </label>
                            {row.excluded && (
                              <TextInput
                                className="sm:col-span-2"
                                aria-label={`Exclusion reason for ${message.subject}`}
                                placeholder="Reason for exclusion"
                                value={row.exclusionReason}
                                onChange={(event) =>
                                  updateSelection(message.id, {
                                    exclusionReason: event.target.value,
                                  })
                                }
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 overflow-hidden rounded-md border border-line bg-panel sm:grid-cols-4">
              <BatchMetric
                label="Selected"
                value={String(selectedRows.length)}
              />
              <BatchMetric
                label="Included"
                value={String(includedRows.length)}
              />
              <BatchMetric label="Recipients" value={String(recipientCount)} />
              <BatchMetric
                label="Preview total"
                value={
                  totalAmountPaise === null
                    ? "Invalid"
                    : `₹${formatPaise(totalAmountPaise)}`
                }
              />
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div aria-live="polite">
                {createIssues.length ? (
                  <p className="text-[9.5px] text-cr">
                    {createIssues.join(" · ")}
                  </p>
                ) : (
                  <p className="flex items-center gap-1 text-[9.5px] text-dr">
                    <ShieldCheck size={12} /> Ready to create immutable review
                    evidence
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={busy || createIssues.length > 0}
                  onClick={() => void createBatch()}
                >
                  {busy ? "Creating…" : "Create approval batch"}
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid min-h-[460px] gap-3 lg:grid-cols-[0.72fr_1.28fr]">
        <Panel className="min-h-0">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-[11px] font-semibold">Approval batches</p>
            <Button
              variant="ghost"
              aria-label="Refresh batches"
              onClick={() => void refresh()}
            >
              <ArrowClockwise size={13} />
            </Button>
          </div>
          {batches.isLoading ? (
            <p
              className="py-12 text-center text-[11px] text-muted"
              role="status"
            >
              Loading batches…
            </p>
          ) : batches.isError ? (
            <p className="px-4 py-4 text-[11px] text-cr" role="alert">
              Batches could not be loaded.
            </p>
          ) : batches.data?.length ? (
            <div className="max-h-[600px] overflow-y-auto">
              {batches.data.map((batch) => (
                <button
                  type="button"
                  key={batch.id}
                  aria-pressed={selectedId === batch.id}
                  onClick={() => setSelectedId(batch.id)}
                  className={`block w-full border-b border-line px-3 py-3 text-left transition-colors hover:bg-panel2 ${selectedId === batch.id ? "bg-amber/10 shadow-[inset_3px_0_0_var(--t-amberbar)]" : "bg-panel"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-[11px] font-semibold">
                      {batch.name}
                    </p>
                    <span
                      className={`shrink-0 text-[8.5px] font-semibold ${BATCH_STATUS[batch.status].tone}`}
                    >
                      {BATCH_STATUS[batch.status].label}
                    </span>
                  </div>
                  <p className="mt-1 text-[9px] text-muted">
                    {batch.includedCount} included · {batch.excludedCount}{" "}
                    excluded · {batch.recipientCount} recipients
                  </p>
                  <p className="mt-1 text-[8.5px] text-muted/75">
                    Maker {batch.makerName} ·{" "}
                    {toDisplayDateTime(new Date(batch.updatedAt))}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Stack size={26} />}
              title="No approval batches"
              hint="Build one from existing message drafts."
            />
          )}
        </Panel>

        <Panel className="min-h-0">
          {!selected ? (
            <EmptyState
              title="Choose a batch"
              hint="Its exact preview, control state and retry evidence will appear here."
            />
          ) : (
            <div>
              <div className="border-b border-line px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[16px] font-semibold">
                      {selected.name}
                    </h3>
                    <p className="mt-1 text-[9.5px] text-muted">
                      Created by {selected.makerName}
                      {selected.checkerName
                        ? ` · Checked by ${selected.checkerName}`
                        : " · Checker pending"}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-semibold ${BATCH_STATUS[selected.status].tone}`}
                  >
                    {BATCH_STATUS[selected.status].label}
                  </span>
                </div>
                <p className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2 text-[10px] leading-4 text-muted">
                  {BATCH_STATUS[selected.status].detail}
                </p>
                <div className="mt-3 grid grid-cols-2 overflow-hidden rounded-md border border-line bg-panel sm:grid-cols-4">
                  <BatchMetric
                    label="Included"
                    value={String(selected.includedCount)}
                  />
                  <BatchMetric
                    label="Excluded"
                    value={String(selected.excludedCount)}
                  />
                  <BatchMetric
                    label="Recipients"
                    value={String(selected.recipientCount)}
                  />
                  <BatchMetric
                    label="Preview total"
                    value={`₹${formatPaise(selected.totalAmountPaise)}`}
                  />
                </div>
              </div>

              <div className="border-b border-line px-4 py-3">
                {selected.status === "pending_approval" && (
                  <div className="grid gap-2">
                    <div className="flex items-start gap-2 rounded-md border border-amber/35 bg-amber/5 p-3">
                      <Checks
                        size={16}
                        className="mt-0.5 shrink-0 text-amberbar"
                      />
                      <div>
                        <p className="text-[10.5px] font-semibold">
                          Different-user check required
                        </p>
                        <p className="mt-1 text-[9.5px] leading-4 text-muted">
                          Signed in as {user?.name ?? "local user"}. The maker,{" "}
                          {selected.makerName}, cannot approve their own batch.
                        </p>
                      </div>
                    </div>
                    <Field label="Approval note (optional)">
                      <TextInput
                        value={decisionNote}
                        onChange={(event) =>
                          setDecisionNote(event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Rejection reason">
                      <TextInput
                        value={rejectNote}
                        onChange={(event) => setRejectNote(event.target.value)}
                        placeholder="Required only when rejecting"
                      />
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="danger"
                        disabled={
                          !canApprove ||
                          busy ||
                          rejectNote.trim().length < 3 ||
                          user?.id === selected.makerUserId
                        }
                        disabledTitle={
                          user?.id === selected.makerUserId
                            ? "The maker cannot check this batch"
                            : "Add a rejection reason"
                        }
                        onClick={() =>
                          void act(
                            () =>
                              api.communications.batches.reject(
                                selected.id,
                                rejectNote.trim(),
                              ),
                            "Batch rejected; no drafts were queued",
                          )
                        }
                      >
                        Reject preview
                      </Button>
                      <Button
                        variant="primary"
                        disabled={
                          !canApprove ||
                          busy ||
                          user?.id === selected.makerUserId
                        }
                        disabledTitle={
                          user?.id === selected.makerUserId
                            ? "Sign in as a different active user"
                            : "Your role cannot approve batches"
                        }
                        onClick={() => void approve()}
                      >
                        Approve exact preview
                      </Button>
                    </div>
                  </div>
                )}
                {(selected.status === "approved" ||
                  selected.status === "partially_queued") && (
                  <div className="grid gap-3">
                    <div className="rounded-md border border-line bg-panel2 p-3 text-[9.5px] leading-4 text-muted">
                      <p className="font-semibold text-ink">Local queue only</p>
                      Queueing assigns a device-owned SMTP profile. It does not
                      prove submission, server acceptance, opening or recipient
                      delivery. Each action processes at most 25 items.
                    </div>
                    {profiles.length ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <Field label="Email profile">
                          <Select
                            value={profileId}
                            onChange={(event) =>
                              setProfileId(
                                event.target.value
                                  ? Number(event.target.value)
                                  : "",
                              )
                            }
                          >
                            <option value="">Choose active profile</option>
                            {profiles
                              .filter((profile) => profile.active)
                              .map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.name} ({profile.fromEmail})
                                </option>
                              ))}
                          </Select>
                        </Field>
                        {retryIds.length > 0 && (
                          <Button
                            disabled={
                              !smtpQueueEnabled ||
                              !canApprove ||
                              profileId === "" ||
                              busy
                            }
                            disabledTitle={smtpDisabledReason}
                            onClick={() =>
                              void act(
                                () =>
                                  api.communications.batches.enqueue(
                                    selected.id,
                                    Number(profileId),
                                    retryIds,
                                  ),
                                `Retried ${retryIds.length} failed queue item${retryIds.length === 1 ? "" : "s"}`,
                              )
                            }
                          >
                            <ArrowClockwise size={13} className="mr-1 inline" />{" "}
                            Retry failed ({retryIds.length})
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          disabled={
                            !smtpQueueEnabled ||
                            !canApprove ||
                            profileId === "" ||
                            busy ||
                            queueableCount === 0
                          }
                          disabledTitle={smtpDisabledReason}
                          onClick={() =>
                            void act(
                              () =>
                                api.communications.batches.enqueue(
                                  selected.id,
                                  Number(profileId),
                                ),
                              `Processed the next ${Math.min(25, queueableCount)} local queue items`,
                            )
                          }
                        >
                          <PaperPlaneTilt size={13} className="mr-1 inline" />{" "}
                          Queue next {Math.min(25, queueableCount)}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted">
                        An owner must configure an active email profile before
                        local queueing. Approval evidence remains usable without
                        one.
                      </p>
                    )}
                  </div>
                )}
                {(selected.status === "pending_approval" ||
                  selected.status === "approved") && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="ghost"
                      className="!text-cr"
                      disabled={!canEdit || busy}
                      onClick={() =>
                        void act(
                          () => api.communications.batches.cancel(selected.id),
                          "Batch cancelled",
                        )
                      }
                    >
                      Cancel batch
                    </Button>
                  </div>
                )}
              </div>

              <div className="border-b border-line px-4 py-3">
                <p className="mb-2 text-[10.5px] font-semibold">
                  Exact recipient preview
                </p>
                <div className="max-h-[320px] overflow-y-auto rounded-md border border-line">
                  {selected.items.map((item) => (
                    <div
                      key={item.id}
                      className={`border-t border-line px-3 py-3 first:border-t-0 ${item.status === "excluded" ? "bg-panel2 opacity-75" : "bg-panel"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[10.5px] font-semibold">
                              {item.documentLabel}
                            </p>
                            <span className="rounded border border-line px-1.5 py-0.5 text-[8px] uppercase text-muted">
                              {item.documentKind}
                            </span>
                          </div>
                          <p className="mt-1 break-all text-[9px] text-muted">
                            {[...item.to, ...item.cc, ...item.bcc].join(", ")}
                          </p>
                          <p className="mt-1 text-[8.5px] text-muted">
                            Revision {item.messageRevision} ·{" "}
                            {item.contentSha256.slice(0, 12)}… · message{" "}
                            {item.messageStatus.replaceAll("_", " ")}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="num text-[10px] font-semibold">
                            ₹{formatPaise(item.amountPaise)}
                          </p>
                          <p
                            className={`mt-1 text-[8.5px] font-semibold ${item.status === "failed" ? "text-cr" : item.status === "queued" ? "text-dr" : "text-muted"}`}
                          >
                            {item.status.replaceAll("_", " ")}
                          </p>
                        </div>
                      </div>
                      {item.exclusionReason && (
                        <p className="mt-2 rounded bg-panel px-2 py-1 text-[9px] text-muted">
                          Excluded: {item.exclusionReason}
                        </p>
                      )}
                      {item.lastError && (
                        <p
                          className="mt-2 flex gap-1 rounded border border-cr/30 bg-cr/5 px-2 py-1 text-[9px] text-cr"
                          role="alert"
                        >
                          <WarningCircle
                            size={11}
                            className="mt-0.5 shrink-0"
                          />
                          {item.lastError} · Attempt {item.attempts}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-4 py-3">
                <p className="mb-2 text-[10.5px] font-semibold">
                  Batch evidence
                </p>
                {events.isLoading ? (
                  <p className="text-[10px] text-muted" role="status">
                    Loading batch evidence…
                  </p>
                ) : events.data?.length ? (
                  <ol className="grid gap-2">
                    {events.data.map((event) => (
                      <li
                        key={event.id}
                        className="grid grid-cols-[12px_1fr_auto] items-start gap-2 text-[9.5px]"
                      >
                        <CheckCircle size={11} className="mt-0.5 text-muted" />
                        <span>
                          <span className="font-medium text-ink">
                            {event.eventType.replaceAll("_", " ")}
                          </span>{" "}
                          <span className="text-muted">by {event.actor}</span>
                        </span>
                        <time className="text-muted">
                          {toDisplayDateTime(new Date(event.createdAt))}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-[10px] text-muted">
                    No evidence available.
                  </p>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
