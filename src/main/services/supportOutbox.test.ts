import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import {
  enqueueSupportPayload,
  getSupportOutboxItem,
  readSupportOutbox,
  removeSupportOutboxItem,
  summarizeSupportOutbox,
  updateSupportOutboxItem,
} from "./supportOutbox";

describe("encrypted support outbox", () => {
  it("persists ciphertext while summaries never expose it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "total-support-outbox-")), "outbox.json");
    const summary = enqueueSupportPayload(path, {
      caseId: "TOT-20260825-A1B2C3D4E5F6",
      encryptedPayload: Buffer.from("device-encrypted-message").toString("base64"),
      hasAttachment: true,
      lastError: "Network delivery failed",
    });
    expect(summary).not.toHaveProperty("encryptedPayload");
    expect(readFileSync(path, "utf8")).not.toContain("device-encrypted-message");
    expect(getSupportOutboxItem(path, summary.id).hasAttachment).toBe(true);
  });

  it("replaces an older queued payload for the same case and supports retry state and deletion", () => {
    const path = join(mkdtempSync(join(tmpdir(), "total-support-outbox-")), "outbox.json");
    enqueueSupportPayload(path, {
      caseId: "TOT-20260825-A1B2C3D4E5F6",
      encryptedPayload: Buffer.from("old").toString("base64"),
      hasAttachment: false,
      lastError: "offline",
    });
    const latest = enqueueSupportPayload(path, {
      caseId: "TOT-20260825-A1B2C3D4E5F6",
      encryptedPayload: Buffer.from("new").toString("base64"),
      hasAttachment: false,
      lastError: "offline again",
    });
    expect(readSupportOutbox(path)).toHaveLength(1);
    const retrying = updateSupportOutboxItem(path, latest.id, {
      status: "retrying",
      attempts: 1,
      lastError: null,
    });
    expect(retrying).toMatchObject({ status: "retrying", attempts: 1 });
    expect(removeSupportOutboxItem(path, latest.id)).toBe(true);
    expect(readSupportOutbox(path)).toEqual([]);
    expect(summarizeSupportOutbox([])).toEqual([]);
  });

  it("fails closed on corrupt files and drops malformed records without exposing payloads", () => {
    const path = join(mkdtempSync(join(tmpdir(), "total-support-outbox-")), "outbox.json");
    writeFileSync(path, "{truncated");
    expect(readSupportOutbox(path)).toEqual([]);
    expect(() => getSupportOutboxItem(path, "00000000-0000-4000-8000-000000000001")).toThrow(
      "Queued support submission not found",
    );

    writeFileSync(path, JSON.stringify({
      schema: 1,
      items: [
        { id: "../../company.db", encryptedPayload: "c2VjcmV0" },
        { id: "00000000-0000-4000-8000-000000000001", caseId: "wrong", status: "queued" },
      ],
    }));
    expect(readSupportOutbox(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("../../company.db");
  });
});
