export const MCP_CONTRACT_VERSION = 1 as const;

export const MCP_SCOPES = [
  "companies:list",
  "mirror:read",
  "attachment:read",
  "proposal:create",
  "mirror:refresh",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpTokenSummary {
  id: string;
  name: string;
  company: string;
  scopes: McpScope[];
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
}

export interface McpAuditEvent {
  timestamp: string;
  client: string;
  tool: string;
  company: string;
  outcome: "allowed" | "denied" | "error";
  proposalId: string | null;
  errorCode: string | null;
}

export interface McpRefreshRequest {
  id: string;
  company: string;
  client: string;
  requestedAt: string;
  status: "pending";
}

export interface McpMirrorStatus {
  generatedAt: string | null;
  schemaVersion: number | null;
  files: string[];
  ageSeconds: number | null;
  stale: boolean;
}
