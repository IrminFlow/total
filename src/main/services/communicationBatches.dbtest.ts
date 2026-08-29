import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^sealed:/, ""),
  },
}));

import { seededDb } from "../db/testdb";
import {
  createOutboundDraft,
  createSmtpProfile,
  getOutboundMessage,
  updateOutboundDraft,
} from "./communications";
import {
  approveCommunicationBatch,
  createCommunicationBatch,
  enqueueCommunicationBatch,
  listCommunicationBatchEvents,
  rejectCommunicationBatch,
} from "./communicationBatches";
import { saveUser } from "./users";

function message(db: ReturnType<typeof seededDb>, suffix: string) {
  return createOutboundDraft(
    db,
    {
      idempotencyKey: `batch-draft-${suffix}-0000001`,
      ledgerId: null,
      contactId: null,
      to: [`${suffix}@example.com`],
      cc: [],
      bcc: [],
      subject: `Invoice ${suffix}`,
      bodyText: `Reviewed invoice draft ${suffix}`,
    },
    "Maker",
  );
}

function input(ids: string[]) {
  return {
    name: "August customer dispatch",
    items: ids.map((messageId, index) => ({
      messageId,
      documentKind: index === 1 ? ("statement" as const) : ("invoice" as const),
      documentLabel: `Document ${index + 1}`,
      amountPaise: (index + 1) * 100_000,
      exclusionReason: index === 2 ? "Customer asked for paper delivery" : null,
    })),
  };
}

