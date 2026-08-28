import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsClockwise, Key, LinkBreak, ShieldCheck, Trash, UserPlus } from "@phosphor-icons/react";
import { api } from "../../lib/client";
import { confirmDialog } from "../../lib/dialogs";
import { useSession, useToasts } from "../../state/stores";
import { Button, Field, Panel, SectionTitle, SkeletonRows, TextInput } from "../../components/ui";

const syncPhaseLabel = {
  not_configured: "Not configured",
  paused: "Paused",
  idle: "Up to date",
  pending: "Waiting to sync",
  syncing: "Syncing now",
  error: "Needs attention",
} as const;

export function CollaborationSection(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const user = useSession((state) => state.user);
  const canEdit = !user || user.role === "owner";
  const { data: status, isLoading } = useQuery({
    queryKey: ["collaborationStatus"],
    queryFn: api.collaboration.status,
  });
  const invitations = useQuery({
    queryKey: ["collaborationInvitations"],
    queryFn: api.collaboration.invitations.list,
    enabled: status?.enabled === true && canEdit,
  });
  const [endpoint, setEndpoint] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [invitationCode, setInvitationCode] = useState("");
  const [createdInvitationCode, setCreatedInvitationCode] = useState<string | null>(null);
  const [invitationHours, setInvitationHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    if (!endpoint) setEndpoint(status.endpoint ?? "");
    if (!workspaceId) setWorkspaceId(status.workspaceId ?? crypto.randomUUID());
  }, [status, endpoint, workspaceId]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["collaborationStatus"] });
    await queryClient.invalidateQueries({ queryKey: ["collaborationInvitations"] });
  };

  const configure = async (): Promise<void> => {
    setBusy("configure");
    try {
      const result = await api.collaboration.configure({
        endpoint: endpoint.trim(),
        workspaceId: workspaceId.trim(),
        apiToken: apiToken.trim(),
        recoveryKey: recoveryKey.trim() || undefined,
        enabled: true,
      });
      setApiToken("");
      setRecoveryKey("");
      setShownKey(result.createdRecoveryKey);
      await refresh();
      toast.push("success", result.createdRecoveryKey ? "Encrypted workspace created" : "Encrypted workspace connected");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async (): Promise<void> => {
    setBusy("sync");
    try {
      await api.collaboration.sync();
      await refresh();
      toast.push("success", "Collaboration changes are up to date");
    } catch (error) {
      await refresh();
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revealRecoveryKey = async (): Promise<void> => {
    setBusy("key");
    try {
      setShownKey((await api.collaboration.recoveryKey()).recoveryKey);
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (): Promise<void> => {
    if (!status) return;
    setBusy("toggle");
    try {
      await api.collaboration.setEnabled(!status.enabled);
      await refresh();
      toast.push("success", status.enabled ? "Encrypted collaboration paused" : "Encrypted collaboration resumed");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyRecoveryKey = async (): Promise<void> => {
    if (!shownKey) return;
    try {
      const result = await api.privacy.copySensitive(shownKey);
      toast.push("success", result.clearsAfterSeconds > 0
        ? `Recovery key copied; clipboard clears in ${result.clearsAfterSeconds} seconds`
        : "Recovery key copied");
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };

  const disconnect = async (): Promise<void> => {
    const confirmed = await confirmDialog({
      title: "Disconnect encrypted collaboration",
      message: "Pending local collaboration changes will remain in this company, but the encryption key will be removed from this device.",
      confirmLabel: "Disconnect device",
      danger: true,
    });
    if (!confirmed) return;
    setBusy("disconnect");
    try {
      await api.collaboration.disconnect();
      setShownKey(null);
      setApiToken("");
      setRecoveryKey("");
      await refresh();
      toast.push("success", "This device was disconnected");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const createInvitation = async (): Promise<void> => {
    setBusy("invite");
    try {
      const [created, key] = await Promise.all([
        api.collaboration.invitations.create(invitationHours),
        api.collaboration.recoveryKey(),
      ]);
      setCreatedInvitationCode(created.invitationCode);
      setShownKey(key.recoveryKey);
      await refresh();
      toast.push("success", "Single-use team invitation created");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revokeInvitation = async (id: string): Promise<void> => {
    setBusy(`revoke:${id}`);
    try {
      await api.collaboration.invitations.revoke(id);
      await refresh();
      toast.push("success", "Invitation revoked");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const acceptInvitation = async (): Promise<void> => {
    setBusy("accept");
    try {
      await api.collaboration.invitations.accept({
        endpoint: endpoint.trim(),
        apiToken: apiToken.trim(),
        invitationCode: invitationCode.trim(),
        recoveryKey: recoveryKey.trim(),
      });
      setApiToken("");
      setInvitationCode("");
      setRecoveryKey("");
      await refresh();
      toast.push("success", "This device joined the encrypted workspace");
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copySensitive = async (value: string, label: string): Promise<void> => {
    try {
      const result = await api.privacy.copySensitive(value);
      toast.push("success", result.clearsAfterSeconds > 0
        ? `${label} copied; clipboard clears in ${result.clearsAfterSeconds} seconds`
        : `${label} copied`);
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };

  return (
    <div data-testid="collaboration-settings">
      <SectionTitle>Encrypted collaboration</SectionTitle>
      <div className="mb-4 flex gap-3 rounded-md border border-blue/35 bg-blue/10 px-3.5 py-3 text-[12.5px] leading-5 text-blue">
        <ShieldCheck className="mt-0.5 shrink-0" size={18} weight="fill" />
        <p>
          Total syncs encrypted proposals, drafts, comments and tasks. It never syncs your live company database or posted books. The app remains fully usable offline.
        </p>
      </div>

      {isLoading || !status ? <Panel><SkeletonRows rows={5} /></Panel> : (
        <>
          {status.configured && (
            <Panel className="mb-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[13.5px] font-semibold text-ink">{status.enabled ? "Connected on this device" : "Paused on this device"}</p>
                  <p className="mt-1 text-[11.5px] text-muted num">{status.endpoint}</p>
                  <p className="mt-2 text-[11.5px] text-muted">
                    Local state: <span className="font-medium text-ink">{syncPhaseLabel[status.phase]}</span> · {status.pending} pending · {status.conflicts} conflicts
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted">
                    {status.lastAttemptedAt ? `Last attempt ${new Date(status.lastAttemptedAt).toLocaleString()}` : "No sync attempt yet"}
                    {status.lastSyncedAt ? ` · Last success ${new Date(status.lastSyncedAt).toLocaleString()}` : " · No successful sync yet"}
                  </p>
                  {status.lastError && <p className="mt-2 text-[11.5px] text-cr">Last error: {status.lastError}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!canEdit || busy !== null || !status.enabled} onClick={() => void syncNow()}>
                    <ArrowsClockwise size={15} /> {busy === "sync" ? "Syncing…" : "Sync now"}
                  </Button>
                  <Button disabled={!canEdit || busy !== null} onClick={() => void toggleEnabled()}>
                    {status.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button disabled={!canEdit || busy !== null} onClick={() => void revealRecoveryKey()}>
                    <Key size={15} /> Recovery key
                  </Button>
                  <Button disabled={!canEdit || busy !== null} onClick={() => void disconnect()}>
                    <LinkBreak size={15} /> Disconnect
                  </Button>
                </div>
              </div>
            </Panel>
          )}

          {status.configured && status.enabled && canEdit && (
            <Panel className="mb-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-ink">Team invitations</p>
                  <p className="mt-1 text-[11.5px] leading-5 text-muted">Codes are hashed by the server, expire automatically and can be accepted only once. Share the recovery key through a separate trusted channel.</p>
                </div>
                <div className="flex items-center gap-2">
                  <select className="rounded-md border border-line bg-panel2 px-2 py-1.5 text-[12px]" value={invitationHours} onChange={(event) => setInvitationHours(Number(event.target.value))}>
                    <option value={1}>1 hour</option>
                    <option value={24}>24 hours</option>
                    <option value={72}>3 days</option>
                    <option value={168}>7 days</option>
                  </select>
                  <Button disabled={busy !== null} onClick={() => void createInvitation()}>
                    <UserPlus size={15} /> {busy === "invite" ? "Creating…" : "Invite teammate"}
                  </Button>
                </div>
              </div>
              <div className="mt-4 divide-y divide-line border-t border-line">
                {(invitations.data ?? []).map((invitation) => {
                  const active = !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now();
                  const state = invitation.acceptedAt ? "Accepted" : invitation.revokedAt ? "Revoked" : active ? "Active" : "Expired";
                  return (
                    <div key={invitation.id} className="flex items-center justify-between gap-3 py-2.5 text-[11.5px]">
                      <span><span className="font-medium text-ink">{state}</span> · expires {new Date(invitation.expiresAt).toLocaleString()}</span>
                      {active && <Button variant="ghost" disabled={busy !== null} aria-label="Revoke invitation" onClick={() => void revokeInvitation(invitation.id)}><Trash size={14} /> Revoke</Button>}
                    </div>
                  );
                })}
                {!invitations.isLoading && (invitations.data?.length ?? 0) === 0 && <p className="py-3 text-[11.5px] text-muted">No team invitations yet.</p>}
              </div>
            </Panel>
          )}

          <Panel className="p-5">
            <p className="mb-4 text-[13px] font-semibold text-ink">{status.configured ? "Change connection" : "Connect a sync workspace"}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Sync service URL" hint="Use the Total sync Edge Function URL from Supabase, or any compatible HTTPS endpoint.">
                  <TextInput className="num" value={endpoint} disabled={!canEdit} placeholder="https://project.supabase.co/functions/v1/total-sync" onChange={(event) => setEndpoint(event.target.value)} />
                </Field>
              </div>
              <Field label="Workspace ID">
                <TextInput className="num" value={workspaceId} disabled={!canEdit} onChange={(event) => setWorkspaceId(event.target.value)} />
              </Field>
              <Field label="Access token" hint={status.configured ? "Enter only to replace the stored token." : "Use a signed-in user token; never use a service-role key."}>
                <TextInput type="password" className="num" value={apiToken} disabled={!canEdit} placeholder="Stored in the operating-system credential store" onChange={(event) => setApiToken(event.target.value)} />
              </Field>
              <div className="col-span-2">
                <Field label="Recovery key from another device (optional)" hint="Leave blank to create a new encrypted workspace key. The server never receives this key.">
                  <TextInput type="password" className="num" value={recoveryKey} disabled={!canEdit} placeholder="total-sync-key-v1:…" onChange={(event) => setRecoveryKey(event.target.value)} />
                </Field>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <Button variant="primary" disabled={!canEdit || busy !== null || !endpoint.trim() || !workspaceId.trim() || !apiToken.trim()} onClick={() => void configure()}>
                {busy === "configure" ? "Saving…" : status.configured ? "Update connection" : "Connect securely"}
              </Button>
            </div>
          </Panel>

          {!status.configured && (
            <Panel className="mt-4 p-5">
              <p className="text-[13px] font-semibold text-ink">Join a teammate's workspace</p>
              <p className="mt-1 text-[11.5px] leading-5 text-muted">Sign in to the sync service, then enter the single-use invitation and recovery key received through separate channels.</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="col-span-2"><Field label="Invitation code"><TextInput className="num" value={invitationCode} disabled={!canEdit} placeholder="total-invite-v1:…" onChange={(event) => setInvitationCode(event.target.value)} /></Field></div>
                <div className="col-span-2"><Field label="Workspace recovery key"><TextInput type="password" className="num" value={recoveryKey} disabled={!canEdit} placeholder="total-sync-key-v1:…" onChange={(event) => setRecoveryKey(event.target.value)} /></Field></div>
              </div>
              <div className="mt-4 flex justify-end"><Button variant="primary" disabled={!canEdit || busy !== null || !endpoint.trim() || !apiToken.trim() || !invitationCode.trim() || !recoveryKey.trim()} onClick={() => void acceptInvitation()}>{busy === "accept" ? "Joining…" : "Accept invitation"}</Button></div>
            </Panel>
          )}
        </>
      )}

      {shownKey && (
        <div className="mt-4 rounded-md border border-amber/40 bg-amber/10 p-4" role="alert">
          <p className="text-[12.5px] font-semibold text-ink">Store this recovery key safely</p>
          <p className="mt-1 text-[11.5px] leading-5 text-muted">It is required to decrypt collaboration data on another device. Total support and the sync server cannot recover it.</p>
          <TextInput className="num mt-3" readOnly value={shownKey} onFocus={(event) => event.currentTarget.select()} />
          <Button className="mt-2" onClick={() => void copyRecoveryKey()}>Copy key</Button>
        </div>
      )}
      {createdInvitationCode && (
        <div className="mt-4 rounded-md border border-blue/35 bg-blue/10 p-4" role="status">
          <p className="text-[12.5px] font-semibold text-ink">Invitation code</p>
          <p className="mt-1 text-[11.5px] leading-5 text-muted">This code is shown only on this device. Send it separately from the recovery key.</p>
          <TextInput className="num mt-3" readOnly value={createdInvitationCode} onFocus={(event) => event.currentTarget.select()} />
          <Button className="mt-2" onClick={() => void copySensitive(createdInvitationCode, "Invitation code")}>Copy invitation</Button>
        </div>
      )}
      {!canEdit && <p className="mt-3 text-[11.5px] text-muted">Only company owners can configure encrypted collaboration.</p>}
    </div>
  );
}
