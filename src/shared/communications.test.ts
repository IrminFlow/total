import { describe, expect, it } from "vitest";
import {
  communicationEmailSchema,
  communicationBatchCreateSchema,
  communicationBatchQueueSchema,
  outboundDraftInputSchema,
  partyContactInputSchema,
  smtpProfileInputSchema,
} from "./communications";

describe("communication boundary schemas", () => {
  it("normalizes email addresses and rejects header injection", () => {
    expect(communicationEmailSchema.parse("  BOOKS@Example.COM ")).toBe(
      "books@example.com",
    );
    expect(() =>
      communicationEmailSchema.parse("a@example.com\r\nBcc:x@example.com"),
    ).toThrow();
  });

  it("requires a reachable contact and secure SMTP mode", () => {
    expect(() =>
      partyContactInputSchema.parse({ ledgerId: 1, name: "Asha" }),
    ).toThrow(/email|phone/i);
    expect(() =>
      smtpProfileInputSchema.parse({
        name: "Office",
        host: "smtp.example.com",
        port: 25,
        security: "plain",
        username: "a",
        password: "b",
        fromEmail: "a@example.com",
      }),
    ).toThrow();
    expect(() =>
      smtpProfileInputSchema.parse({
        name: "Office",
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        username: "a",
        password: "b",
        fromEmail: "a@example.com",
        fromName: "Accounts\r\nBcc: thief@example.com",
      }),
    ).toThrow(/control characters/);
  });

  it("bounds the total recipient surface", () => {
    const addresses = Array.from(
      { length: 51 },
      (_, index) => `person${index}@example.com`,
    );
    expect(() =>
      outboundDraftInputSchema.parse({
        idempotencyKey: "invoice-2026-0001",
        to: addresses.slice(0, 50),
        cc: [addresses[50]],
        subject: "Statement",
        bodyText: "Attached separately",
      }),
    ).toThrow(/50 unique recipients/);
  });
});

describe("communication batch boundaries", () => {
  const item = (messageId: string) => ({
    messageId,
    documentKind: "invoice" as const,
    documentLabel: "Invoice INV-42",
    amountPaise: 125_050,
    exclusionReason: null,
  });

  it("keeps batch selection and paise totals bounded", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    expect(
      communicationBatchCreateSchema.parse({
        name: "August run",
        items: [item(first)],
      }),
    ).toMatchObject({ items: [{ amountPaise: 125_050 }] });
    expect(() =>
      communicationBatchCreateSchema.parse({
        name: "Duplicates",
        items: [item(first), item(first)],
      }),
    ).toThrow();
    expect(() =>
      communicationBatchCreateSchema.parse({
        name: "Invalid paise",
        items: [{ ...item(first), amountPaise: 12.5 }],
      }),
    ).toThrow();
  });

  it("limits one enqueue action to 25 exact rows", () => {
    expect(() =>
      communicationBatchQueueSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        smtpProfileId: 1,
        itemIds: Array.from({ length: 26 }, (_, index) => index + 1),
      }),
    ).toThrow();
  });
});