describe("communication approval batches", () => {
  it("snapshots exact previews, enforces maker-checker and records bounded retry evidence", () => {
    const db = seededDb();
    const maker = saveUser(db, {
      name: "Maker",
      role: "accountant",
      pin: "1111",
    });
    const checker = saveUser(db, {
      name: "Checker",
      role: "owner",
      pin: "2222",
    });
    const messages = [
      message(db, "one"),
      message(db, "two"),
      message(db, "three"),
    ];
    const batch = createCommunicationBatch(
      db,
      input(messages.map((row) => row.id)),
      maker,
    );

    expect(batch).toMatchObject({
      status: "pending_approval",
      selectedCount: 3,
      includedCount: 2,
      excludedCount: 1,
      recipientCount: 2,
      totalAmountPaise: 300_000,
      makerUserId: maker.id,
    });
    expect(
      batch.items.map((row) => ({
        status: row.status,
        to: row.to,
        subject: row.subject,
        bodyText: row.bodyText,
        amountPaise: row.amountPaise,
      })),
    ).toEqual([
      {
        status: "ready",
        to: ["one@example.com"],
        subject: "Invoice one",
        bodyText: "Reviewed invoice draft one",
        amountPaise: 100_000,
      },
      {
        status: "ready",
        to: ["two@example.com"],
        subject: "Invoice two",
        bodyText: "Reviewed invoice draft two",
        amountPaise: 200_000,
      },
      {
        status: "excluded",
        to: ["three@example.com"],
        subject: "Invoice three",
        bodyText: "Reviewed invoice draft three",
        amountPaise: 300_000,
      },
    ]);
    expect(() => approveCommunicationBatch(db, batch.id, maker, null)).toThrow(
      /different active users/,
    );

    const approved = approveCommunicationBatch(
      db,
      batch.id,
      checker,
      "Recipients and amounts checked",
    );
    expect(approved).toMatchObject({
      status: "approved",
      checkerUserId: checker.id,
    });
    expect(getOutboundMessage(db, messages[0]!.id).status).toBe("reviewed");
    expect(getOutboundMessage(db, messages[1]!.id).status).toBe("reviewed");
    expect(getOutboundMessage(db, messages[2]!.id).status).toBe("draft");

    const failed = enqueueCommunicationBatch(db, batch.id, 999_999, checker);
    expect(failed.status).toBe("approved");
    expect(failed.items.filter((row) => row.status === "failed")).toHaveLength(
      2,
    );
    expect(
      failed.items
        .filter((row) => row.status === "failed")
        .every((row) => row.attempts === 1),
    ).toBe(true);

    const smtp = createSmtpProfile(
      db,
      {
        name: "Batch mail",
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        username: "books@example.com",
        password: "local-device-secret",
        fromEmail: "books@example.com",
        fromName: "Accounts",
        replyTo: null,
        active: true,
      },
      checker.name,
    );
    const queued = enqueueCommunicationBatch(
      db,
      batch.id,
      smtp.id,
      checker,
      failed.items
        .filter((row) => row.status === "failed")
        .map((row) => row.id),
    );
    expect(queued.status).toBe("queued");
    expect(queued.items.filter((row) => row.status === "queued")).toHaveLength(
      2,
    );
    expect(
      queued.items
        .filter((row) => row.status === "queued")
        .every((row) => row.attempts === 2),
    ).toBe(true);
    const events = listCommunicationBatchEvents(db, batch.id);
    expect(events.map((row) => row.eventType)).toEqual([
      "created",
      "approved",
      "enqueue_started",
      "item_failed",
      "item_failed",
      "enqueue_completed",
      "retry_started",
      "enqueue_started",
      "item_queued",
      "item_queued",
      "enqueue_completed",
    ]);
    expect(
      events.find((row) => row.eventType === "enqueue_started")?.detail,
    ).toMatchObject({
      boundedLimit: 25,
      meaning:
        "Queued locally for SMTP submission; recipient delivery is not confirmed",
    });
    expect(() =>
      db
        .prepare("UPDATE communication_batch_events SET actor='tampered'")
        .run(),
    ).toThrow(/append-only/);
  });

  it("refuses approval when a snapshotted draft changed", () => {
    const db = seededDb();
    const maker = saveUser(db, {
      name: "Maker",
      role: "accountant",
      pin: "1111",
    });
    const checker = saveUser(db, {
      name: "Checker",
      role: "owner",
      pin: "2222",
    });
    const first = message(db, "stale-one");
    const second = message(db, "stale-two");
    const batch = createCommunicationBatch(
      db,
      input([first.id, second.id]),
      maker,
    );
    updateOutboundDraft(
      db,
      first.id,
      {
        ledgerId: null,
        contactId: null,
        to: first.to,
        cc: [],
        bcc: [],
        subject: "Updated invoice",
        bodyText: first.bodyText,
        expectedRevision: first.revision,
      },
      maker.name,
    );
    expect(() =>
      approveCommunicationBatch(db, batch.id, checker, null),
    ).toThrow(/changed after the batch preview/);
    expect(getOutboundMessage(db, second.id).status).toBe("draft");
  });

  it("auto-reviews locally when a company has no user controls", () => {
    const db = seededDb();
    const first = message(db, "local-one");
    const second = message(db, "local-two");
    const batch = createCommunicationBatch(db, input([first.id, second.id]), {
      id: null,
      name: "Local user",
    });
    expect(batch.status).toBe("approved");
    expect(getOutboundMessage(db, first.id).status).toBe("reviewed");
    expect(listCommunicationBatchEvents(db, batch.id)[1]).toMatchObject({
      eventType: "approved",
      detail: { control: "not_applicable_no_users" },
    });
  });

  it("records a checker rejection without changing any draft", () => {
    const db = seededDb();
    const maker = saveUser(db, {
      name: "Maker",
      role: "accountant",
      pin: "1111",
    });
    const checker = saveUser(db, {
      name: "Checker",
      role: "owner",
      pin: "2222",
    });
    const first = message(db, "reject-one");
    const second = message(db, "reject-two");
    const batch = createCommunicationBatch(
      db,
      input([first.id, second.id]),
      maker,
    );
    expect(
      rejectCommunicationBatch(db, batch.id, checker, "Wrong statement period"),
    ).toMatchObject({
      status: "rejected",
      checkerUserId: checker.id,
    });
    expect(getOutboundMessage(db, first.id).status).toBe("draft");
  });
});
