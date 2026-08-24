import { describe, expect, it } from "vitest";
import {
  communicationEmailSchema,
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
