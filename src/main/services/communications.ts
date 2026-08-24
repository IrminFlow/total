import { createHash, randomUUID } from "crypto";
import { hostname } from "os";
import { extname, resolve } from "path";
import { writeFileSync } from "fs";
import net from "net";
import tls from "tls";
import { safeStorage } from "electron";
import type { DB } from "../db/connection";
import {
  communicationDisplayNameSchema,
  communicationEmailSchema,
  outboundDraftInputSchema,
  outboundDraftUpdateSchema,
  partyContactInputSchema,
  smtpProfileInputSchema,
  smtpProfileUpdateSchema,
  smtpSecuritySchema,
  type OutboundDraftInput,
  type OutboundDraftUpdate,
  type OutboundMessage,
  type OutboundMessageEvent,
  type OutboundMessageEventType,
  type OutboundMessageStatus,
  type AcceptanceResolution,
  type PartyContact,
  type PartyContactInput,
  type SmtpAcceptance,
  type SmtpProfileInput,
  type SmtpProfileSummary,
  type SmtpProfileUpdate,
} from "@shared/communications";
import { writeAudit } from "./audit";

const SMTP_TIMEOUT_MS = 20_000;
const SMTP_SESSION_DEADLINE_MS = 120_000;
const DELIVERY_LEASE_MS = 5 * 60_000;
const MAX_STORED_DIAGNOSTIC = 2_000;
const MAX_SMTP_LINE_BYTES = 8 * 1024;
const MAX_SMTP_REPLY_BYTES = 64 * 1024;
const MAX_SMTP_REPLY_LINES = 200;

const activeDeliveries = new WeakMap<DB, Set<string>>();

export interface SmtpTransportProfile extends SmtpProfileSummary {
  password: string;
}

export interface NetworkSmtpTransportOptions {
  /** Additional trust anchor for deterministic tests or a private company CA. */
  ca?: string | Buffer;
  connectionTimeoutMs?: number;
  sessionDeadlineMs?: number;
}

export interface SmtpTransport {
  send(
    profile: SmtpTransportProfile,
    eml: string,
    recipients: string[],
    signal?: AbortSignal,
  ): Promise<SmtpAcceptance>;
  test(profile: SmtpTransportProfile, signal?: AbortSignal): Promise<string>;
}

/** The DATA body was submitted but the server's final acceptance response was not received. */
export class SmtpAcceptanceUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpAcceptanceUnknownError";
  }
}

function cleanActor(actor: string): string {
  const value = actor.trim();
  if (!value || value.length > 160 || /[\r\n\0]/.test(value))
    throw new Error("A valid actor is required");
  return value;
}

function safeDiagnostic(value: unknown): string {
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�")
    .slice(0, MAX_STORED_DIAGNOSTIC);
}

function jsonArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  )
    throw new Error("Stored message recipients are invalid");
  return parsed;
}

function publicContact(row: Record<string, unknown>): PartyContact {
  return {
    id: Number(row.id),
    ledgerId: Number(row.ledgerId),
    name: String(row.name),
    role: String(row.role),
    email: row.email == null ? null : String(row.email),
    phone: row.phone == null ? null : String(row.phone),
    isPrimary: !!row.isPrimary,
    active: !!row.active,
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function contactById(db: DB, id: number): PartyContact | null {
  const row = db
    .prepare(
      `SELECT id,ledger_id AS ledgerId,name,role,email,phone,is_primary AS isPrimary,
              active,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt
       FROM party_contacts WHERE id=?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? publicContact(row) : null;
}

export function listPartyContacts(
  db: DB,
  ledgerId: number,
  includeInactive = false,
): PartyContact[] {
  return (
    db
      .prepare(
        `SELECT id,ledger_id AS ledgerId,name,role,email,phone,is_primary AS isPrimary,
                active,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt
         FROM party_contacts WHERE ledger_id=? ${includeInactive ? "" : "AND active=1"}
         ORDER BY is_primary DESC,active DESC,name COLLATE NOCASE,id`,
      )
      .all(ledgerId) as Record<string, unknown>[]
  ).map(publicContact);
}

export function savePartyContact(
  db: DB,
  input: PartyContactInput,
  actorInput: string,
  id?: number,
): PartyContact {
  const data = partyContactInputSchema.parse(input);
  const actor = cleanActor(actorInput);
  const before = id ? contactById(db, id) : null;
  if (id && !before) throw new Error("Contact not found");
  if (before && before.ledgerId !== data.ledgerId) {
    const referenced = db
      .prepare("SELECT 1 FROM outbound_messages WHERE contact_id=? LIMIT 1")
      .get(id);
    if (referenced)
      throw new Error(
        "This contact is referenced by message history and cannot move to another ledger",
      );
  }
  const savedId = db.transaction(() => {
    if (data.isPrimary && data.active) {
      db.prepare(
        "UPDATE party_contacts SET is_primary=0,updated_at=? WHERE ledger_id=? AND is_primary=1 AND id<>?",
      ).run(new Date().toISOString(), data.ledgerId, id ?? -1);
    }
    if (id) {
      db.prepare(
        `UPDATE party_contacts SET ledger_id=?,name=?,role=?,email=?,phone=?,is_primary=?,active=?,
           updated_at=? WHERE id=?`,
      ).run(
        data.ledgerId,
        data.name,
        data.role,
        data.email,
        data.phone,
        data.isPrimary ? 1 : 0,
        data.active ? 1 : 0,
        new Date().toISOString(),
        id,
      );
      return id;
    }
    return Number(
      db
        .prepare(
          `INSERT INTO party_contacts
           (ledger_id,name,role,email,phone,is_primary,active,created_by,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          data.ledgerId,
          data.name,
          data.role,
          data.email,
          data.phone,
          data.isPrimary ? 1 : 0,
          data.active ? 1 : 0,
          actor,
          new Date().toISOString(),
        ).lastInsertRowid,
    );
  })();
  const after = contactById(db, savedId)!;
  writeAudit(
    db,
    "party_contact",
    savedId,
    before ? "update" : "create",
    before,
    after,
  );
  return after;
}

