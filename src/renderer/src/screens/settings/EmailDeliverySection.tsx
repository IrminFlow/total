import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, EnvelopeSimple, LockKey, Plug, Plus } from "@phosphor-icons/react";
import type { SmtpProfileSummary } from "@shared/communications";
import { api } from "../../lib/client";
import { useSession, useToasts } from "../../state/stores";
import { confirmDialog } from "../../lib/dialogs";
import { readProductFlags } from "../../lib/productFlags";
import { Button, EmptyState, Field, Panel, SectionTitle, Select, TextInput } from "../../components/ui";

interface ProfileDraft {
  name: string;
  host: string;
  port: string;
  security: "tls" | "starttls";
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  active: boolean;
}

const blankProfile = (): ProfileDraft => ({
  name: "",
  host: "",
  port: "587",
  security: "starttls",
  username: "",
  password: "",
  fromEmail: "",
  fromName: "",
  replyTo: "",
  active: true,
});

const fromProfile = (profile: SmtpProfileSummary): ProfileDraft => ({
  name: profile.name,
  host: profile.host,
  port: String(profile.port),
  security: profile.security,
  username: profile.username,
  password: "",
  fromEmail: profile.fromEmail,
  fromName: profile.fromName,
  replyTo: profile.replyTo ?? "",
  active: profile.active,
});

