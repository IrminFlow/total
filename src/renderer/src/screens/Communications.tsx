import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  CheckCircle,
  EnvelopeOpen,
  Export,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OutboundMessage, OutboundMessageStatus, PartyContact } from "@shared/communications";
import { toDisplayDateTime } from "@shared/dates";
import { api } from "../lib/client";
import { inputCls } from "../components/inputStyles";
import { useSession, useToasts } from "../state/stores";
import { Button, EmptyState, Field, Panel, SectionTitle, Select, TextInput } from "../components/ui";
import { confirmDialog } from "../lib/dialogs";
import { readProductFlags } from "../lib/productFlags";
import { CommunicationBatchesPanel } from "../components/CommunicationBatchesPanel";

const STATUS: Record<OutboundMessageStatus, { label: string; detail: string; tone: string }> = {
  draft: { label: "Draft", detail: "Editable. It has not been approved or submitted.", tone: "text-muted" },
  reviewed: { label: "Reviewed", detail: "Approved content. Choose an email profile or save an .eml file.", tone: "text-amberbar" },
  queued: { label: "Ready to submit", detail: "Approved and assigned to an email profile. It has not left this computer.", tone: "text-amberbar" },
  sending: { label: "Submitting", detail: "Total is waiting for the configured SMTP server.", tone: "text-amberbar" },
  accepted_by_smtp: { label: "Accepted by SMTP", detail: "The configured server accepted the message. Recipient delivery is not confirmed.", tone: "text-dr" },
  acceptance_unknown: { label: "Acceptance unknown", detail: "Check the email provider before retrying. A retry could send a duplicate.", tone: "text-cr" },
  failed: { label: "Submission failed", detail: "The SMTP server did not accept the attempt. The reviewed message can be queued again.", tone: "text-cr" },
  cancelled: { label: "Cancelled", detail: "No further submission is allowed for this message.", tone: "text-muted" },
  exported: { label: "Saved as .eml", detail: "A local email file was created. Total did not submit it to a server.", tone: "text-dr" },
};