export function deletePartyContact(db: DB, id: number): void {
  const before = contactById(db, id);
  if (!before) throw new Error("Contact not found");
  db.prepare("DELETE FROM party_contacts WHERE id=?").run(id);
  writeAudit(db, "party_contact", id, "delete", before, null);
}

function encryptPassword(password: string): string {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      "Secure credential storage is unavailable on this computer",
    );
  return safeStorage.encryptString(password).toString("base64");
}

function decryptPassword(value: string): string {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      "Secure credential storage is unavailable on this computer",
    );
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    throw new Error(
      "This SMTP password cannot be opened on this computer; enter it again",
    );
  }
}

function publicProfile(row: Record<string, unknown>): SmtpProfileSummary {
  return {
    id: Number(row.id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port),
    security: smtpSecuritySchema.parse(row.security),
    username: String(row.username),
    fromEmail: String(row.fromEmail),
    fromName: String(row.fromName),
    replyTo: row.replyTo == null ? null : String(row.replyTo),
    active: !!row.active,
    hasPassword: !!row.encryptedPassword,
    lastTestedAt: row.lastTestedAt == null ? null : String(row.lastTestedAt),
    lastError: row.lastError == null ? null : String(row.lastError),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const PROFILE_SELECT = `SELECT id,name,host,port,security,username,
  encrypted_password AS encryptedPassword,from_email AS fromEmail,from_name AS fromName,
  reply_to AS replyTo,active,last_tested_at AS lastTestedAt,last_error AS lastError,
  created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM smtp_profiles`;

function profileRow(db: DB, id: number): Record<string, unknown> | null {
  return (
    (db.prepare(`${PROFILE_SELECT} WHERE id=?`).get(id) as
      Record<string, unknown> | undefined) ?? null
  );
}

function secretProfile(
  db: DB,
  id: number,
  requireActive = true,
): SmtpTransportProfile {
  const row = profileRow(db, id);
  if (!row) throw new Error("SMTP profile not found");
  const summary = publicProfile(row);
  if (requireActive && !summary.active)
    throw new Error("SMTP profile is inactive");
  return {
    ...summary,
    password: decryptPassword(String(row.encryptedPassword)),
  };
}

export function listSmtpProfiles(db: DB): SmtpProfileSummary[] {
  return (
    db
      .prepare(`${PROFILE_SELECT} ORDER BY active DESC,name COLLATE NOCASE,id`)
      .all() as Record<string, unknown>[]
  ).map(publicProfile);
}

export function createSmtpProfile(
  db: DB,
  input: SmtpProfileInput,
  actorInput: string,
): SmtpProfileSummary {
  const data = smtpProfileInputSchema.parse(input);
  const actor = cleanActor(actorInput);
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO smtp_profiles
       (name,host,port,security,username,encrypted_password,from_email,from_name,reply_to,active,created_by,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        data.name,
        data.host,
        data.port,
        data.security,
        data.username,
        encryptPassword(data.password),
        data.fromEmail,
        data.fromName,
        data.replyTo,
        data.active ? 1 : 0,
        actor,
        now,
      ).lastInsertRowid,
  );
  const after = publicProfile(profileRow(db, id)!);
  writeAudit(db, "smtp_profile", id, "create", null, after);
  return after;
}

export function updateSmtpProfile(
  db: DB,
  id: number,
  input: SmtpProfileUpdate,
): SmtpProfileSummary {
  const data = smtpProfileUpdateSchema.parse(input);
  const row = profileRow(db, id);
  if (!row) throw new Error("SMTP profile not found");
  const before = publicProfile(row);
  const encryptedPassword = data.password
    ? encryptPassword(data.password)
    : String(row.encryptedPassword);
  db.prepare(
    `UPDATE smtp_profiles SET name=?,host=?,port=?,security=?,username=?,encrypted_password=?,
       from_email=?,from_name=?,reply_to=?,active=?,last_error=NULL,updated_at=? WHERE id=?`,
  ).run(
    data.name,
    data.host,
    data.port,
    data.security,
    data.username,
    encryptedPassword,
    data.fromEmail,
    data.fromName,
    data.replyTo,
    data.active ? 1 : 0,
    new Date().toISOString(),
    id,
  );
  const after = publicProfile(profileRow(db, id)!);
  writeAudit(db, "smtp_profile", id, "update", before, after);
  return after;
}

export function deleteSmtpProfile(db: DB, id: number): void {
  const row = profileRow(db, id);
  if (!row) throw new Error("SMTP profile not found");
  const before = publicProfile(row);
  const used = db
    .prepare("SELECT 1 FROM outbound_messages WHERE smtp_profile_id=? LIMIT 1")
    .get(id);
  if (used)
    throw new Error(
      "Deactivate this SMTP profile because message history refers to it",
    );
  db.prepare("DELETE FROM smtp_profiles WHERE id=?").run(id);
  writeAudit(db, "smtp_profile", id, "delete", before, null);
}

function normalizeRecipients(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))];
}

