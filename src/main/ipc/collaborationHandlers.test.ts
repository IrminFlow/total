import { describe, expect, it, vi } from "vitest";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";
import type { Role } from "../services/roles";

const mocks = vi.hoisted(() => ({
  listTeamInvitations: vi.fn(async () => []),
  createTeamInvitation: vi.fn(async () => ({ invitation: {}, invitationCode: "code" })),
  revokeTeamInvitation: vi.fn(async () => ({})),
  acceptTeamInvitation: vi.fn(async () => ({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    endpoint: "https://sync.example",
    apiToken: "token",
    recoveryKey: "total-sync-key-v1:test",
  })),
  configure: vi.fn(() => ({ credentials: {}, createdRecoveryKey: null })),
  status: vi.fn(() => ({ configured: true })),
}));

vi.mock("../services/collaborationSync", () => ({
  getCollaborationSyncStatus: mocks.status,
  publishCollaborationChange: vi.fn(),
  listCollaborationRecords: vi.fn(() => []),
  runCollaborationSync: vi.fn(),
  listTeamInvitations: mocks.listTeamInvitations,
  createTeamInvitation: mocks.createTeamInvitation,
  revokeTeamInvitation: mocks.revokeTeamInvitation,
  acceptTeamInvitation: mocks.acceptTeamInvitation,
}));
vi.mock("../services/collaborationCredentials", () => ({
  configureCollaborationCredentials: mocks.configure,
  setCollaborationEnabled: vi.fn(),
  removeCollaborationCredentials: vi.fn(),
  exportCollaborationRecoveryKey: vi.fn(),
}));

import { registerCollaborationHandlers } from "./collaborationHandlers";

function setup() {
  const rows: Array<{ channel: string; role?: Role; handler: IpcHandler }> = [];
  let companyReads = 0;
  const handle: IpcHandle = (channel, handler, role) => rows.push({ channel, handler, role });
  registerCollaborationHandlers({
    handle,
    requireCompany: () => {
      companyReads += 1;
      return { slug: "books", db: {}, info: {} } as CompanyContext;
    },
  });
  return {
    handlers: new Map(rows.map((row) => [row.channel, row.handler])),
    roles: new Map(rows.map((row) => [row.channel, row.role])),
    companyReads: () => companyReads,
  };
}

describe("collaboration invitation IPC", () => {
  it("keeps invitation membership changes owner-only", () => {
    const { roles } = setup();
    expect(roles.get("collaboration:invitations:list")).toBe("owner");
    expect(roles.get("collaboration:invitations:create")).toBe("owner");
    expect(roles.get("collaboration:invitations:revoke")).toBe("owner");
    expect(roles.get("collaboration:invitations:accept")).toBe("owner");
  });

  it("rejects malformed expiry and IDs before reading company state", () => {
    const state = setup();
    expect(() => state.handlers.get("collaboration:invitations:create")!({ expiresInHours: 0 })).toThrow();
    expect(() => state.handlers.get("collaboration:invitations:revoke")!({ id: "bad" })).toThrow();
    expect(state.companyReads()).toBe(0);
  });

  it("accepts backend membership before storing the recovery key", async () => {
    const state = setup();
    await state.handlers.get("collaboration:invitations:accept")!({
      endpoint: "https://sync.example",
      apiToken: "signed-user-token",
      invitationCode: "total-invite-v1:11111111-1111-4111-8111-111111111111:abcdefghijklmnopqrstuvwxyzABCDEFG123456789",
      recoveryKey: "total-sync-key-v1:abcdefghijklmnopqrstuvwxyzABCDEFG123456789",
    });
    expect(mocks.acceptTeamInvitation).toHaveBeenCalledOnce();
    expect(mocks.configure).toHaveBeenCalledAfter(mocks.acceptTeamInvitation);
  });
});