const parseAddresses = (value: string): string[] =>
  [...new Set(value.split(/[;,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];

const newIdempotencyKey = (): string => {
  if (typeof crypto.randomUUID === "function") return `ui:${crypto.randomUUID()}`;
  return `ui:${Date.now()}:${Math.random().toString(36).slice(2)}`;
};

interface ComposeState {
  ledgerId: number | "";
  contactId: number | "";
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
}

const blankCompose = (): ComposeState => ({ ledgerId: "", contactId: "", to: "", cc: "", bcc: "", subject: "", bodyText: "" });

export function CommunicationsScreen(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const user = useSession((state) => state.user);
  const owner = !user || user.role === "owner";
  const smtpDeliveryEnabled = import.meta.env.DEV && readProductFlags(localStorage).flags.smtpDeliveryPreview;
  const smtpDisabledReason = import.meta.env.DEV
    ? "Enable SMTP submission preview in Settings > About"
    : "Unavailable in production pending protocol verification";
  const ledgers = useQuery({ queryKey: ["ledgers"], queryFn: api.ledgers.list });
  const messages = useQuery({ queryKey: ["outboundMessages"], queryFn: () => api.communications.messages.list({ limit: 200 }) });
  const permissions = useQuery({ queryKey: ["permissionMatrix"], queryFn: api.permissions.get });
  const profiles = useQuery({ queryKey: ["smtpProfiles"], queryFn: api.communications.smtp.list, enabled: owner });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<"messages" | "batches">("messages");
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(blankCompose);
  const [profileId, setProfileId] = useState<number | "">("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftEdit, setDraftEdit] = useState({ to: "", cc: "", bcc: "", subject: "", bodyText: "" });
  const [busy, setBusy] = useState(false);
  const selected = messages.data?.find((message) => message.id === selectedId) ?? null;
  const contacts = useQuery({
    queryKey: ["partyContacts", compose.ledgerId, false],
    queryFn: () => api.communications.contacts.list(Number(compose.ledgerId)),
    enabled: compose.ledgerId !== "",
  });
  const events = useQuery({
    queryKey: ["outboundMessageEvents", selectedId],
    queryFn: () => api.communications.messages.events(selectedId!),
    enabled: selectedId !== null,
  });

  const role = user?.role ?? "owner";
  const rolePermissions = permissions.data?.[role];
  const canCreate = rolePermissions?.create ?? role !== "viewer";
  const canEdit = rolePermissions?.edit ?? role !== "viewer";
  const canApprove = rolePermissions?.approve ?? role === "owner";
  const partyLedgers = useMemo(
    () => [...(ledgers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers.data],
  );

  useEffect(() => {
    if (!selectedId && messages.data?.[0]) setSelectedId(messages.data[0].id);
  }, [messages.data, selectedId]);

  useEffect(() => {
    setEditingDraft(false);
    if (!selected) return;
    setDraftEdit({
      to: selected.to.join(", "),
      cc: selected.cc.join(", "),
      bcc: selected.bcc.join(", "),
      subject: selected.subject,
      bodyText: selected.bodyText,
    });
  }, [selectedId, selected?.revision]);

  const refresh = async (select?: string): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["outboundMessages"] });
    if (select) setSelectedId(select);
    if (selectedId || select) await queryClient.invalidateQueries({ queryKey: ["outboundMessageEvents", select ?? selectedId] });
  };
  const fail = (error: unknown): void => toast.push("error", error instanceof Error ? error.message : String(error));
  const act = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      toast.push("success", success);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const chooseContact = (contactId: number | ""): void => {
    const contact = contacts.data?.find((item) => item.id === contactId);
    setCompose((value) => ({ ...value, contactId, to: contact?.email ?? value.to }));
  };

  const createDraft = async (): Promise<void> => {
    const to = parseAddresses(compose.to);
    if (!to.length || !compose.subject.trim() || !compose.bodyText.trim()) {
      return void toast.push("error", "Add a recipient, subject and message");
    }
    setBusy(true);
    try {
      const message = await api.communications.messages.createDraft({
        idempotencyKey: newIdempotencyKey(),
        ledgerId: compose.ledgerId === "" ? null : compose.ledgerId,
        contactId: compose.contactId === "" ? null : compose.contactId,
        to,
        cc: parseAddresses(compose.cc),
        bcc: parseAddresses(compose.bcc),
        subject: compose.subject.trim(),
        bodyText: compose.bodyText,
      });
      setCompose(blankCompose());
      setComposeOpen(false);
      await refresh(message.id);
      toast.push("success", "Draft saved for review");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const saveSelectedDraft = async (): Promise<void> => {
    if (!selected) return;
    const to = parseAddresses(draftEdit.to);
    if (!to.length || !draftEdit.subject.trim() || !draftEdit.bodyText.trim()) {
      return void toast.push("error", "Add a recipient, subject and message");
    }
    await act(
      () => api.communications.messages.updateDraft(selected.id, {
        ledgerId: selected.ledgerId,
        contactId: selected.contactId,
        to,
        cc: parseAddresses(draftEdit.cc),
        bcc: parseAddresses(draftEdit.bcc),
        subject: draftEdit.subject.trim(),
        bodyText: draftEdit.bodyText,
        expectedRevision: selected.revision,
      }),
      "Draft updated",
    );
    setEditingDraft(false);
  };

  const submit = async (): Promise<void> => {
    if (!selected) return;
    const confirmed = await confirmDialog({
      title: "Submit to email server",
      message: `Submit “${selected.subject}” to ${selected.to.join(", ")}? SMTP acceptance will be recorded, but recipient delivery cannot be confirmed here.`,
      confirmLabel: "Submit",
    });
    if (confirmed) await act(() => api.communications.messages.deliver(selected.id), "Submission attempt finished");
  };

  const exportEml = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.communications.messages.exportEml(selected.id, profileId === "" ? undefined : profileId);
      if (!result) return;
      await refresh();
      toast.push("success", "Local .eml file saved. It was not sent.");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const workspaceSwitch = (
    <div className="flex items-center gap-1 rounded-md border border-line bg-panel2 p-1" aria-label="Communications workspace">
      <button
        type="button"
        aria-pressed={workspace === "messages"}
        className={`min-h-7 rounded px-2.5 text-[9.5px] font-semibold ${workspace === "messages" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}
        onClick={() => setWorkspace("messages")}
      >Messages</button>
      <button
        type="button"
        aria-pressed={workspace === "batches"}
        className={`min-h-7 rounded px-2.5 text-[9.5px] font-semibold ${workspace === "batches" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}
        onClick={() => setWorkspace("batches")}
      >Approval batches</button>
    </div>
  );

  if (workspace === "batches") {
    return (
      <div className="mx-auto max-w-6xl" data-testid="communications-screen">
        <SectionTitle right={workspaceSwitch}>Customer communications</SectionTitle>
        <CommunicationBatchesPanel
          messages={messages.data ?? []}
          profiles={profiles.data ?? []}
          canCreate={canCreate}
          canApprove={canApprove}
          canEdit={canEdit}
          smtpQueueEnabled={smtpDeliveryEnabled}
          smtpDisabledReason={smtpDisabledReason}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl" data-testid="communications-screen">
      <SectionTitle
        right={<div className="flex flex-wrap items-center gap-2">{workspaceSwitch}<Button variant="primary" disabled={!canCreate} disabledTitle="Your role cannot create drafts" onClick={() => setComposeOpen((value) => !value)}><Plus size={13} className="mr-1 inline" />New message</Button></div>}
      >
        Customer communications
      </SectionTitle>

      <div className="mb-3 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        <div className="bg-panel px-4 py-3"><p className="text-[11.5px] font-semibold">Review before submission</p><p className="mt-1 text-[9.5px] leading-4 text-muted">Drafting never sends. Approval and submission are separate actions.</p></div>
        <div className="bg-panel px-4 py-3"><p className="text-[11.5px] font-semibold">Use your own SMTP</p><p className="mt-1 text-[9.5px] leading-4 text-muted">Owners configure credentials in Settings, stored encrypted on this computer.</p></div>
        <div className="bg-panel px-4 py-3"><p className="text-[11.5px] font-semibold">Keep the evidence honest</p><p className="mt-1 text-[9.5px] leading-4 text-muted">Server acceptance is recorded. Opens and recipient delivery are not claimed.</p></div>
      </div>
      {!smtpDeliveryEnabled && (
        <div className="mb-3 rounded-md border border-line bg-panel2 px-3 py-2 text-[10.5px] text-muted">
          <span className="font-semibold text-ink">Preview foundation.</span> Live SMTP submission is unavailable in production pending protocol verification. You can manage contacts, review drafts and save approved messages as .eml files.
        </div>
      )}

      {composeOpen && (
        <Panel className="mb-4 p-4" data-testid="outbound-compose">
          <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-[14px] font-semibold">New email draft</h3><span className="text-[9.5px] text-muted"><ShieldCheck size={12} className="mr-1 inline" />Nothing is sent from this form</span></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business ledger">
              <Select value={compose.ledgerId} onChange={(event) => setCompose((value) => ({ ...value, ledgerId: event.target.value ? Number(event.target.value) : "", contactId: "" }))}>
                <option value="">No linked ledger</option>{partyLedgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.name}</option>)}
              </Select>
            </Field>
            <Field label="Contact">
              <Select value={compose.contactId} disabled={compose.ledgerId === ""} onChange={(event) => chooseContact(event.target.value ? Number(event.target.value) : "")}>
                <option value="">Choose contact</option>{contacts.data?.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}{contact.role ? `, ${contact.role}` : ""}{contact.isPrimary ? " (primary)" : ""}</option>)}
              </Select>
            </Field>
            <Field label="To" hint="Separate multiple addresses with commas"><TextInput type="email" value={compose.to} onChange={(event) => setCompose((value) => ({ ...value, to: event.target.value }))} /></Field>
            <Field label="Cc"><TextInput value={compose.cc} onChange={(event) => setCompose((value) => ({ ...value, cc: event.target.value }))} /></Field>
            <Field label="Bcc"><TextInput value={compose.bcc} onChange={(event) => setCompose((value) => ({ ...value, bcc: event.target.value }))} /></Field>
            <Field label="Subject"><TextInput value={compose.subject} onChange={(event) => setCompose((value) => ({ ...value, subject: event.target.value }))} /></Field>
          </div>
          <label className="mt-3 block"><span className="mb-1 block text-caption font-medium text-muted">Message</span><textarea className={`${inputCls} min-h-36 resize-y leading-5`} value={compose.bodyText} onChange={(event) => setCompose((value) => ({ ...value, bodyText: event.target.value }))} /></label>
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setComposeOpen(false)}>Cancel</Button><Button variant="primary" disabled={busy} data-testid="btn-message-save-draft" onClick={() => void createDraft()}>{busy ? "Saving…" : "Save draft"}</Button></div>
        </Panel>
      )}

      <div className="grid min-h-[430px] gap-3 lg:grid-cols-[0.85fr_1.15fr]">
        <Panel className="min-h-0">
          <div className="flex items-center justify-between border-b border-line px-3 py-2"><p className="text-[11px] font-semibold">Recent messages</p><Button variant="ghost" aria-label="Refresh messages" onClick={() => void refresh()}><ArrowClockwise size={13} /></Button></div>
          {messages.isLoading ? <p className="py-12 text-center text-[11px] text-muted" role="status">Loading outbox…</p> : messages.isError ? <p className="px-4 py-4 text-[11px] text-cr" role="alert">The outbox could not be loaded.</p> : messages.data?.length ? (
            <div className="max-h-[560px] overflow-y-auto">
              {messages.data.map((message) => <button type="button" key={message.id} onClick={() => setSelectedId(message.id)} className={`block w-full border-b border-line px-3 py-3 text-left transition-colors hover:bg-panel2 ${selectedId === message.id ? "bg-amber/10 shadow-[inset_3px_0_0_var(--t-amberbar)]" : "bg-panel"}`}>
                <div className="flex items-start justify-between gap-3"><p className="min-w-0 truncate text-[11.5px] font-semibold">{message.subject}</p><span className={`shrink-0 text-[8.5px] font-semibold ${STATUS[message.status].tone}`}>{STATUS[message.status].label}</span></div>
                <p className="mt-1 truncate text-[9.5px] text-muted">{message.to.join(", ")}</p><p className="mt-1 text-[8.5px] text-muted/75">{toDisplayDateTime(new Date(message.updatedAt))}</p>
              </button>)}
            </div>
          ) : <EmptyState icon={<EnvelopeOpen size={26} />} title="No messages yet" hint="Create a draft when an invoice, statement or reminder is ready." />}
        </Panel>

        <Panel className="min-h-0">
          {!selected ? <EmptyState title="Choose a message" hint="Its review record and submission evidence will appear here." /> : (
            <div>
              <div className="border-b border-line px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-[16px] font-semibold">{selected.subject}</h3><p className="mt-1 break-all text-[9.5px] text-muted">To: {selected.to.join(", ")}</p></div><span className={`text-[10px] font-semibold ${STATUS[selected.status].tone}`}>{STATUS[selected.status].label}</span></div>
                <div className={`mt-3 rounded-md border px-3 py-2 text-[10px] leading-4 ${selected.status === "acceptance_unknown" ? "border-cr/35 bg-cr/5 text-cr" : "border-line bg-panel2 text-muted"}`}>{STATUS[selected.status].detail}{selected.lastError ? <p className="mt-1 font-medium">{selected.lastError}</p> : null}</div>
                {editingDraft ? (
                  <div className="mt-3 grid gap-3 rounded-md border border-amber/35 bg-panel2 p-3" data-testid="outbound-draft-edit">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="To"><TextInput value={draftEdit.to} onChange={(event) => setDraftEdit((value) => ({ ...value, to: event.target.value }))} /></Field>
                      <Field label="Cc"><TextInput value={draftEdit.cc} onChange={(event) => setDraftEdit((value) => ({ ...value, cc: event.target.value }))} /></Field>
                      <Field label="Bcc"><TextInput value={draftEdit.bcc} onChange={(event) => setDraftEdit((value) => ({ ...value, bcc: event.target.value }))} /></Field>
                      <Field label="Subject"><TextInput value={draftEdit.subject} onChange={(event) => setDraftEdit((value) => ({ ...value, subject: event.target.value }))} /></Field>
                    </div>
                    <label className="block"><span className="mb-1 block text-caption font-medium text-muted">Message</span><textarea className={`${inputCls} min-h-32 resize-y leading-5`} value={draftEdit.bodyText} onChange={(event) => setDraftEdit((value) => ({ ...value, bodyText: event.target.value }))} /></label>
                    <div className="flex justify-end gap-2"><Button onClick={() => setEditingDraft(false)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void saveSelectedDraft()}>Save changes</Button></div>
                  </div>
                ) : <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel2 p-3 font-sans text-[10.5px] leading-5 text-ink">{selected.bodyText}</pre>}
              </div>

              <div className="grid gap-3 border-b border-line px-4 py-3">
                {selected.status === "draft" && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] text-muted">Revision {selected.revision} must be approved before it can leave this computer.</p><div className="flex gap-2"><Button disabled={!canEdit || busy} onClick={() => setEditingDraft(true)}>Edit draft</Button><Button variant="primary" disabled={!canApprove || busy || editingDraft} disabledTitle="Your role cannot approve messages" onClick={() => void act(() => api.communications.messages.review(selected.id, selected.revision), "Message reviewed")}>Review and approve</Button></div></div>}
                {(selected.status === "reviewed" || selected.status === "failed") && <>
                  {owner && profiles.data?.length ? <div className="flex flex-wrap items-end gap-2"><Field label="Email profile"><Select value={profileId} onChange={(event) => setProfileId(event.target.value ? Number(event.target.value) : "")}><option value="">Choose profile</option>{profiles.data.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} ({profile.fromEmail})</option>)}</Select></Field><Button variant="primary" disabled={!smtpDeliveryEnabled || !canApprove || profileId === "" || busy} disabledTitle={smtpDisabledReason} onClick={() => void act(() => api.communications.messages.queue(selected.id, Number(profileId)), "Message queued for submission")}>Queue with profile</Button></div> : <p className="text-[10px] text-muted">An owner can configure and select an email profile in Settings.</p>}
                  <div className="rounded-md border border-line bg-panel2 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10.5px] font-semibold">Local .eml fallback</p><p className="mt-1 text-[9px] text-muted">Choose where to save the file. It opens in most mail apps, and saving it does not send it.</p></div><Button disabled={!canEdit || busy} onClick={() => void exportEml()}><Export size={13} className="mr-1 inline" />Save .eml…</Button></div></div>
                </>}
                {selected.status === "queued" && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] text-muted">This action connects to the selected SMTP server.</p><Button variant="primary" disabled={!smtpDeliveryEnabled || !canApprove || busy} disabledTitle={smtpDisabledReason} onClick={() => void submit()}><PaperPlaneTilt size={13} className="mr-1 inline" />Submit to SMTP</Button></div>}
                {selected.status === "acceptance_unknown" && <div className="rounded-md border border-cr/30 bg-cr/5 p-3"><div className="flex items-start gap-2"><WarningCircle size={16} className="mt-0.5 shrink-0 text-cr" /><p className="text-[10px] leading-4 text-cr">Check the provider's sent mail or logs first. Retrying without checking can create a duplicate.</p></div><Field label="Resolution note"><TextInput className="mt-2" value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="What you checked" /></Field><div className="mt-2 flex flex-wrap justify-end gap-2"><Button disabled={!canApprove || resolutionNote.trim().length < 3 || busy} onClick={() => void act(() => api.communications.messages.resolveAcceptance(selected.id, { decision: "retry_with_duplicate_risk", note: resolutionNote.trim() }), "Message returned to the queue")}>Retry, duplicate risk accepted</Button><Button variant="primary" disabled={!canApprove || resolutionNote.trim().length < 3 || busy} onClick={() => void act(() => api.communications.messages.resolveAcceptance(selected.id, { decision: "confirmed_accepted", note: resolutionNote.trim() }), "External acceptance recorded")}>Record provider acceptance</Button></div></div>}
                {(["draft", "reviewed", "queued", "failed"] as OutboundMessageStatus[]).includes(selected.status) && <div className="flex justify-end"><Button variant="ghost" className="!text-cr" disabled={!canEdit || busy} onClick={() => void act(() => api.communications.messages.cancel(selected.id), "Message cancelled")}>Cancel message</Button></div>}
              </div>

              <div className="px-4 py-3"><p className="mb-2 text-[10.5px] font-semibold">Audit history</p>{events.isLoading ? <p className="text-[10px] text-muted">Loading history…</p> : events.data?.length ? <ol className="grid gap-2">{events.data.map((event) => <li key={event.id} className="grid grid-cols-[12px_1fr_auto] items-start gap-2 text-[9.5px]"><CheckCircle size={11} className="mt-0.5 text-muted" /><span><span className="font-medium text-ink">{STATUS[event.eventType === "eml_exported" ? "exported" : event.eventType === "delivery_started" ? "sending" : event.eventType === "edited" || event.eventType === "created" ? "draft" : event.eventType].label}</span> <span className="text-muted">by {event.actor}</span></span><time className="text-muted">{toDisplayDateTime(new Date(event.createdAt))}</time></li>)}</ol> : <p className="text-[10px] text-muted">No history available.</p>}</div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
