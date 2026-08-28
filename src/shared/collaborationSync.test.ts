import { describe, expect, it } from "vitest";
import {
  collaborationPublishSchema,
  syncConfigureSchema,
  compareVectorClocks,
  deriveSyncPhase,
  mergeCollaborativeDocuments,
  parseTeamInvitationCode,
  type CollaborativeDocument,
} from "./collaborationSync";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

function document(deviceId: string, value: string, clock: Record<string, number>, updatedAt: string): CollaborativeDocument {
  return {
    entityKind: "task",
    entityId: "month-close-review",
    fields: {
      title: { value, clock, updatedAt, deviceId },
    },
    clock,
    deleted: false,
  };
}

describe("encrypted collaboration merge", () => {
  it("derives an explicit privacy-safe local sync phase", () => {
    expect(deriveSyncPhase({ configured: false, enabled: false, pending: 0, persistedPhase: null, lastError: null })).toBe("not_configured");
    expect(deriveSyncPhase({ configured: true, enabled: false, pending: 2, persistedPhase: null, lastError: "offline" })).toBe("paused");
    expect(deriveSyncPhase({ configured: true, enabled: true, pending: 2, persistedPhase: "syncing", lastError: "earlier failure" })).toBe("syncing");
    expect(deriveSyncPhase({ configured: true, enabled: true, pending: 2, persistedPhase: "idle", lastError: "offline" })).toBe("error");
    expect(deriveSyncPhase({ configured: true, enabled: true, pending: 2, persistedPhase: "idle", lastError: null })).toBe("pending");
    expect(deriveSyncPhase({ configured: true, enabled: true, pending: 0, persistedPhase: "idle", lastError: null })).toBe("idle");
  });

  it("orders vector clocks without relying on wall-clock time", () => {
    expect(compareVectorClocks({ [DEVICE_A]: 1 }, { [DEVICE_A]: 2 })).toBe("before");
    expect(compareVectorClocks({ [DEVICE_A]: 2 }, { [DEVICE_A]: 1 })).toBe("after");
    expect(compareVectorClocks({ [DEVICE_A]: 1 }, { [DEVICE_B]: 1 })).toBe("concurrent");
  });

  it("keeps a deterministic value and reports concurrent edits", () => {
    const a = document(DEVICE_A, "Review April", { [DEVICE_A]: 1 }, "2026-08-27T10:00:00.000Z");
    const b = document(DEVICE_B, "Review Q1", { [DEVICE_B]: 1 }, "2026-08-27T10:00:00.000Z");
    const ab = mergeCollaborativeDocuments(a, b);
    const ba = mergeCollaborativeDocuments(b, a);
    expect(ab.document).toEqual(ba.document);
    expect(ab.conflicts).toHaveLength(1);
    expect(ab.conflicts[0]?.field).toBe("title");
    expect(ab.document.fields.title?.value).toBe("Review Q1");
  });

  it("lets a causally newer field replace its ancestor without a conflict", () => {
    const before = document(DEVICE_A, "Draft", { [DEVICE_A]: 1 }, "2026-08-27T10:00:00.000Z");
    const after = document(DEVICE_A, "Ready", { [DEVICE_A]: 2 }, "2026-08-27T09:00:00.000Z");
    const merged = mergeCollaborativeDocuments(before, after);
    expect(merged.document.fields.title?.value).toBe("Ready");
    expect(merged.conflicts).toEqual([]);
  });

  it("converges after deterministic offline edits to different fields", () => {
    const base = document(DEVICE_A, "Review April", { [DEVICE_A]: 1 }, "2026-08-27T10:00:00.000Z");
    const offlineA: CollaborativeDocument = {
      ...base,
      fields: {
        ...base.fields,
        assignee: { value: "Asha", clock: { [DEVICE_A]: 2 }, updatedAt: "2026-08-27T10:01:00.000Z", deviceId: DEVICE_A },
      },
      clock: { [DEVICE_A]: 2 },
    };
    const offlineB: CollaborativeDocument = {
      ...base,
      fields: {
        ...base.fields,
        due: { value: "2026-08-31", clock: { [DEVICE_A]: 1, [DEVICE_B]: 1 }, updatedAt: "2026-08-27T10:02:00.000Z", deviceId: DEVICE_B },
      },
      clock: { [DEVICE_A]: 1, [DEVICE_B]: 1 },
    };
    const ab = mergeCollaborativeDocuments(offlineA, offlineB);
    const ba = mergeCollaborativeDocuments(offlineB, offlineA);
    expect(ab.document).toEqual(ba.document);
    expect(ab.document.fields.assignee?.value).toBe("Asha");
    expect(ab.document.fields.due?.value).toBe("2026-08-31");
    expect(ab.conflicts).toEqual([]);
  });

  it("reports each concurrently changed field while preserving unaffected fields", () => {
    const a = document(DEVICE_A, "Review sales", { [DEVICE_A]: 2 }, "2026-08-27T10:00:00.000Z");
    a.fields.note = { value: "Owner note", clock: { [DEVICE_A]: 2 }, updatedAt: "2026-08-27T10:00:00.000Z", deviceId: DEVICE_A };
    const b = document(DEVICE_B, "Review purchases", { [DEVICE_B]: 2 }, "2026-08-27T10:00:00.000Z");
    b.fields.note = { value: "Member note", clock: { [DEVICE_B]: 2 }, updatedAt: "2026-08-27T10:00:00.000Z", deviceId: DEVICE_B };
    b.fields.status = { value: "open", clock: { [DEVICE_B]: 2 }, updatedAt: "2026-08-27T10:00:00.000Z", deviceId: DEVICE_B };
    const merged = mergeCollaborativeDocuments(a, b);
    expect(merged.conflicts.map((conflict) => conflict.field).sort()).toEqual(["note", "title"]);
    expect(merged.document.fields.status?.value).toBe("open");
  });

  it("bounds collaboration payloads and rejects prototype fields", () => {
    expect(() => collaborationPublishSchema.parse({
      entityKind: "comment",
      entityId: "review-1",
      patch: { body: "x".repeat(300 * 1024) },
    })).toThrow("256 KB");
    const unsafe = Object.create(null) as Record<string, unknown>;
    unsafe.__proto__ = "unsafe";
    expect(() => collaborationPublishSchema.parse({
      entityKind: "comment",
      entityId: "review-1",
      patch: unsafe,
    })).toThrow("Unsafe field name");
  });

  it("parses versioned invitation codes without accepting ambiguous text", () => {
    const parsed = parseTeamInvitationCode(
      "total-invite-v1:11111111-1111-4111-8111-111111111111:abcdefghijklmnopqrstuvwxyzABCDEFG123456789",
    );
    expect(parsed.workspaceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(() => parseTeamInvitationCode("invite me")).toThrow("invalid");
  });

  it("requires Supabase refresh credentials as a pair while preserving static bearer configuration", () => {
    const base = { endpoint: "https://sync.example/v1", workspaceId: DEVICE_A, apiToken: "access", enabled: true };
    expect(syncConfigureSchema.parse(base)).toMatchObject(base);
    expect(() => syncConfigureSchema.parse({ ...base, refreshToken: "refresh" })).toThrow("provided together");
    expect(syncConfigureSchema.parse({ ...base, refreshToken: "refresh", anonKey: "anon" })).toMatchObject({ refreshToken: "refresh", anonKey: "anon" });
  });
});
