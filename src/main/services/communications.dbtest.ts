import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
  buildEml,
  createOutboundDraft,
  createSmtpProfile,
  deliverOutboundMessage,
  exportMessageEml,
  getOutboundMessage,
  listMessageEvents,
  listPartyContacts,
  listSmtpProfiles,
  queueOutboundMessage,
  reviewOutboundMessage,
  resolveUnknownAcceptance,
  savePartyContact,
  SmtpAcceptanceUnknownError,
  updateOutboundDraft,
  type SmtpTransport,
} from "./communications";

function firstLedgerId(db: ReturnType<typeof seededDb>): number {
  return (
    db.prepare("SELECT id FROM ledgers ORDER BY id LIMIT 1").get() as {
      id: number;
    }
  ).id;
}

function profile(db: ReturnType<typeof seededDb>) {
  return createSmtpProfile(
    db,
    {
      name: "Office mail",
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "books@example.com",
      password: "not-stored-in-plain-text",
      fromEmail: "books@example.com",
      fromName: "Test Co Accounts",
      replyTo: null,
      active: true,
    },
    "Owner",
  );
}

function draft(
  db: ReturnType<typeof seededDb>,
  key = "message-idempotency-0001",
) {
  return createOutboundDraft(
    db,
    {
      idempotencyKey: key,
      ledgerId: null,
      contactId: null,
      to: ["customer@example.com"],
      cc: [],
      bcc: [],
      subject: "Account statement",
      bodyText: "Hello,\n\nPlease review your statement.",
    },
    "Asha",
  );
}

