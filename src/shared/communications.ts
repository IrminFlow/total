import { z } from "zod";

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n\0]/.test(value), "Must be a single line");

export const communicationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320)
  .refine((value) => !/[\r\n\0]/.test(value), "Invalid email address");

export const partyContactInputSchema = z
  .object({
    ledgerId: z.number().int().positive(),
    name: singleLine(160),
    role: z.string().trim().max(120).default(""),
    email: communicationEmailSchema.nullable().default(null),
    phone: z
      .string()
      .trim()
      .min(5)
      .max(32)
      .regex(/^\+?[0-9() .-]+$/)
      .nullable()
      .default(null),
    isPrimary: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.email !== null || value.phone !== null, {
    message: "Add an email address or phone number",
  });

export type PartyContactInput = z.infer<typeof partyContactInputSchema>;

export interface PartyContact extends PartyContactInput {
  id: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const smtpSecuritySchema = z.enum(["tls", "starttls"]);
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;

export const smtpProfileInputSchema = z
  .object({
    name: singleLine(120),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535),
    security: smtpSecuritySchema,
    username: singleLine(320),
    password: z.string().min(1).max(1024),
    fromEmail: communicationEmailSchema,
    fromName: z.string().trim().max(160).default(""),
    replyTo: communicationEmailSchema.nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict();

export const smtpProfileUpdateSchema = smtpProfileInputSchema
  .omit({ password: true })
  .extend({ password: z.string().min(1).max(1024).optional() })
  .strict();

export type SmtpProfileInput = z.infer<typeof smtpProfileInputSchema>;
export type SmtpProfileUpdate = z.infer<typeof smtpProfileUpdateSchema>;

export interface SmtpProfileSummary {
  id: number;
  name: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  active: boolean;
  hasPassword: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const recipientListSchema = z.array(communicationEmailSchema).max(50);

const outboundDraftFields = {
  idempotencyKey: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  ledgerId: z.number().int().positive().nullable().default(null),
  contactId: z.number().int().positive().nullable().default(null),
  to: recipientListSchema.min(1),
  cc: recipientListSchema.default([]),
  bcc: recipientListSchema.default([]),
  subject: singleLine(400),
  bodyText: z.string().min(1).max(2_000_000),
};

const recipientLimit = (value: { to: string[]; cc: string[]; bcc: string[] }) =>
  new Set([...value.to, ...value.cc, ...value.bcc]).size <= 50;

export const outboundDraftInputSchema = z
  .object(outboundDraftFields)
  .strict()
  .refine(recipientLimit, "A message can have at most 50 unique recipients");

export const outboundDraftUpdateSchema = z
  .object({
    ledgerId: outboundDraftFields.ledgerId,
    contactId: outboundDraftFields.contactId,
    to: outboundDraftFields.to,
    cc: outboundDraftFields.cc,
    bcc: outboundDraftFields.bcc,
    subject: outboundDraftFields.subject,
    bodyText: outboundDraftFields.bodyText,
  })
  .extend({ expectedRevision: z.number().int().positive() })
  .strict()
  .refine(recipientLimit, "A message can have at most 50 unique recipients");

export type OutboundDraftInput = z.infer<typeof outboundDraftInputSchema>;
export type OutboundDraftUpdate = z.infer<typeof outboundDraftUpdateSchema>;

export const outboundMessageStatusSchema = z.enum([
  "draft",
  "reviewed",
  "queued",
  "sending",
  "accepted_by_smtp",
  "acceptance_unknown",
  "failed",
  "cancelled",
  "exported",
]);
export type OutboundMessageStatus = z.infer<typeof outboundMessageStatusSchema>;

export const acceptanceResolutionSchema = z
  .object({
    decision: z.enum(["confirmed_accepted", "retry_with_duplicate_risk"]),
    note: z.string().trim().min(3).max(500),
  })
  .strict();
export type AcceptanceResolution = z.infer<typeof acceptanceResolutionSchema>;

export const outboundMessageEventTypeSchema = z.enum([
  "created",
  "edited",
  "reviewed",
  "queued",
  "delivery_started",
  "accepted_by_smtp",
  "acceptance_unknown",
  "failed",
  "cancelled",
  "eml_exported",
]);
export type OutboundMessageEventType = z.infer<
  typeof outboundMessageEventTypeSchema
>;

export interface OutboundMessage {
  id: string;
  idempotencyKey: string;
  ledgerId: number | null;
  contactId: number | null;
  channel: "email";
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  contentSha256: string;
  sender: {
    fromEmail: string;
    fromName: string;
    replyTo: string | null;
  } | null;
  revision: number;
  status: OutboundMessageStatus;
  smtpProfileId: number | null;
  attempts: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  queuedAt: string | null;
  acceptedAt: string | null;
  exportedAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundMessageEvent {
  id: number;
  messageId: string;
  eventType: OutboundMessageEventType;
  detail: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export interface SmtpAcceptance {
  accepted: true;
  /** Final SMTP response after DATA. This proves only that the configured server accepted it. */
  serverResponse: string;
  serverMessageId: string | null;
}