function normalizedDraft(input: OutboundDraftInput | OutboundDraftUpdate) {
  const to = normalizeRecipients(input.to);
  const toSet = new Set(to);
  const cc = normalizeRecipients(input.cc).filter((email) => !toSet.has(email));
  const visible = new Set([...to, ...cc]);
  return {
    ledgerId: input.ledgerId,
    contactId: input.contactId,
    to,
    cc,
    bcc: normalizeRecipients(input.bcc).filter((email) => !visible.has(email)),
    subject: input.subject,
    bodyText: input.bodyText.replace(/\r\n?/g, "\n"),
  };
}

function contentHash(input: ReturnType<typeof normalizedDraft>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function assertContactLedger(
  db: DB,
  contactId: number | null,
  ledgerId: number | null,
): number | null {
  if (contactId === null) return ledgerId;
  const contact = contactById(db, contactId);
  if (!contact || !contact.active) throw new Error("Active contact not found");
  if (ledgerId !== null && ledgerId !== contact.ledgerId)
    throw new Error("Contact does not belong to the selected ledger");
  return contact.ledgerId;
}

function publicMessage(row: Record<string, unknown>): OutboundMessage {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotencyKey),
    ledgerId: row.ledgerId == null ? null : Number(row.ledgerId),
    contactId: row.contactId == null ? null : Number(row.contactId),
    channel: "email",
    to: jsonArray(row.toJson),
    cc: jsonArray(row.ccJson),
    bcc: jsonArray(row.bccJson),
    subject: String(row.subject),
    bodyText: String(row.bodyText),
    contentSha256: String(row.contentSha256),
    sender:
      row.senderJson == null
        ? null
        : (JSON.parse(String(row.senderJson)) as OutboundMessage["sender"]),
    revision: Number(row.revision),
    status: row.status as OutboundMessageStatus,
    smtpProfileId: row.smtpProfileId == null ? null : Number(row.smtpProfileId),
    attempts: Number(row.attempts),
    reviewedBy: row.reviewedBy == null ? null : String(row.reviewedBy),
    reviewedAt: row.reviewedAt == null ? null : String(row.reviewedAt),
    queuedAt: row.queuedAt == null ? null : String(row.queuedAt),
    acceptedAt: row.acceptedAt == null ? null : String(row.acceptedAt),
    exportedAt: row.exportedAt == null ? null : String(row.exportedAt),
    lastError: row.lastError == null ? null : String(row.lastError),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const MESSAGE_SELECT = `SELECT id,idempotency_key AS idempotencyKey,ledger_id AS ledgerId,
  contact_id AS contactId,to_json AS toJson,cc_json AS ccJson,bcc_json AS bccJson,subject,
  body_text AS bodyText,content_sha256 AS contentSha256,revision,status,
  sender_json AS senderJson,
  smtp_profile_id AS smtpProfileId,attempts,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt,
  queued_at AS queuedAt,accepted_at AS acceptedAt,exported_at AS exportedAt,last_error AS lastError,
  created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM outbound_messages`;

export function getOutboundMessage(db: DB, id: string): OutboundMessage {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE id=?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error("Message not found");
  return publicMessage(row);
}

function appendEvent(
  db: DB,
  messageId: string,
  eventType: OutboundMessageEventType,
  actor: string,
  detail: Record<string, unknown> = {},
): void {
  db.prepare(
    "INSERT INTO outbound_message_events(message_id,event_type,detail_json,actor) VALUES(?,?,?,?)",
  ).run(messageId, eventType, JSON.stringify(detail), cleanActor(actor));
}

export function listMessageEvents(
  db: DB,
  messageId: string,
): OutboundMessageEvent[] {
  getOutboundMessage(db, messageId);
  return (
    db
      .prepare(
        `SELECT id,message_id AS messageId,event_type AS eventType,detail_json AS detailJson,
              actor,created_at AS createdAt FROM outbound_message_events WHERE message_id=? ORDER BY id`,
      )
      .all(messageId) as Record<string, unknown>[]
  ).map((row) => ({
    id: Number(row.id),
    messageId: String(row.messageId),
    eventType: row.eventType as OutboundMessageEventType,
    detail: JSON.parse(String(row.detailJson)) as Record<string, unknown>,
    actor: String(row.actor),
    createdAt: String(row.createdAt),
  }));
}

export function createOutboundDraft(
  db: DB,
  input: OutboundDraftInput,
  actorInput: string,
): OutboundMessage {
  const parsed = outboundDraftInputSchema.parse(input);
  const actor = cleanActor(actorInput);
  const draft = normalizedDraft(parsed);
  draft.ledgerId = assertContactLedger(db, draft.contactId, draft.ledgerId);
  const hash = contentHash(draft);
  const existing = db
    .prepare(`${MESSAGE_SELECT} WHERE idempotency_key=?`)
    .get(parsed.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) {
    const message = publicMessage(existing);
    if (message.contentSha256 !== hash)
      throw new Error(
        "Idempotency key is already associated with different message content",
      );
    return message;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO outbound_messages
       (id,idempotency_key,ledger_id,contact_id,to_json,cc_json,bcc_json,subject,body_text,
        content_sha256,created_by,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      parsed.idempotencyKey,
      draft.ledgerId,
      draft.contactId,
      JSON.stringify(draft.to),
      JSON.stringify(draft.cc),
      JSON.stringify(draft.bcc),
      draft.subject,
      draft.bodyText,
      hash,
      actor,
      now,
    );
    appendEvent(db, id, "created", actor, { contentSha256: hash });
  })();
  const message = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "create", null, message);
  return message;
}

