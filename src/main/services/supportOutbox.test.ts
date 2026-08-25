import { mkdtempSync, readFileSync } from "fs";
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
});
