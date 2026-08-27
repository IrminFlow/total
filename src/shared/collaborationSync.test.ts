import { describe, expect, it } from "vitest";
import {
  collaborationPublishSchema,
  compareVectorClocks,
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
});