export function updateOutboundDraft(
  db: DB,
  id: string,
  input: OutboundDraftUpdate,
  actorInput: string,
): OutboundMessage {
  const parsed = outboundDraftUpdateSchema.parse(input);
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status !== "draft")
    throw new Error("Only an unreviewed draft can be edited");
  const draft = normalizedDraft(parsed);
  draft.ledgerId = assertContactLedger(db, draft.contactId, draft.ledgerId);
  const hash = contentHash(draft);
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE outbound_messages SET ledger_id=?,contact_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,
       body_text=?,content_sha256=?,revision=revision+1,updated_at=?
       WHERE id=? AND status='draft' AND revision=?`,
      )
      .run(
        draft.ledgerId,
        draft.contactId,
        JSON.stringify(draft.to),
        JSON.stringify(draft.cc),
        JSON.stringify(draft.bcc),
        draft.subject,
        draft.bodyText,
        hash,
        now,
        id,
        parsed.expectedRevision,
      );
    if (result.changes !== 1)
      throw new Error("Draft changed elsewhere; reload it before editing");
    appendEvent(db, id, "edited", actor, {
      fromRevision: parsed.expectedRevision,
      contentSha256: hash,
    });
  })();
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}

export function reviewOutboundMessage(
  db: DB,
  id: string,
  expectedRevision: number,
  actorInput: string,
): OutboundMessage {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status === "reviewed" && before.revision === expectedRevision)
    return before;
  if (before.status !== "draft")
    throw new Error("Only a draft can be reviewed");
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE outbound_messages SET status='reviewed',reviewed_by=?,reviewed_at=?,last_error=NULL,
       updated_at=? WHERE id=? AND status='draft' AND revision=?`,
      )
      .run(actor, now, now, id, expectedRevision);
    if (result.changes !== 1)
      throw new Error("Draft changed elsewhere; review the latest revision");
    appendEvent(db, id, "reviewed", actor, {
      revision: expectedRevision,
      contentSha256: before.contentSha256,
    });
  })();
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}

export function queueOutboundMessage(
  db: DB,
  id: string,
  smtpProfileId: number,
  actorInput: string,
): OutboundMessage {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status === "queued" && before.smtpProfileId === smtpProfileId)
    return before;
  if (
    !(["reviewed", "failed"] as OutboundMessageStatus[]).includes(before.status)
  )
    throw new Error("Review the message before queueing it");
  const profile = secretProfile(db, smtpProfileId);
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE outbound_messages SET status='queued',smtp_profile_id=?,sender_json=?,queued_at=?,last_error=NULL,
         delivery_attempt_id=NULL,delivery_lease_expires_at=NULL,
       updated_at=? WHERE id=? AND status IN ('reviewed','failed')`,
      )
      .run(
        smtpProfileId,
        JSON.stringify({
          fromEmail: profile.fromEmail,
          fromName: profile.fromName,
          replyTo: profile.replyTo,
        }),
        now,
        now,
        id,
      );
    if (result.changes !== 1)
      throw new Error("Message state changed; reload it before queueing");
    appendEvent(db, id, "queued", actor, {
      smtpProfileId,
      sender: {
        fromEmail: profile.fromEmail,
        fromName: profile.fromName,
        replyTo: profile.replyTo,
      },
      retry: before.status === "failed",
    });
  })();
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}

export function cancelOutboundMessage(
  db: DB,
  id: string,
  actorInput: string,
): OutboundMessage {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status === "cancelled") return before;
  if (
    !(
      ["draft", "reviewed", "queued", "failed"] as OutboundMessageStatus[]
    ).includes(before.status)
  )
    throw new Error("This message can no longer be cancelled");
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE outbound_messages SET status='cancelled',updated_at=?
       WHERE id=? AND status IN ('draft','reviewed','queued','failed')`,
      )
      .run(now, id);
    if (result.changes !== 1)
      throw new Error("Message state changed; reload it before cancelling");
    appendEvent(db, id, "cancelled", actor);
  })();
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}