export function EmailDeliverySection(): React.JSX.Element {
  const user = useSession((state) => state.user);
  const owner = !user || user.role === "owner";
  const smtpDeliveryEnabled = import.meta.env.DEV && readProductFlags(localStorage).flags.smtpDeliveryPreview;
  const smtpDisabledReason = import.meta.env.DEV
    ? "Enable SMTP submission preview in Settings > About"
    : "Unavailable in production pending protocol verification";
  const toast = useToasts();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["smtpProfiles"], queryFn: api.communications.smtp.list, enabled: owner });
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(blankProfile);
  const [busyId, setBusyId] = useState<number | null>(null);
  const editingProfile = useMemo(
    () => profiles.data?.find((profile) => profile.id === editingId) ?? null,
    [editingId, profiles.data],
  );

  if (!owner) {
    return (
      <Panel className="p-5" data-testid="email-delivery-restricted">
        <LockKey size={22} className="text-muted" />
        <h2 className="mt-3 text-[17px] font-semibold">Owner access required</h2>
        <p className="mt-1 max-w-xl text-[11px] leading-5 text-muted">
          SMTP credentials can submit messages outside this computer. Only a company owner can configure them.
        </p>
      </Panel>
    );
  }

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["smtpProfiles"] });
  };
  const fail = (error: unknown): void =>
    toast.push("error", error instanceof Error ? error.message : String(error));

  const begin = (profile?: SmtpProfileSummary): void => {
    setEditingId(profile?.id ?? "new");
    setDraft(profile ? fromProfile(profile) : blankProfile());
  };

  const save = async (): Promise<void> => {
    const port = Number(draft.port);
    if (!draft.name.trim() || !draft.host.trim() || !draft.username.trim() || !draft.fromEmail.trim()) {
      return void toast.push("error", "Complete the profile name, server, username and sender email");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return void toast.push("error", "Enter a valid SMTP port");
    }
    if (editingId === "new" && !draft.password) {
      return void toast.push("error", "Enter the SMTP password or app password");
    }
    const common = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port,
      security: draft.security,
      username: draft.username.trim(),
      fromEmail: draft.fromEmail.trim().toLowerCase(),
      fromName: draft.fromName.trim(),
      replyTo: draft.replyTo.trim().toLowerCase() || null,
      active: draft.active,
    };
    try {
      if (editingId === "new") {
        await api.communications.smtp.create({ ...common, password: draft.password });
      } else if (typeof editingId === "number") {
        await api.communications.smtp.update(editingId, {
          ...common,
          ...(draft.password ? { password: draft.password } : {}),
        });
      }
      await refresh();
      setEditingId(null);
      toast.push("success", editingId === "new" ? "Email profile added" : "Email profile updated");
    } catch (error) {
      fail(error);
    }
  };

  const test = async (profile: SmtpProfileSummary): Promise<void> => {
    setBusyId(profile.id);
    try {
      const response = await api.communications.smtp.test(profile.id);
      await refresh();
      toast.push("success", `SMTP connection accepted: ${response.serverResponse}`);
    } catch (error) {
      await refresh();
      fail(error);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (profile: SmtpProfileSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: "Delete email profile",
      message: `Delete “${profile.name}”? Profiles already used by message history must be deactivated instead.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.communications.smtp.remove(profile.id);
      await refresh();
      toast.push("success", "Email profile deleted");
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div data-testid="email-delivery-settings">
      <SectionTitle
        right={<Button variant="primary" onClick={() => begin()}><Plus size={13} className="mr-1 inline" />Add profile</Button>}
      >
        Email delivery
      </SectionTitle>
      <div className={`mb-4 rounded-md border px-3 py-2 text-[10.5px] leading-4 ${smtpDeliveryEnabled ? "border-amber/35 bg-amber/10 text-ink" : "border-line bg-panel2 text-muted"}`}>
        <span className="font-semibold">Preview foundation.</span> SMTP submission is {smtpDeliveryEnabled ? "enabled in this development build" : "unavailable in production pending protocol verification"}. Draft review and .eml export do not require it.
      </div>
      <Panel className="mb-4 grid gap-4 p-4 sm:grid-cols-[auto_1fr]">
        <div className="flex size-9 items-center justify-center rounded-md border border-amber/30 bg-amber/10 text-amberbar">
          <EnvelopeSimple size={18} />
        </div>
        <div>
          <p className="text-[12px] font-semibold">Use your business mail server</p>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">
            Passwords are encrypted by this computer. A message is submitted only after review and a separate send action.
          </p>
        </div>
      </Panel>

      {profiles.isLoading ? (
        <Panel className="p-6 text-center text-[11px] text-muted" role="status">Loading email profiles…</Panel>
      ) : profiles.isError ? (
        <Panel className="border-cr/30 bg-cr/5 p-4 text-[11px] text-cr" role="alert">
          Email profiles could not be loaded. {profiles.error instanceof Error ? profiles.error.message : "Try again."}
        </Panel>
      ) : profiles.data?.length ? (
        <Panel className="divide-y divide-line">
          {profiles.data.map((profile) => (
            <div key={profile.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[12px] font-semibold">{profile.name}</p>
                  <span className={`text-[9px] font-medium ${profile.active ? "text-dr" : "text-muted"}`}>{profile.active ? "Active" : "Inactive"}</span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[9.5px] text-muted">{profile.username} · {profile.host}:{profile.port} · {profile.security.toUpperCase()}</p>
                <p className="mt-1 text-[9.5px] text-muted">
                  {profile.lastTestedAt ? <><CheckCircle size={11} className="mr-1 inline text-dr" />Connection tested</> : "Not tested"}
                  {profile.lastError ? <span className="ml-2 text-cr">{profile.lastError}</span> : null}
                </p>
              </div>
              <Button onClick={() => void test(profile)} disabled={!smtpDeliveryEnabled || busyId === profile.id} disabledTitle={smtpDisabledReason}>
                <Plug size={13} className="mr-1 inline" />{busyId === profile.id ? "Testing…" : "Test"}
              </Button>
              <Button variant="ghost" onClick={() => begin(profile)}>Edit</Button>
              <Button variant="ghost" className="!text-cr" onClick={() => void remove(profile)}>Delete</Button>
            </div>
          ))}
        </Panel>
      ) : (
        <Panel><EmptyState title="No email profile configured" hint="Add the SMTP details supplied by your email provider." /></Panel>
      )}

      {editingId !== null && (
        <Panel className="mt-4 p-4" data-testid="smtp-profile-form">
          <h3 className="mb-3 text-[14px] font-semibold">{editingId === "new" ? "New email profile" : `Edit ${editingProfile?.name ?? "profile"}`}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Profile name"><TextInput autoFocus value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="Accounts mailbox" /></Field>
            <Field label="SMTP server"><TextInput value={draft.host} onChange={(event) => setDraft((value) => ({ ...value, host: event.target.value }))} placeholder="smtp.example.com" /></Field>
            <Field label="Port"><TextInput className="num" inputMode="numeric" value={draft.port} onChange={(event) => setDraft((value) => ({ ...value, port: event.target.value }))} /></Field>
            <Field label="Connection security">
              <Select value={draft.security} onChange={(event) => setDraft((value) => ({ ...value, security: event.target.value as ProfileDraft["security"] }))}>
                <option value="starttls">STARTTLS</option><option value="tls">TLS</option>
              </Select>
            </Field>
            <Field label="Username"><TextInput autoComplete="username" value={draft.username} onChange={(event) => setDraft((value) => ({ ...value, username: event.target.value }))} /></Field>
            <Field label={editingId === "new" ? "Password or app password" : "New password (leave blank to keep current)"}>
              <TextInput type="password" autoComplete="new-password" value={draft.password} onChange={(event) => setDraft((value) => ({ ...value, password: event.target.value }))} />
            </Field>
            <Field label="Sender email"><TextInput type="email" value={draft.fromEmail} onChange={(event) => setDraft((value) => ({ ...value, fromEmail: event.target.value }))} /></Field>
            <Field label="Sender name"><TextInput value={draft.fromName} onChange={(event) => setDraft((value) => ({ ...value, fromName: event.target.value }))} /></Field>
            <Field label="Reply-to email" hint="Optional"><TextInput type="email" value={draft.replyTo} onChange={(event) => setDraft((value) => ({ ...value, replyTo: event.target.value }))} /></Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[10.5px] text-muted"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft((value) => ({ ...value, active: event.target.checked }))} />Active</label>
            <div className="flex gap-2"><Button onClick={() => setEditingId(null)}>Cancel</Button><Button variant="primary" data-testid="btn-smtp-save" onClick={() => void save()}>Save profile</Button></div>
          </div>
        </Panel>
      )}
    </div>
  );
}