describe("local customer communications", () => {
  it("stores multiple party contacts and maintains one active primary", () => {
    const db = seededDb();
    const ledgerId = firstLedgerId(db);
    const first = savePartyContact(
      db,
      {
        ledgerId,
        name: "Asha",
        role: "Accounts",
        email: "asha@example.com",
        phone: null,
        isPrimary: true,
        active: true,
      },
      "Owner",
    );
    const second = savePartyContact(
      db,
      {
        ledgerId,
        name: "Ravi",
        role: "Owner",
        email: "ravi@example.com",
        phone: "+91 98765 43210",
        isPrimary: true,
        active: true,
      },
      "Owner",
    );
    expect(listPartyContacts(db, ledgerId)).toMatchObject([
      { id: second.id, isPrimary: true },
      { id: first.id, isPrimary: false },
    ]);
    expect(() =>
      savePartyContact(
        db,
        {
          ledgerId,
          name: "Duplicate",
          role: "",
          email: "ASHA@example.com",
          phone: null,
          isPrimary: false,
          active: true,
        },
        "Owner",
      ),
    ).toThrow();
  });

  it("encrypts SMTP passwords and never returns them from list APIs", () => {
    const db = seededDb();
    const saved = profile(db);
    expect(saved).toMatchObject({ hasPassword: true, security: "starttls" });
    expect(saved).not.toHaveProperty("password");
    const stored = db
      .prepare(
        "SELECT encrypted_password AS password FROM smtp_profiles WHERE id=?",
      )
      .get(saved.id) as { password: string };
    expect(stored.password).not.toContain("not-stored-in-plain-text");
    expect(listSmtpProfiles(db)[0]).not.toHaveProperty("encryptedPassword");
  });

  it("deduplicates draft creation and requires the exact reviewed revision", () => {
    const db = seededDb();
    const first = draft(db);
    expect(draft(db).id).toBe(first.id);
    expect(() =>
      createOutboundDraft(
        db,
        {
          idempotencyKey: first.idempotencyKey,
          ledgerId: null,
          contactId: null,
          to: ["other@example.com"],
          cc: [],
          bcc: [],
          subject: "Different",
          bodyText: "Different",
        },
        "Asha",
      ),
    ).toThrow(/Idempotency key/);
    const updated = updateOutboundDraft(
      db,
      first.id,
      {
        expectedRevision: first.revision,
        ledgerId: null,
        contactId: null,
        to: first.to,
        cc: [],
        bcc: [],
        subject: "Updated statement",
        bodyText: first.bodyText,
      },
      "Asha",
    );
    expect(updated.revision).toBe(2);
    expect(() => reviewOutboundMessage(db, first.id, 1, "Reviewer")).toThrow(
      /changed elsewhere/,
    );
    expect(reviewOutboundMessage(db, first.id, 2, "Reviewer")).toMatchObject({
      status: "reviewed",
      reviewedBy: "Reviewer",
    });
  });

  it("records only SMTP acceptance, with append-only event history", async () => {
    const db = seededDb();
    const smtp = profile(db);
    const reviewed = reviewOutboundMessage(db, draft(db).id, 1, "Reviewer");
    queueOutboundMessage(db, reviewed.id, smtp.id, "Reviewer");
    const transport: SmtpTransport = {
      test: vi.fn(async () => "ready"),
      send: vi.fn(async (_profile, eml, recipients) => {
        expect(eml).not.toContain("Bcc:");
        expect(recipients).toEqual(["customer@example.com"]);
        return {
          accepted: true as const,
          serverResponse: "2.0.0 queued as Q123",
          serverMessageId: "Q123",
        };
      }),
    };
    const result = await deliverOutboundMessage(
      db,
      reviewed.id,
      "Reviewer",
      transport,
    );
    expect(result).toMatchObject({
      status: "accepted_by_smtp",
      attempts: 1,
      lastError: null,
    });
    const events = listMessageEvents(db, reviewed.id);
    expect(events.map((event) => event.eventType)).toEqual([
      "created",
      "reviewed",
      "queued",
      "delivery_started",
      "accepted_by_smtp",
    ]);
    expect(events.at(-1)?.detail.meaning).toMatch(
      /recipient delivery is not confirmed/,
    );
    expect(() =>
      db.prepare("UPDATE outbound_message_events SET actor='tampered'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM outbound_message_events").run(),
    ).toThrow(/append-only/);
  });

  it("makes a failed submission retryable without duplicating an accepted message", async () => {
    const db = seededDb();
    const smtp = profile(db);
    const reviewed = reviewOutboundMessage(db, draft(db).id, 1, "Reviewer");
    queueOutboundMessage(db, reviewed.id, smtp.id, "Reviewer");
    const failedTransport: SmtpTransport = {
      test: async () => "unused",
      send: async () => {
        throw new Error("temporary SMTP failure");
      },
    };
    expect(
      await deliverOutboundMessage(
        db,
        reviewed.id,
        "Reviewer",
        failedTransport,
      ),
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "temporary SMTP failure",
    });
    queueOutboundMessage(db, reviewed.id, smtp.id, "Reviewer");
    const acceptedTransport: SmtpTransport = {
      test: async () => "unused",
      send: async () => ({
        accepted: true as const,
        serverResponse: "queued",
        serverMessageId: null,
      }),
    };
    const accepted = await deliverOutboundMessage(
      db,
      reviewed.id,
      "Reviewer",
      acceptedTransport,
    );
    expect(accepted).toMatchObject({ status: "accepted_by_smtp", attempts: 2 });
    expect(
      await deliverOutboundMessage(
        db,
        reviewed.id,
        "Reviewer",
        acceptedTransport,
      ),
    ).toEqual(accepted);
  });

  it("quarantines an uncertain SMTP acceptance instead of offering an unsafe retry", async () => {
    const db = seededDb();
    const smtp = profile(db);
    const reviewed = reviewOutboundMessage(db, draft(db).id, 1, "Reviewer");
    queueOutboundMessage(db, reviewed.id, smtp.id, "Reviewer");
    const uncertainTransport: SmtpTransport = {
      test: async () => "unused",
      send: async () => {
        throw new SmtpAcceptanceUnknownError("connection closed after DATA");
      },
    };
    const result = await deliverOutboundMessage(
      db,
      reviewed.id,
      "Reviewer",
      uncertainTransport,
    );
    expect(result).toMatchObject({ status: "acceptance_unknown", attempts: 1 });
    expect(result.lastError).toMatch(/after DATA/);
    expect(() =>
      queueOutboundMessage(db, reviewed.id, smtp.id, "Reviewer"),
    ).toThrow(/Review the message/);
    expect(listMessageEvents(db, reviewed.id).at(-1)).toMatchObject({
      eventType: "acceptance_unknown",
      detail: { meaning: expect.stringMatching(/could duplicate/) },
    });
    const resolved = resolveUnknownAcceptance(
      db,
      reviewed.id,
      {
        decision: "confirmed_accepted",
        note: "Confirmed in the provider activity log",
      },
      "Owner",
    );
    expect(resolved).toMatchObject({
      status: "accepted_by_smtp",
      acceptedAt: expect.any(String),
    });
  });

  it("exports a reviewed RFC 5322 message as an exclusive local fallback", () => {
    const db = seededDb();
    const reviewed = reviewOutboundMessage(db, draft(db).id, 1, "Reviewer");
    const folder = mkdtempSync(join(tmpdir(), "total-eml-test-"));
    const path = join(folder, "statement.eml");
    try {
      const result = exportMessageEml(db, reviewed.id, path, "Reviewer");
      expect(result.message.status).toBe("exported");
      const eml = readFileSync(path, "utf8");
      expect(eml).toContain("MIME-Version: 1.0\r\n");
      expect(eml).toContain("To: <customer@example.com>");
      expect(buildEml(reviewed)).not.toContain("Bcc:");
      expect(() =>
        exportMessageEml(db, reviewed.id, path, "Reviewer"),
      ).toThrow();
      expect(getOutboundMessage(db, reviewed.id).status).toBe("exported");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