export function resolveUnknownAcceptance(
  db: DB,
  id: string,
  resolution: AcceptanceResolution,
  actorInput: string,
): OutboundMessage {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status !== "acceptance_unknown")
    throw new Error("This message does not have an unresolved SMTP acceptance");
  if (resolution.decision === "retry_with_duplicate_risk") {
    if (before.smtpProfileId === null)
      throw new Error("The original SMTP profile is no longer available");
    secretProfile(db, before.smtpProfileId);
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    const status =
      resolution.decision === "confirmed_accepted"
        ? "accepted_by_smtp"
        : "queued";
    const result = db
      .prepare(
        `UPDATE outbound_messages SET status=?,accepted_at=?,queued_at=?,last_error=NULL,
         delivery_attempt_id=NULL,delivery_lease_expires_at=NULL,updated_at=?
         WHERE id=? AND status='acceptance_unknown'`,
      )
      .run(
        status,
        status === "accepted_by_smtp" ? now : null,
        status === "queued" ? now : before.queuedAt,
        now,
        id,
      );
    if (result.changes !== 1)
      throw new Error("Message state changed; reload it before resolving");
    if (status === "accepted_by_smtp") {
      appendEvent(db, id, "accepted_by_smtp", actor, {
        externallyVerified: true,
        note: resolution.note,
        meaning:
          "A reviewer confirmed SMTP acceptance outside Total; recipient delivery is not confirmed",
      });
    } else {
      appendEvent(db, id, "queued", actor, {
        acceptanceRiskAcknowledged: true,
        note: resolution.note,
      });
    }
  })();
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}

export function recoverInterruptedDeliveries(db: DB, actor = "System"): number {
  const active = activeDeliveries.get(db);
  const stale = (
    db
      .prepare(
        `SELECT id,delivery_attempt_id AS attemptId FROM outbound_messages
       WHERE status='sending' AND delivery_lease_expires_at IS NOT NULL
         AND julianday(delivery_lease_expires_at) <= julianday('now')`,
      )
      .all() as { id: string; attemptId: string | null }[]
  ).filter((row) => !active?.has(row.id));
  if (!stale.length) return 0;
  let recovered = 0;
  db.transaction(() => {
    for (const row of stale) {
      const result = db
        .prepare(
          `UPDATE outbound_messages SET status='acceptance_unknown',delivery_attempt_id=NULL,
         delivery_lease_expires_at=NULL,
         last_error='Delivery was interrupted; SMTP acceptance is unknown',
         updated_at=? WHERE id=? AND status='sending' AND delivery_attempt_id IS ?`,
        )
        .run(new Date().toISOString(), row.id, row.attemptId);
      if (result.changes !== 1) continue;
      recovered += 1;
      appendEvent(db, row.id, "acceptance_unknown", actor, {
        interrupted: true,
        meaning:
          "Do not retry until you check the SMTP provider; a retry could duplicate the message",
      });
    }
  })();
  return recovered;
}

export function listOutboundMessages(
  db: DB,
  filter: {
    ledgerId?: number;
    status?: OutboundMessageStatus;
    limit?: number;
  } = {},
): OutboundMessage[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.ledgerId !== undefined) {
    where.push("ledger_id=?");
    params.push(filter.ledgerId);
  }
  if (filter.status !== undefined) {
    where.push("status=?");
    params.push(filter.status);
  }
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  params.push(limit);
  return (
    db
      .prepare(
        `${MESSAGE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC,id LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
  ).map(publicMessage);
}

function headerText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text))
    throw new Error(`Stored ${label} is not safe for an email header`);
  return text;
}

function headerWord(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (chunk && bytes + size > 42) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map(
      (part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

function mailbox(email: string, name = ""): string {
  const safeEmail = communicationEmailSchema.parse(email);
  const safeName = communicationDisplayNameSchema.parse(name);
  if (!safeName) return `<${safeEmail}>`;
  return /[^\x20-\x7e]/.test(safeName)
    ? `${headerWord(safeName)} <${safeEmail}>`
    : `"${safeName.replace(/["\\]/g, "")}" <${safeEmail}>`;
}

function addressHeader(name: string, addresses: string[]): string {
  return `${name}: ${addresses.map((email) => mailbox(email)).join(",\r\n ")}`;
}

