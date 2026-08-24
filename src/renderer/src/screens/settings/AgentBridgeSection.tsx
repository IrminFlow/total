import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clock,
  Copy,
  Database,
  Key,
  PlugsConnected,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { MCP_SCOPES, type McpScope } from "@shared/mcp";
import { toDisplayDateTime } from "@shared/dates";
import { api } from "../../lib/client";
import { useSession, useToasts } from "../../state/stores";
import {
  Button,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
  Skeleton,
  TextInput,
} from "../../components/ui";

export function AgentBridgeSection(): React.JSX.Element {
  const toast = useToasts();
  const qc = useQueryClient();
  const { user, slug } = useSession();
  const owner = !user || user.role === "owner";
  const config = useQuery({
    queryKey: ["agentConfig"],
    queryFn: api.agent.getConfig,
  });
  const proposals = useQuery({
    queryKey: ["agentProposals"],
    queryFn: api.agent.listProposals,
  });
  const mirror = useQuery({
    queryKey: ["mcpMirrorStatus"],
    queryFn: api.mcp.mirrorStatus,
  });
  const tokens = useQuery({
    queryKey: ["mcpTokens"],
    queryFn: api.mcp.tokens,
    enabled: owner,
  });
  const audit = useQuery({
    queryKey: ["mcpAudit"],
    queryFn: () => api.mcp.audit(100),
    enabled: owner,
  });
  const requests = useQuery({
    queryKey: ["mcpRefreshRequests"],
    queryFn: api.mcp.refreshRequests,
    enabled: owner,
  });
  const [toggling, setToggling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const companyPath = `~/Documents/total/companies/${slug ?? "<company>"}`;

  const refreshMcp = async (): Promise<void> => {
    await Promise.all(
      ["mcpMirrorStatus", "mcpTokens", "mcpAudit", "mcpRefreshRequests"].map(
        (key) => qc.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const toggle = async (): Promise<void> => {
    if (!config.data) return;
    setToggling(true);
    try {
      const result = await api.agent.setConfig(!config.data.enabled);
      await qc.invalidateQueries({ queryKey: ["agentConfig"] });
      toast.push(
        "success",
        result.enabled ? "Agent inbox enabled" : "Agent inbox disabled",
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setToggling(false);
    }
  };
  const exportMirror = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await api.agent.exportMirror();
      await refreshMcp();
      toast.push(
        "success",
        `Fresh mirror generated · ${result.files.length} files`,
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setExporting(false);
    }
  };
  const approveProposal = async (file: string): Promise<void> => {
    setReviewing(file);
    try {
      const saved = await api.agent.approveProposal(file);
      await qc.invalidateQueries();
      if (saved.approvalRequired) {
        toast.push(
          "success",
          `Proposal reviewed · approval request #${saved.request.id} is waiting for a checker`,
        );
      } else {
        toast.push("success", `Approved and posted voucher ${saved.number}`);
      }
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setReviewing(null);
    }
  };
  const discardProposal = async (file: string): Promise<void> => {
    setReviewing(file);
    try {
      await api.agent.discardProposal(file);
      await qc.invalidateQueries({ queryKey: ["agentProposals"] });
      toast.push("success", "Draft discarded; the books were not changed");
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setReviewing(null);
    }
  };
  const decideRefresh = async (
    id: string,
    approved: boolean,
  ): Promise<void> => {
    try {
      const result = await api.mcp.decideRefresh(id, approved);
      await refreshMcp();
      toast.push(
        "success",
        approved
          ? `Refresh approved · ${result.files.length} files`
          : "Refresh request rejected",
      );
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const revoke = async (id: string): Promise<void> => {
    try {
      await api.mcp.revokeToken(id);
      await refreshMcp();
      toast.push("success", "MCP token revoked immediately");
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <div data-testid="agent-access-settings">
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <ShieldCheck size={14} className="text-dr" /> Proposal-only writes
          </span>
        }
      >
        Agent access
      </SectionTitle>
      <div className="mb-4 grid gap-3 lg:grid-cols-[1.4fr_0.6fr]">
        <Panel className="relative overflow-hidden !bg-ink px-6 py-5 text-panel">
          <div className="absolute -right-16 -top-24 size-60 rounded-full border border-panel/10" />
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-panel/45">
            Controlled extensibility
          </p>
          <h3 className="mt-3 font-serif text-[26px] font-semibold tracking-[-0.02em]">
            Useful access, narrow authority.
          </h3>
          <p className="mt-2 max-w-2xl text-[11px] leading-5 text-panel/55">
            Every MCP token is tied to this company, explicit scopes and an
            expiry. Clients read generated mirrors; voucher proposals stay
            outside the books until a person approves them.
          </p>
        </Panel>
        <Panel className="px-4 py-4">
          <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-muted">
            Mirror freshness
          </p>
          <div className="mt-2 flex items-center gap-2">
            {mirror.data?.stale ? (
              <Warning size={18} className="text-amber" />
            ) : (
              <Check size={18} className="text-dr" weight="bold" />
            )}
            <p className="text-[13px] font-semibold">
              {mirror.data?.generatedAt
                ? mirror.data.stale
                  ? "Refresh recommended"
                  : "Current"
                : "Not generated"}
            </p>
          </div>
          <p className="mt-1 text-[9.5px] text-muted">
            {mirror.data?.generatedAt
              ? `${toDisplayDateTime(new Date(mirror.data.generatedAt))} · schema ${mirror.data.schemaVersion ?? "?"}`
              : "Generate the first read-only mirror below."}
          </p>
          <Button
            data-testid="btn-settings-agent-export"
            className="mt-3 w-full"
            disabled={exporting}
            onClick={() => void exportMirror()}
          >
            {exporting ? "Generating…" : "Generate fresh mirror"}
          </Button>
        </Panel>
      </div>
      <Panel className="overflow-hidden p-0">
        <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto]">
          <div className="flex gap-3">
            <Database size={21} className="mt-0.5 text-muted" />
            <div>
              <p className="text-[12.5px] font-semibold">
                Drop-folder automation
              </p>
              <p className="mt-1 text-[10.5px] leading-4 text-muted">
                Optional bridge for validated voucher JSON and master CSV files
                in <span className="num">{companyPath}/inbox</span>. MCP tokens
                do not depend on this switch.
              </p>
            </div>
          </div>
          {!config.data ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="flex items-center gap-2 self-center">
              <span
                className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase ${config.data.enabled ? "border-dr/30 text-dr" : "border-line text-muted"}`}
              >
                {config.data.enabled ? "On" : "Off"}
              </span>
              <Button
                disabled={toggling || !owner}
                disabledTitle={
                  !owner ? "Only owners can change agent access" : undefined
                }
                onClick={() => void toggle()}
              >
                {toggling
                  ? "Saving…"
                  : config.data.enabled
                    ? "Turn off"
                    : "Turn on"}
              </Button>
            </div>
          )}
        </div>
      </Panel>

      <div className="mt-6 flex items-end justify-between">
        <SectionTitle>MCP access tokens</SectionTitle>
        {owner && (
          <Button
            data-testid="btn-mcp-issue"
            variant="primary"
            onClick={() => setTokenOpen(true)}
          >
            <span className="flex items-center gap-1.5">
              <Key size={14} /> Issue token
            </span>
          </Button>
        )}
      </div>
      <Panel className="overflow-hidden p-0">
        <TokenList owner={owner} rows={tokens.data ?? []} onRevoke={revoke} />
      </Panel>
      {(requests.data?.length ?? 0) > 0 && (
        <Panel
          className="mt-4 overflow-hidden p-0"
          data-testid="mcp-refresh-requests"
        >
          <div className="border-b border-line bg-panel2 px-4 py-3">
            <p className="text-[11.5px] font-semibold">
              Mirror refresh requests
            </p>
            <p className="mt-0.5 text-[9.5px] text-muted">
              Clients can request freshness but cannot open SQLite or regenerate
              data themselves.
            </p>
          </div>
          <div className="divide-y divide-line">
            {requests.data!.map((request) => (
              <div
                key={request.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <p className="text-[11px] font-medium">{request.client}</p>
                  <p className="num mt-0.5 text-[9px] text-muted">
                    {toDisplayDateTime(new Date(request.requestedAt))} ·{" "}
                    {request.id}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button onClick={() => void decideRefresh(request.id, false)}>
                    Reject
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void decideRefresh(request.id, true)}
                  >
                    Approve refresh
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="mt-6 flex items-end justify-between">
        <SectionTitle>Draft review queue</SectionTitle>
        <span className="mb-2 text-[10px] text-muted">
          {proposals.data?.length ?? 0} pending
        </span>
      </div>
      <Panel className="overflow-hidden p-0">
        <ProposalList
          rows={proposals.data ?? []}
          reviewing={reviewing}
          viewer={user?.role === "viewer"}
          onApprove={approveProposal}
          onDiscard={discardProposal}
        />
      </Panel>
      {owner && (
        <Panel className="mt-4 overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-line bg-panel2 px-4 py-3">
            <div>
              <p className="text-[11.5px] font-semibold">MCP audit evidence</p>
              <p className="mt-0.5 text-[9.5px] text-muted">
                Client, tool, company, outcome and proposal identity. Arguments
                and secrets are never logged.
              </p>
            </div>
            <PlugsConnected size={19} className="text-muted" />
          </div>
          <AuditList rows={audit.data ?? []} />
        </Panel>
      )}
      <Panel className="mt-4 p-4">
        <p className="text-[12px] font-semibold">Connect a client</p>
        <p className="mt-1 text-[10.5px] leading-4 text-muted">
          Issue a token, then configure the bundled stdio server with{" "}
          <span className="num">TOTAL_MCP_TOKEN</span> and a descriptive{" "}
          <span className="num">TOTAL_MCP_CLIENT</span>. The token’s company and
          scopes are enforced by the server.
        </p>
        <pre className="mt-3 overflow-auto rounded border border-line bg-panel2 p-3 text-[9.5px] leading-relaxed">
          {
            'macOS: node /Applications/Total.app/Contents/Resources/total-mcp.mjs\nWindows: node "%LOCALAPPDATA%\\Programs\\Total\\resources\\total-mcp.mjs"'
          }
        </pre>
      </Panel>
      {tokenOpen && (
        <IssueTokenModal
          onClose={() => setTokenOpen(false)}
          onIssued={async (token) => {
            setTokenOpen(false);
            setRevealedToken(token);
            await refreshMcp();
          }}
        />
      )}
      {revealedToken && (
        <RevealToken
          token={revealedToken}
          onClose={() => setRevealedToken(null)}
        />
      )}
    </div>
  );
}

type TokenRow = Awaited<ReturnType<typeof api.mcp.tokens>>[number];
function TokenList({
  owner,
  rows,
  onRevoke,
}: {
  owner: boolean;
  rows: TokenRow[];
  onRevoke: (id: string) => Promise<void>;
}): React.JSX.Element {
  if (!owner)
    return (
      <div className="px-5 py-8 text-center text-[11.5px] text-muted">
        Only owners can view or issue MCP credentials.
      </div>
    );
  if (!rows.length)
    return (
      <div className="px-5 py-8 text-center">
        <p className="text-[12.5px] font-medium">No MCP tokens</p>
        <p className="mt-1 text-[10.5px] text-muted">
          Issue a short-lived token for a named client. The secret is shown
          once.
        </p>
      </div>
    );
  return (
    <div className="divide-y divide-line">
      {rows.map((token) => {
        const expired = Date.parse(token.expiresAt) <= Date.now();
        const inactive = !!token.revokedAt || expired;
        return (
          <div
            key={token.id}
            className="grid items-center gap-3 px-5 py-3 md:grid-cols-[1fr_1.3fr_auto]"
          >
            <div>
              <p className="text-[11.5px] font-semibold">{token.name}</p>
              <p className="mt-0.5 text-[9px] text-muted">
                Issued by {token.createdBy} · expires{" "}
                {toDisplayDateTime(new Date(token.expiresAt))}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {token.scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[8.5px] text-muted"
                >
                  {scope}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-[9px] font-semibold uppercase ${inactive ? "text-cr" : "text-dr"}`}
              >
                {token.revokedAt ? "Revoked" : expired ? "Expired" : "Active"}
              </span>
              {!inactive && (
                <Button variant="ghost" onClick={() => void onRevoke(token.id)}>
                  Revoke
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type ProposalRow = Awaited<ReturnType<typeof api.agent.listProposals>>[number];
function ProposalList({
  rows,
  reviewing,
  viewer,
  onApprove,
  onDiscard,
}: {
  rows: ProposalRow[];
  reviewing: string | null;
  viewer: boolean;
  onApprove: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
}): React.JSX.Element {
  if (!rows.length)
    return (
      <div className="px-5 py-8 text-center">
        <p className="text-[12.5px] font-medium">No agent drafts waiting</p>
        <p className="mt-1 text-[10.5px] text-muted">
          MCP and AI proposals appear here. Nothing posts automatically.
        </p>
      </div>
    );
  return (
    <div className="divide-y divide-line">
      {rows.map((proposal) => (
        <div
          key={proposal.id}
          className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded border border-line px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted">
                {proposal.source}
              </span>
              <span className="num text-[9px] text-muted">
                {toDisplayDateTime(new Date(proposal.createdAt))}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] font-medium">{proposal.summary}</p>
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] text-blue">
                Inspect exact JSON
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded border border-line bg-panel2 p-3 text-[9.5px] leading-relaxed">
                {JSON.stringify(proposal.voucher, null, 2)}
              </pre>
            </details>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              disabled={reviewing !== null || viewer}
              onClick={() => void onDiscard(proposal.id)}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              disabled={reviewing !== null || viewer}
              onClick={() => void onApprove(proposal.id)}
            >
              {reviewing === proposal.id ? "Reviewing…" : "Approve & post"}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

type AuditRow = Awaited<ReturnType<typeof api.mcp.audit>>[number];
function AuditList({ rows }: { rows: AuditRow[] }): React.JSX.Element {
  if (!rows.length)
    return (
      <div className="px-4 py-6 text-center text-[10.5px] text-muted">
        No MCP calls recorded yet.
      </div>
    );
  return (
    <div className="max-h-64 divide-y divide-line overflow-y-auto">
      {rows.map((event, index) => (
        <div
          key={`${event.timestamp}-${index}`}
          className="grid grid-cols-[130px_1fr_110px_auto] gap-3 px-4 py-2 text-[9.5px]"
        >
          <span className="num text-muted">
            {toDisplayDateTime(new Date(event.timestamp))}
          </span>
          <span>
            <strong className="font-medium">{event.tool}</strong> ·{" "}
            {event.client}
          </span>
          <span className={event.outcome === "allowed" ? "text-dr" : "text-cr"}>
            {event.outcome}
            {event.errorCode ? ` · ${event.errorCode}` : ""}
          </span>
          <span className="num max-w-40 truncate text-muted">
            {event.proposalId ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

const scopeLabels: Record<McpScope, string> = {
  "companies:list": "List this company",
  "mirror:read": "Read generated mirrors",
  "attachment:read": "Read managed attachments",
  "proposal:create": "Create review-only proposals",
  "mirror:refresh": "Request mirror refresh",
};
function IssueTokenModal({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (token: string) => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<McpScope[]>([
    "companies:list",
    "mirror:read",
  ]);
  const [busy, setBusy] = useState(false);
  const issue = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.mcp.issueToken({
        name,
        scopes,
        expiresAt: new Date(
          Date.now() + Number(days) * 86_400_000,
        ).toISOString(),
      });
      await onIssued(result.token);
    } catch (error) {
      toast.push(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      setBusy(false);
    }
  };
  return (
    <Modal title="Issue scoped MCP token" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Client name"
          hint="Use a recognizable device or application name."
        >
          <TextInput
            data-testid="input-mcp-token-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Claude Desktop · Finance Mac"
          />
        </Field>
        <Field label="Expires after">
          <Select
            value={days}
            onChange={(event) => setDays(event.target.value)}
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </Select>
        </Field>
        <div>
          <p className="mb-1 text-[10px] font-medium text-muted">
            Permission scopes
          </p>
          <div className="grid gap-1.5">
            {MCP_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-3 py-2 text-[10.5px]"
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((item) => item !== scope),
                    )
                  }
                />
                <span>
                  <strong className="font-medium text-ink">
                    {scopeLabels[scope]}
                  </strong>
                  <span className="num ml-2 text-[8.5px] text-muted">
                    {scope}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <p className="text-[9.5px] leading-4 text-muted">
          Proposal scope can create files in the review queue only. It never
          grants posting authority.
        </p>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            data-testid="btn-mcp-token-create"
            variant="primary"
            disabled={busy || !name.trim() || scopes.length === 0}
            onClick={() => void issue()}
          >
            {busy ? "Issuing…" : "Issue token"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RevealToken({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  return (
    <Modal title="Copy MCP token now" onClose={onClose}>
      <div className="rounded-md border border-amber/30 bg-amber/5 p-3">
        <p className="flex items-center gap-2 text-[11.5px] font-semibold">
          <Clock size={15} /> This secret is shown once
        </p>
        <p className="mt-1 text-[10px] leading-4 text-muted">
          Store it in the MCP client’s environment. Total retains only its
          SHA-256 hash and cannot reveal it again.
        </p>
      </div>
      <pre
        data-testid="mcp-revealed-token"
        className="mt-3 overflow-auto rounded-md border border-line bg-ink p-3 text-[10px] text-panel"
      >
        {token}
      </pre>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Done</Button>
        <Button
          variant="primary"
          onClick={() =>
            void api.privacy
              .copySensitive(token)
              .then((result) =>
                toast.push(
                  "success",
                  result.clearsAfterSeconds
                    ? `Token copied · clears in ${result.clearsAfterSeconds}s`
                    : "Token copied",
                ),
              )
          }
        >
          <span className="flex items-center gap-1.5">
            <Copy size={14} /> Copy token
          </span>
        </Button>
      </div>
    </Modal>
  );
}
