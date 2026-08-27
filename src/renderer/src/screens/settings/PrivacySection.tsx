import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, CloudSlash, Copy, FileLock, ShieldCheck } from "@phosphor-icons/react";
import { api } from "../../lib/client";
import { useSession, useToasts } from "../../state/stores";
import { Button, Panel, SectionTitle, Select } from "../../components/ui";

export function PrivacySection(): React.JSX.Element {
  const summary = useQuery({
    queryKey: ["privacy-summary"],
    queryFn: api.privacy.summary,
  });
  const { user } = useSession();
  const owner = !user || user.role === "owner";
  const toast = useToasts();
  const qc = useQueryClient();
  const [protecting, setProtecting] = useState(false);
  const [creatingIdentity, setCreatingIdentity] = useState(false);
  const [sendingCrash, setSendingCrash] = useState<string | null>(null);
  const crashes = useQuery({
    queryKey: ["crash-envelopes"],
    queryFn: api.crashes.list,
  });
  const refresh = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ["privacy-summary"] });
  const data = summary.data;
  const networkRows = data
    ? [
        {
          name: "AI provider",
          state: data.network.ai.enabled ? "Enabled" : "Off",
          detail: data.network.ai.enabled
            ? `${data.network.ai.provider} · ${data.network.ai.endpoint}`
            : "No provider requests are sent",
        },
        {
          name: "Bank feeds",
          state: `${data.network.bankFeeds.filter((row) => row.status === "connected").length} connected`,
          detail:
            data.network.bankFeeds.map((row) => row.endpoint).join(" · ") ||
            "CSV import remains available",
        },
        {
          name: "Outbound webhooks",
          state: `${data.network.webhooks.filter((row) => row.active).length} active`,
          detail:
            data.network.webhooks.map((row) => row.endpoint).join(" · ") ||
            "No external receivers configured",
        },
        {
          name: "Local agent access",
          state: `${data.network.mcpTokens} tokens`,
          detail: data.network.dropFolderEnabled
            ? "Drop-folder automation enabled"
            : "Drop-folder automation off",
        },
        {
          name: "Encrypted collaboration",
          state: data.network.collaboration.enabled ? "Enabled" : "Off",
          detail: data.network.collaboration.enabled
            ? `${data.network.collaboration.endpoint} · encrypted drafts and review work only`
            : "No collaboration data is sent",
        },
      ]
    : [];

  return (
    <div data-testid="privacy-settings">
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5 text-[10.5px] text-dr">
            <ShieldCheck size={14} /> Offline by default
          </span>
        }
      >
        Privacy centre
      </SectionTitle>
      <Panel className="relative mb-5 overflow-hidden !bg-ink px-6 py-5 text-panel">
        <div className="absolute -right-10 -top-20 size-52 rounded-full border border-panel/10" />
        <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-panel/45">
          Privacy controls
        </p>
        <h3 className="mt-3 font-serif text-[25px] font-semibold tracking-[-0.02em]">
          Review what can leave this device.
        </h3>
        <p className="mt-2 max-w-2xl text-[11px] leading-5 text-panel/55">
          Provider endpoints, scoped automation, diagnostics, evidence retention
          and copied secrets stay visible and independently controllable.
        </p>
      </Panel>

      <div className="mb-2 flex items-center gap-2">
        <CloudSlash size={17} className="text-amber" />
        <h3 className="text-[16px] font-semibold">Network surfaces</h3>
      </div>
      <Panel className="mb-5 divide-y divide-line">
        {networkRows.map((row) => (
          <div
            key={row.name}
            className="grid grid-cols-[150px_90px_1fr] items-center gap-3 px-4 py-3"
          >
            <p className="text-[10.5px] font-semibold">{row.name}</p>
            <p className="text-[8.5px] font-semibold uppercase text-muted">
              {row.state}
            </p>
            <p className="truncate text-[9px] text-muted">{row.detail}</p>
          </div>
        ))}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
              <FileLock size={18} />
            </span>
            <div>
              <p className="text-[12px] font-semibold">
                Source-document encryption
              </p>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                AES-256-GCM files with a platform-protected key. Existing Assist
                documents migrate atomically.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span
              className={`text-[9px] font-semibold uppercase ${data?.attachmentEncryption ? "text-dr" : "text-muted"}`}
            >
              {data?.attachmentEncryption ? "Encrypted" : "Standard files"}
            </span>
            {owner && (
              <Button
                disabled={protecting}
                data-testid="btn-attachment-encryption"
                onClick={async () => {
                  setProtecting(true);
                  try {
                    const result = await api.privacy.setAttachmentEncryption(
                      !data?.attachmentEncryption,
                    );
                    await refresh();
                    toast.push(
                      "success",
                      `${result.migratedFiles} managed files ${result.enabled ? "encrypted" : "decrypted"}`,
                    );
                  } catch (error) {
                    toast.push("error", (error as Error).message);
                  } finally {
                    setProtecting(false);
                  }
                }}
              >
                {protecting
                  ? "Protecting…"
                  : data?.attachmentEncryption
                    ? "Turn off"
                    : "Encrypt managed files"}
              </Button>
            )}
          </div>
        </Panel>
        <Panel className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
              <Copy size={18} />
            </span>
            <div>
              <p className="text-[12px] font-semibold">
                Sensitive clipboard expiry
              </p>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                Tokens, reminders and private summaries clear only if they are
                still the current clipboard value.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[9px] text-muted">
              Clear copied values after
            </span>
            <Select
              data-testid="select-clipboard-expiry"
              className="!w-40"
              disabled={!owner}
              value={data?.clipboardClearSeconds ?? 60}
              onChange={async (event) => {
                try {
                  await api.privacy.setClipboardClear(
                    Number(event.target.value),
                  );
                  await refresh();
                  toast.push("success", "Clipboard protection updated");
                } catch (error) {
                  toast.push("error", (error as Error).message);
                }
              }}
            >
              <option value={0}>Never</option>
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes</option>
              <option value={600}>10 minutes</option>
            </Select>
          </div>
        </Panel>
        <Panel className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
              <ShieldCheck size={18} />
            </span>
            <div>
              <p className="text-[12px] font-semibold">
                Export signing identity
              </p>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                Ed25519 signatures prove a report pack or portable export has
                not changed.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span
              className={`truncate font-mono text-[8.5px] ${data?.exportSigning.enabled ? "text-dr" : "text-muted"}`}
            >
              {data?.exportSigning.keyId ?? "Not created"}
            </span>
            {owner && !data?.exportSigning.enabled && (
              <Button
                disabled={creatingIdentity}
                data-testid="btn-create-signing"
                onClick={async () => {
                  setCreatingIdentity(true);
                  try {
                    await api.privacy.initializeSigning();
                    await refresh();
                    toast.push(
                      "success",
                      "Local export-signing identity created",
                    );
                  } catch (error) {
                    toast.push("error", (error as Error).message);
                  } finally {
                    setCreatingIdentity(false);
                  }
                }}
              >
                {creatingIdentity ? "Creating…" : "Create identity"}
              </Button>
            )}
          </div>
        </Panel>
      </div>

      <Panel className="mt-3 px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[10.5px] font-semibold">
              Support diagnostics allow-list
            </p>
            <p className="mt-1 text-[9px] text-muted">
              The exact automatic payload is version, platform and
              architecture. No books, paths, keys or attachments.
            </p>
          </div>
          <pre className="rounded border border-line bg-panel2 px-3 py-2 text-[8.5px] text-muted">
            {JSON.stringify(data?.diagnostics ?? {}, null, 2)}
          </pre>
        </div>
      </Panel>
      <Panel className="mt-3 px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
            <Bug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] font-semibold">Opt-in crash envelopes</p>
            <p className="mt-1 text-[9.5px] leading-4 text-muted">
              Unexpected app failures are retained locally as redacted, bounded
              envelopes. Nothing is transmitted automatically. Review the exact
              payload, then choose whether to send one to Support.
            </p>
          </div>
        </div>
        {crashes.data?.[0] ? (
          <div className="mt-3 grid grid-cols-[1fr_150px] gap-3">
            <pre
              data-testid="crash-envelope-preview"
              className="num max-h-48 overflow-auto rounded border border-line bg-panel2 px-3 py-2 text-[8.5px] leading-4 text-muted"
            >
              {JSON.stringify(crashes.data[0], null, 2)}
            </pre>
            <div>
              <p className="text-[9px] leading-4 text-muted">
                Sending creates a trackable support case. No company metadata,
                logs or screenshots are added.
              </p>
              <Button
                className="mt-2 w-full"
                disabled={sendingCrash === crashes.data[0].id}
                onClick={async () => {
                  const envelope = crashes.data?.[0];
                  if (!envelope) return;
                  setSendingCrash(envelope.id);
                  try {
                    const result = await api.crashes.submit(envelope.id);
                    toast.push("success", `Crash report sent · ${result.caseId}`);
                  } catch (error) {
                    toast.push("error", (error as Error).message);
                  } finally {
                    setSendingCrash(null);
                  }
                }}
              >
                {sendingCrash ? "Sending…" : "Send this envelope"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 rounded border border-dashed border-line px-3 py-4 text-center text-[9.5px] text-muted">
            No crash envelopes on this device.
          </p>
        )}
      </Panel>
      <p className="mt-3 text-[9px] text-muted">
        Retention:{" "}
        {data?.retention
          .map(
            (row) =>
              `${row.evidenceKind} ${row.keepDays == null ? "forever" : `${row.keepDays} days`}`,
          )
          .join(" · ")}
      </p>
    </div>
  );
}