function wrapBase64(value: string): string {
  return (
    Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

export function buildEml(
  message: OutboundMessage,
  profile?: Pick<SmtpProfileSummary, "fromEmail" | "fromName" | "replyTo">,
  includeBcc = false,
): string {
  const sender = profile ?? {
    fromEmail: "no-reply@total.local",
    fromName: "Total",
    replyTo: null,
  };
  const fromEmail = communicationEmailSchema.parse(sender.fromEmail);
  const fromName = communicationDisplayNameSchema.parse(sender.fromName);
  const replyTo = sender.replyTo
    ? communicationEmailSchema.parse(sender.replyTo)
    : null;
  const subject = headerText(message.subject, "message subject", 400);
  const to = message.to.map((email) => communicationEmailSchema.parse(email));
  const cc = message.cc.map((email) => communicationEmailSchema.parse(email));
  const bcc = message.bcc.map((email) => communicationEmailSchema.parse(email));
  const domain = fromEmail.split("@")[1] ?? "total.local";
  const headers = [
    `Date: ${new Date(message.createdAt).toUTCString()}`,
    `Message-ID: <${message.id}.${message.contentSha256.slice(0, 12)}@${domain}>`,
    `From: ${mailbox(fromEmail, fromName)}`,
    addressHeader("To", to),
    ...(cc.length ? [addressHeader("Cc", cc)] : []),
    ...(includeBcc && bcc.length ? [addressHeader("Bcc", bcc)] : []),
    ...(replyTo ? [`Reply-To: ${mailbox(replyTo)}`] : []),
    `Subject: ${headerWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrapBase64(message.bodyText)}\r\n`;
}

export function exportMessageEml(
  db: DB,
  id: string,
  destinationPath: string,
  actorInput: string,
  smtpProfileId?: number,
): { path: string; message: OutboundMessage } {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (
    !(["reviewed", "failed"] as OutboundMessageStatus[]).includes(before.status)
  )
    throw new Error("Review the message before exporting it");
  const path = resolve(destinationPath);
  if (extname(path).toLowerCase() !== ".eml")
    throw new Error("Export path must end in .eml");
  const selectedProfile =
    smtpProfileId === undefined ? null : profileRow(db, smtpProfileId);
  if (smtpProfileId !== undefined && !selectedProfile)
    throw new Error("SMTP profile not found");
  const profile = selectedProfile ? publicProfile(selectedProfile) : undefined;
  if (profile && !profile.active) throw new Error("SMTP profile is inactive");
  writeFileSync(path, buildEml(before, profile, true), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE outbound_messages SET status='exported',exported_at=?,updated_at=?
         WHERE id=? AND status IN ('reviewed','failed')`,
        )
        .run(now, now, id);
      if (result.changes !== 1)
        throw new Error("Message state changed during export");
      appendEvent(db, id, "eml_exported", actor, {
        fileName: path.split(/[\\/]/).at(-1),
      });
    })();
  } catch (error) {
    // The file is valid and intentionally left in place; report the partial state truthfully.
    throw new Error(
      `The .eml file was written, but its audit status could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "export", before, after);
  return { path, message: after };
}

class SmtpLineReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_SMTP_LINE_BYTES) {
        const error = new Error("SMTP server response line is too large");
        this.onError(error);
        this.socket.destroy(error);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else {
        if (this.lines.length >= MAX_SMTP_REPLY_LINES) {
          const error = new Error("SMTP server sent too many response lines");
          this.onError(error);
          this.socket.destroy(error);
          return;
        }
        this.lines.push(line);
      }
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_SMTP_LINE_BYTES) {
      const error = new Error("SMTP server response line is too large");
      this.onError(error);
      this.socket.destroy(error);
    }
  };
  private readonly onError = (error: Error) => {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  };

  constructor(private readonly socket: net.Socket | tls.TLSSocket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private readonly onClose = () =>
    this.onError(new Error("SMTP connection closed unexpectedly"));

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  nextLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    let responseBytes = 0;
    let code = 0;
    for (;;) {
      const line = await this.nextLine();
      if (!/^\d{3}[ -]/.test(line))
        throw new Error("SMTP server returned a malformed response");
      const current = Number(line.slice(0, 3));
      if (!code) code = current;
      if (current !== code)
        throw new Error("SMTP server returned an inconsistent response");
      const content = line.slice(4);
      responseBytes += Buffer.byteLength(content, "utf8");
      if (
        lines.length >= MAX_SMTP_REPLY_LINES ||
        responseBytes > MAX_SMTP_REPLY_BYTES
      )
        throw new Error("SMTP server response is too large");
      lines.push(content);
      if (line[3] === " ") return { code, text: lines.join("\n") };
    }
  }
}

function waitForConnect(
  socket: net.Socket,
  event: "connect" | "secureConnect",
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const done = () => {
      cleanup();
      resolvePromise();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off(event, done);
      socket.off("error", failed);
    };
    socket.once(event, done);
    socket.once("error", failed);
  });
}

function expectReply(
  reply: { code: number; text: string },
  allowed: number[],
  stage: string,
): void {
  if (!allowed.includes(reply.code))
    throw new Error(`${stage} failed (${reply.code}): ${reply.text}`);
}

async function command(
  socket: net.Socket | tls.TLSSocket,
  reader: SmtpLineReader,
  value: string,
) {
  await new Promise<void>((resolvePromise, reject) =>
    socket.write(`${value}\r\n`, (error) =>
      error ? reject(error) : resolvePromise(),
    ),
  );
  return reader.reply();
}

async function authenticate(
  socket: net.Socket | tls.TLSSocket,
  reader: SmtpLineReader,
  profile: SmtpTransportProfile,
  capabilities: string,
): Promise<void> {
  if (/\bAUTH\b[^\n]*\bPLAIN\b/i.test(capabilities)) {
    const token = Buffer.from(
      `\0${profile.username}\0${profile.password}`,
      "utf8",
    ).toString("base64");
    let reply = await command(socket, reader, `AUTH PLAIN ${token}`);
    if (reply.code === 334) reply = await command(socket, reader, token);
    expectReply(reply, [235], "SMTP authentication");
    return;
  }
  if (/\bAUTH\b[^\n]*\bLOGIN\b/i.test(capabilities)) {
    expectReply(
      await command(socket, reader, "AUTH LOGIN"),
      [334],
      "SMTP authentication",
    );
    expectReply(
      await command(
        socket,
        reader,
        Buffer.from(profile.username, "utf8").toString("base64"),
      ),
      [334],
      "SMTP username",
    );
    expectReply(
      await command(
        socket,
        reader,
        Buffer.from(profile.password, "utf8").toString("base64"),
      ),
      [235],
      "SMTP password",
    );
    return;
  }
  throw new Error("SMTP server does not advertise AUTH PLAIN or AUTH LOGIN");
}

async function smtpSession<T>(
  profile: SmtpTransportProfile,
  operation: (
    socket: net.Socket | tls.TLSSocket,
    reader: SmtpLineReader,
  ) => Promise<T>,
  signal?: AbortSignal,
  options: NetworkSmtpTransportOptions = {},
): Promise<T> {
  const security = smtpSecuritySchema.safeParse(profile.security);
  if (!security.success)
    throw new Error("SMTP transport requires implicit TLS or STARTTLS");
  let socket: net.Socket | tls.TLSSocket;
  let reader: SmtpLineReader;
  const tlsOptions = {
    servername: net.isIP(profile.host) ? undefined : profile.host,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2" as const,
    ca: options.ca,
    checkServerIdentity: (
      _hostname: string,
      certificate: tls.PeerCertificate,
    ) => tls.checkServerIdentity(profile.host, certificate),
  };
  const connectionTimeoutMs = options.connectionTimeoutMs ?? SMTP_TIMEOUT_MS;
  const sessionDeadlineMs =
    options.sessionDeadlineMs ?? SMTP_SESSION_DEADLINE_MS;
  if (profile.security === "tls") {
    const secure = tls.connect({
      host: profile.host,
      port: profile.port,
      ...tlsOptions,
    });
    secure.setTimeout(connectionTimeoutMs, () =>
      secure.destroy(new Error("SMTP connection timed out")),
    );
    socket = secure;
    reader = new SmtpLineReader(socket);
  } else {
    const plain = net.connect({ host: profile.host, port: profile.port });
    plain.setTimeout(connectionTimeoutMs, () =>
      plain.destroy(new Error("SMTP connection timed out")),
    );
    socket = plain;
    reader = new SmtpLineReader(socket);
  }
  const deadlineError = new Error("SMTP session deadline exceeded");
  const abort = () =>
    socket.destroy(
      signal?.reason instanceof Error ? signal.reason : deadlineError,
    );
  const deadline = setTimeout(
    () => socket.destroy(deadlineError),
    sessionDeadlineMs,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await waitForConnect(
      socket,
      profile.security === "tls" ? "secureConnect" : "connect",
    );
    expectReply(await reader.reply(), [220], "SMTP greeting");
    const clientName =
      hostname().replace(/[^A-Za-z0-9.-]/g, "-") || "localhost";
    let ehlo = await command(socket, reader, `EHLO ${clientName}`);
    expectReply(ehlo, [250], "SMTP EHLO");
    if (profile.security === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text))
        throw new Error("SMTP server does not offer STARTTLS");
      expectReply(
        await command(socket, reader, "STARTTLS"),
        [220],
        "SMTP STARTTLS",
      );
      reader.dispose();
      const secure = tls.connect({
        socket: socket as net.Socket,
        ...tlsOptions,
      });
      secure.setTimeout(connectionTimeoutMs, () =>
        secure.destroy(new Error("SMTP connection timed out")),
      );
      socket = secure;
      reader = new SmtpLineReader(socket);
      await waitForConnect(secure, "secureConnect");
      ehlo = await command(socket, reader, `EHLO ${clientName}`);
      expectReply(ehlo, [250], "SMTP EHLO after STARTTLS");
    }
    await authenticate(socket, reader, profile, ehlo.text);
    return await operation(socket, reader);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    try {
      await command(socket, reader, "QUIT");
    } catch {
      /* connection may already be closed */
    }
    reader.dispose();
    socket.destroy();
  }
}

export function createNetworkSmtpTransport(
  options: NetworkSmtpTransportOptions = {},
): SmtpTransport {
  return {
    async test(profile, signal) {
      return smtpSession(
        profile,
        async (socket, reader) => {
          const reply = await command(socket, reader, "NOOP");
          expectReply(reply, [250], "SMTP NOOP");
          return reply.text;
        },
        signal,
        options,
      );
    },
    async send(profile, eml, recipients, signal) {
      return smtpSession(
        profile,
        async (socket, reader) => {
          expectReply(
            await command(socket, reader, `MAIL FROM:<${profile.fromEmail}>`),
            [250],
            "SMTP sender",
          );
          for (const recipient of recipients)
            expectReply(
              await command(socket, reader, `RCPT TO:<${recipient}>`),
              [250, 251],
              `SMTP recipient ${recipient}`,
            );
          expectReply(
            await command(socket, reader, "DATA"),
            [354],
            "SMTP DATA",
          );
          const stuffed = eml
            .replace(/\r?\n/g, "\r\n")
            .replace(/(^|\r\n)\./g, "$1..")
            .replace(/\r\n$/, "");
          let reply: { code: number; text: string };
          try {
            reply = await command(socket, reader, `${stuffed}\r\n.`);
          } catch (error) {
            throw new SmtpAcceptanceUnknownError(
              `SMTP acceptance is unknown after DATA: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          expectReply(reply, [250], "SMTP message acceptance");
          const match = reply.text.match(
            /(?:queued as|id[= :]?)\s*<?([^\s<>]+)>?/i,
          );
          return {
            accepted: true,
            serverResponse: reply.text,
            serverMessageId: match?.[1] ?? null,
          };
        },
        signal,
        options,
      );
    },
  };
}

export const networkSmtpTransport: SmtpTransport = createNetworkSmtpTransport();

export async function testSmtpProfile(
  db: DB,
  id: number,
  transport: SmtpTransport = networkSmtpTransport,
): Promise<{ ok: true; serverResponse: string }> {
  const profile = secretProfile(db, id, false);
  try {
    const response = safeDiagnostic(await transport.test(profile));
    db.prepare(
      "UPDATE smtp_profiles SET last_tested_at=?,last_error=NULL,updated_at=? WHERE id=?",
    ).run(new Date().toISOString(), new Date().toISOString(), id);
    return { ok: true, serverResponse: response };
  } catch (error) {
    const message = safeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    db.prepare(
      "UPDATE smtp_profiles SET last_tested_at=?,last_error=?,updated_at=? WHERE id=?",
    ).run(new Date().toISOString(), message, new Date().toISOString(), id);
    throw new Error(message);
  }
}

export async function deliverOutboundMessage(
  db: DB,
  id: string,
  actorInput: string,
  transport: SmtpTransport = networkSmtpTransport,
): Promise<OutboundMessage> {
  const actor = cleanActor(actorInput);
  const before = getOutboundMessage(db, id);
  if (before.status === "accepted_by_smtp") return before;
  if (before.status !== "queued" || before.smtpProfileId === null)
    throw new Error(
      "Only a queued message with an SMTP profile can be submitted",
    );
  const profile = secretProfile(db, before.smtpProfileId);
  const deliveryProfile = before.sender
    ? { ...profile, ...before.sender }
    : profile;
  const now = new Date().toISOString();
  const attemptId = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + DELIVERY_LEASE_MS).toISOString();
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE outbound_messages SET status='sending',attempts=attempts+1,delivery_attempt_id=?,
         delivery_lease_expires_at=?,updated_at=?
       WHERE id=? AND status='queued'`,
      )
      .run(attemptId, leaseExpiresAt, now, id);
    if (result.changes !== 1)
      throw new Error("Message is already being processed");
    appendEvent(db, id, "delivery_started", actor, {
      attempt: before.attempts + 1,
      attemptId,
      leaseExpiresAt,
      smtpProfileId: profile.id,
    });
  })();
  const active = activeDeliveries.get(db) ?? new Set<string>();
  activeDeliveries.set(db, active);
  active.add(id);
  const abortController = new AbortController();
  const attemptDeadline = setTimeout(
    () =>
      abortController.abort(
        new Error("SMTP delivery attempt deadline exceeded"),
      ),
    SMTP_SESSION_DEADLINE_MS,
  );
  let serverAccepted = false;
  try {
    const eml = buildEml(getOutboundMessage(db, id), deliveryProfile, false);
    const recipients = normalizeRecipients([
      ...before.to,
      ...before.cc,
      ...before.bcc,
    ]);
    const acceptance = await transport.send(
      deliveryProfile,
      eml,
      recipients,
      abortController.signal,
    );
    serverAccepted = true;
    const acceptedAt = new Date().toISOString();
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE outbound_messages SET status='accepted_by_smtp',accepted_at=?,last_error=NULL,
           delivery_attempt_id=NULL,delivery_lease_expires_at=NULL,updated_at=?
           WHERE id=? AND status='sending' AND delivery_attempt_id=?`,
        )
        .run(acceptedAt, acceptedAt, id, attemptId);
      if (result.changes !== 1)
        throw new Error(
          "Message state changed before SMTP acceptance was recorded",
        );
      appendEvent(db, id, "accepted_by_smtp", actor, {
        serverResponse: safeDiagnostic(acceptance.serverResponse),
        serverMessageId:
          acceptance.serverMessageId === null
            ? null
            : safeDiagnostic(acceptance.serverMessageId),
        meaning:
          "The configured SMTP server accepted the message; recipient delivery is not confirmed",
      });
    })();
  } catch (error) {
    const message = safeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    const acceptanceUnknown =
      serverAccepted || error instanceof SmtpAcceptanceUnknownError;
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE outbound_messages SET status=?,last_error=?,delivery_attempt_id=NULL,
         delivery_lease_expires_at=NULL,updated_at=?
         WHERE id=? AND status='sending' AND delivery_attempt_id=?`,
        )
        .run(
          acceptanceUnknown ? "acceptance_unknown" : "failed",
          message,
          new Date().toISOString(),
          id,
          attemptId,
        );
      if (result.changes === 1)
        appendEvent(
          db,
          id,
          acceptanceUnknown ? "acceptance_unknown" : "failed",
          actor,
          {
            error: message,
            ...(acceptanceUnknown
              ? {
                  meaning:
                    "Do not retry until you check the SMTP provider; a retry could duplicate the message",
                }
              : {}),
          },
        );
    })();
  } finally {
    clearTimeout(attemptDeadline);
    active.delete(id);
  }
  const after = getOutboundMessage(db, id);
  writeAudit(db, "outbound_message", 0, "update", before, after);
  return after;
}
