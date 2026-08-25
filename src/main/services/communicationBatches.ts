import { randomUUID } from "crypto";
import {
  communicationBatchCreateSchema,
  type CommunicationBatch,
  type CommunicationBatchCreateInput,
  type CommunicationBatchItem,
  type CommunicationBatchStatus,
  type OutboundMessage,
} from "@shared/communications";
import type { DB } from "../db/connection";
import { writeAudit } from "./audit";
import {
  getOutboundMessage,
  queueOutboundMessage,
  reviewOutboundMessage,
} from "./communications";

const MAX_BATCH_ITEMS = 100;
const MAX_ENQUEUE_ITEMS = 25;
const MAX_ERROR_LENGTH = 2_000;

export interface CommunicationBatchActor {
  id: number | null;
  name: string;
}

export interface CommunicationBatchEvent {
  id: number;
  batchId: string;
  eventType:
    | "created"
    | "approved"
    | "rejected"
    | "enqueue_started"
    | "item_queued"
    | "item_failed"
    | "retry_started"
    | "enqueue_completed"
    | "cancelled";
  detail: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

function cleanText(value: string, label: string, max = 500): string {
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text))
    throw new Error(`A valid ${label} is required`);
  return text;
}

function controlledUsersExist(db: DB): boolean {
  return (
    (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n > 0
  );
}

function activeActor(
  db: DB,
  input: CommunicationBatchActor,
): CommunicationBatchActor {
  if (input.id === null) {
    if (controlledUsersExist(db))
      throw new Error(
        "Sign in as an active user to manage a communication batch",
      );
    return { id: null, name: cleanText(input.name, "actor", 160) };
  }
  const row = db
    .prepare(
      `SELECT id,name FROM users WHERE id=? AND active=1
       AND (access_expires_at IS NULL OR access_expires_at > datetime('now'))`,
    )
    .get(input.id) as { id: number; name: string } | undefined;
  if (!row) throw new Error("The acting user is not active");
  return { id: row.id, name: row.name };
}

function appendEvent(
  db: DB,
  batchId: string,
  eventType: CommunicationBatchEvent["eventType"],
  actor: string,
  detail: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO communication_batch_events(batch_id,event_type,detail_json,actor)
     VALUES(?,?,?,?)`,
  ).run(batchId, eventType, JSON.stringify(detail), actor);
}

function safeTotal(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error("The batch amount exceeds Total's exact integer range");
  }
  return total;
}

function recipientCount(message: OutboundMessage): number {
  return new Set([...message.to, ...message.cc, ...message.bcc]).size;
}

function parseEmails(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  )
    throw new Error("Stored batch recipient evidence is invalid");
  return parsed;
}

function publicItem(row: Record<string, unknown>): CommunicationBatchItem {
  return {
    id: Number(row.id),
    batchId: String(row.batchId),
    messageId: String(row.messageId),
    position: Number(row.position),
    status: row.status as CommunicationBatchItem["status"],
    documentKind: row.documentKind as CommunicationBatchItem["documentKind"],
    documentLabel: String(row.documentLabel),
    amountPaise: Number(row.amountPaise),
    messageRevision: Number(row.messageRevision),
    contentSha256: String(row.contentSha256),
    ledgerId: row.ledgerId == null ? null : Number(row.ledgerId),
    contactId: row.contactId == null ? null : Number(row.contactId),
    to: parseEmails(row.toJson),
    cc: parseEmails(row.ccJson),
    bcc: parseEmails(row.bccJson),
    subject: String(row.subject),
    bodyText: String(row.bodyText),
    exclusionReason:
      row.exclusionReason == null ? null : String(row.exclusionReason),
    attempts: Number(row.attempts),
    lastError: row.lastError == null ? null : String(row.lastError),
    queuedAt: row.queuedAt == null ? null : String(row.queuedAt),
    messageStatus: row.messageStatus as CommunicationBatchItem["messageStatus"],
  };
}

function listItems(db: DB, batchId: string): CommunicationBatchItem[] {
  return (
    db
      .prepare(
        `SELECT i.id,i.batch_id AS batchId,i.message_id AS messageId,i.position,i.status,
          i.document_kind AS documentKind,i.document_label AS documentLabel,
          i.amount_paise AS amountPaise,i.message_revision AS messageRevision,
          i.content_sha256 AS contentSha256,i.ledger_id AS ledgerId,i.contact_id AS contactId,
          i.to_json AS toJson,i.cc_json AS ccJson,i.bcc_json AS bccJson,i.subject,i.body_text AS bodyText,
          i.exclusion_reason AS exclusionReason,i.attempts,i.last_error AS lastError,
          i.queued_at AS queuedAt,m.status AS messageStatus
         FROM communication_batch_items i JOIN outbound_messages m ON m.id=i.message_id
         WHERE i.batch_id=? ORDER BY i.position,i.id`,
      )
      .all(batchId) as Record<string, unknown>[]
  ).map(publicItem);
}

const BATCH_SELECT = `SELECT id,name,status,maker_user_id AS makerUserId,maker_name AS makerName,
  checker_user_id AS checkerUserId,checker_name AS checkerName,decision_note AS decisionNote,
  selected_count AS selectedCount,included_count AS includedCount,excluded_count AS excludedCount,
  recipient_count AS recipientCount,total_amount_paise AS totalAmountPaise,
  created_at AS createdAt,reviewed_at AS reviewedAt,updated_at AS updatedAt
  FROM communication_batches`;

export function getCommunicationBatch(db: DB, id: string): CommunicationBatch {
  const row = db.prepare(`${BATCH_SELECT} WHERE id=?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error("Communication batch not found");
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status as CommunicationBatchStatus,
    makerUserId: row.makerUserId == null ? null : Number(row.makerUserId),
    makerName: String(row.makerName),
    checkerUserId: row.checkerUserId == null ? null : Number(row.checkerUserId),
    checkerName: row.checkerName == null ? null : String(row.checkerName),
    decisionNote: row.decisionNote == null ? null : String(row.decisionNote),
    selectedCount: Number(row.selectedCount),
    includedCount: Number(row.includedCount),
    excludedCount: Number(row.excludedCount),
    recipientCount: Number(row.recipientCount),
    totalAmountPaise: Number(row.totalAmountPaise),
    createdAt: String(row.createdAt),
    reviewedAt: row.reviewedAt == null ? null : String(row.reviewedAt),
    updatedAt: String(row.updatedAt),
    items: listItems(db, id),
  };
}

export function listCommunicationBatches(
  db: DB,
  status?: CommunicationBatchStatus,
  limit = 100,
): CommunicationBatch[] {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const ids = (
    status
      ? db
          .prepare(
            "SELECT id FROM communication_batches WHERE status=? ORDER BY updated_at DESC,id LIMIT ?",
          )
          .all(status, safeLimit)
      : db
          .prepare(
            "SELECT id FROM communication_batches ORDER BY updated_at DESC,id LIMIT ?",
          )
          .all(safeLimit)
  ) as { id: string }[];
  return ids.map(({ id }) => getCommunicationBatch(db, id));
}

export function listCommunicationBatchEvents(
  db: DB,
  batchId: string,
): CommunicationBatchEvent[] {
  getCommunicationBatch(db, batchId);
  return (
    db
      .prepare(
        `SELECT id,batch_id AS batchId,event_type AS eventType,detail_json AS detailJson,
          actor,created_at AS createdAt FROM communication_batch_events
         WHERE batch_id=? ORDER BY id`,
      )
      .all(batchId) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: Number(row.id),
    batchId: String(row.batchId),
    eventType: row.eventType as CommunicationBatchEvent["eventType"],
    detail: JSON.parse(String(row.detailJson)) as Record<string, unknown>,
    actor: String(row.actor),
    createdAt: String(row.createdAt),
  }));
}

export function createCommunicationBatch(
  db: DB,
  input: CommunicationBatchCreateInput,
  actorInput: CommunicationBatchActor,
): CommunicationBatch {
  const data = communicationBatchCreateSchema.parse(input);
  if (data.items.length > MAX_BATCH_ITEMS)
    throw new Error("Batch is too large");
  const actor = activeActor(db, actorInput);
  const snapshots = data.items.map((item) => ({
    input: item,
    message: getOutboundMessage(db, item.messageId),
  }));
  for (const { input: item, message } of snapshots) {
    if (message.status !== "draft")
      throw new Error(`${item.documentLabel} is no longer an editable draft`);
  }
  const included = snapshots.filter(
    ({ input: item }) => item.exclusionReason === null,
  );
  if (!included.length)
    throw new Error("Include at least one draft in the batch");
  const totalAmountPaise = safeTotal(
    included.map(({ input }) => input.amountPaise),
  );
  const recipients = included.reduce(
    (total, { message }) => total + recipientCount(message),
    0,
  );
  const controlled = controlledUsersExist(db);
  const id = randomUUID();
  const initialStatus: CommunicationBatchStatus = controlled
    ? "pending_approval"
    : "approved";
  db.transaction(() => {
    db.prepare(
      `INSERT INTO communication_batches
       (id,name,status,maker_user_id,maker_name,selected_count,included_count,excluded_count,
        recipient_count,total_amount_paise)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      data.name,
      initialStatus,
      actor.id,
      actor.name,
      snapshots.length,
      included.length,
      snapshots.length - included.length,
      recipients,
      totalAmountPaise,
    );
    snapshots.forEach(({ input: item, message }, position) => {
      db.prepare(
        `INSERT INTO communication_batch_items
         (batch_id,message_id,position,status,document_kind,document_label,amount_paise,
          message_revision,content_sha256,ledger_id,contact_id,to_json,cc_json,bcc_json,subject,body_text,
          exclusion_reason)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        message.id,
        position,
        item.exclusionReason === null ? "ready" : "excluded",
        item.documentKind,
        item.documentLabel,
        item.amountPaise,
        message.revision,
        message.contentSha256,
        message.ledgerId,
        message.contactId,
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        JSON.stringify(message.bcc),
        message.subject,
        message.bodyText,
        item.exclusionReason,
      );
    });
    appendEvent(db, id, "created", actor.name, {
      control: controlled
        ? "maker_checker_required"
        : "not_applicable_no_users",
      selectedCount: snapshots.length,
      includedCount: included.length,
      excludedCount: snapshots.length - included.length,
      recipientCount: recipients,
      totalAmountPaise,
    });
    if (!controlled) {
      for (const { message } of included)
        reviewOutboundMessage(db, message.id, message.revision, actor.name);
      appendEvent(db, id, "approved", actor.name, {
        control: "not_applicable_no_users",
      });
    }
  })();
  const batch = getCommunicationBatch(db, id);
  writeAudit(db, "communication_batch", 0, "create", null, {
    ...batch,
    items: batch.items.map(
      ({ messageId, contentSha256, amountPaise, status }) => ({
        messageId,
        contentSha256,
        amountPaise,
        status,
      }),
    ),
  });
  return batch;
}

function assertBatchDraftsUnchanged(db: DB, batch: CommunicationBatch): void {
  for (const item of batch.items.filter((row) => row.status === "ready")) {
    const message = getOutboundMessage(db, item.messageId);
    if (
      message.status !== "draft" ||
      message.revision !== item.messageRevision ||
      message.contentSha256 !== item.contentSha256
    )
      throw new Error(`${item.documentLabel} changed after the batch preview`);
  }
}

export function approveCommunicationBatch(
  db: DB,
  id: string,
  actorInput: CommunicationBatchActor,
  note: string | null,
): CommunicationBatch {
  const actor = activeActor(db, actorInput);
  if (actor.id === null) throw new Error("A signed-in checker is required");
  const before = getCommunicationBatch(db, id);
  if (before.status !== "pending_approval")
    throw new Error("Communication batch is no longer pending approval");
  if (before.makerUserId === actor.id)
    throw new Error("Maker and checker must be different active users");
  const decisionNote = note === null ? null : cleanText(note, "decision note");
  db.transaction(() => {
    assertBatchDraftsUnchanged(db, before);
    for (const item of before.items.filter((row) => row.status === "ready"))
      reviewOutboundMessage(
        db,
        item.messageId,
        item.messageRevision,
        actor.name,
      );
    const result = db
      .prepare(
        `UPDATE communication_batches SET status='approved',checker_user_id=?,checker_name=?,
         decision_note=?,reviewed_at=datetime('now'),updated_at=datetime('now')
         WHERE id=? AND status='pending_approval'`,
      )
      .run(actor.id, actor.name, decisionNote, id);
    if (result.changes !== 1)
      throw new Error("Communication batch changed; reload it before approval");
    appendEvent(db, id, "approved", actor.name, {
      checkerUserId: actor.id,
      includedCount: before.includedCount,
      recipientCount: before.recipientCount,
      totalAmountPaise: before.totalAmountPaise,
      note: decisionNote,
    });
  })();
  const after = getCommunicationBatch(db, id);
  writeAudit(
    db,
    "communication_batch",
    0,
    "update",
    { id, status: before.status },
    {
      id,
      status: after.status,
      checker: actor.name,
    },
  );
  return after;
}

export function rejectCommunicationBatch(
  db: DB,
  id: string,
  actorInput: CommunicationBatchActor,
  noteInput: string,
): CommunicationBatch {
  const actor = activeActor(db, actorInput);
  if (actor.id === null) throw new Error("A signed-in checker is required");
  const note = cleanText(noteInput, "rejection note");
  const before = getCommunicationBatch(db, id);
  if (before.status !== "pending_approval")
    throw new Error("Communication batch is no longer pending approval");
  if (before.makerUserId === actor.id)
    throw new Error("Maker and checker must be different active users");
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE communication_batches SET status='rejected',checker_user_id=?,checker_name=?,
         decision_note=?,reviewed_at=datetime('now'),updated_at=datetime('now')
         WHERE id=? AND status='pending_approval'`,
      )
      .run(actor.id, actor.name, note, id);
    if (result.changes !== 1)
      throw new Error(
        "Communication batch changed; reload it before rejection",
      );
    appendEvent(db, id, "rejected", actor.name, {
      checkerUserId: actor.id,
      note,
    });
  })();
  const after = getCommunicationBatch(db, id);
  writeAudit(
    db,
    "communication_batch",
    0,
    "update",
    { id, status: before.status },
    {
      id,
      status: after.status,
      checker: actor.name,
      note,
    },
  );
  return after;
}

function refreshBatchQueueStatus(db: DB, id: string): CommunicationBatchStatus {
  const counts = db
    .prepare(
      `SELECT SUM(status='queued') AS queued,SUM(status IN ('ready','failed')) AS remaining
       FROM communication_batch_items WHERE batch_id=? AND status<>'excluded'`,
    )
    .get(id) as { queued: number; remaining: number };
  const status: CommunicationBatchStatus =
    Number(counts.remaining) === 0
      ? "queued"
      : Number(counts.queued) > 0
        ? "partially_queued"
        : "approved";
  db.prepare(
    "UPDATE communication_batches SET status=?,updated_at=datetime('now') WHERE id=?",
  ).run(status, id);
  return status;
}

export function enqueueCommunicationBatch(
  db: DB,
  id: string,
  smtpProfileId: number,
  actorInput: CommunicationBatchActor,
  itemIds?: number[],
): CommunicationBatch {
  const actor = activeActor(db, actorInput);
  const before = getCommunicationBatch(db, id);
  if (!(before.status === "approved" || before.status === "partially_queued"))
    throw new Error("Approve the communication batch before queueing it");
  if (itemIds && itemIds.length > MAX_ENQUEUE_ITEMS)
    throw new Error(`Queue at most ${MAX_ENQUEUE_ITEMS} batch items at a time`);
  const selectedIds = itemIds ? new Set(itemIds) : null;
  const eligible = before.items.filter((item) =>
    selectedIds
      ? selectedIds.has(item.id) &&
        (item.status === "ready" || item.status === "failed")
      : item.status === "ready" || item.status === "failed",
  );
  if (itemIds && new Set(itemIds).size !== itemIds.length)
    throw new Error("A batch item can be selected only once");
  if (itemIds && eligible.length !== itemIds.length)
    throw new Error("Select only ready or failed items from this batch");
  const selected = eligible.slice(0, MAX_ENQUEUE_ITEMS);
  if (!selected.length)
    throw new Error("No ready or failed batch items were selected");
  const retry = selected.some((item) => item.status === "failed");
  db.transaction(() => {
    if (retry)
      appendEvent(db, id, "retry_started", actor.name, {
        itemIds: selected.map((item) => item.id),
      });
    appendEvent(db, id, "enqueue_started", actor.name, {
      smtpProfileId,
      itemIds: selected.map((item) => item.id),
      boundedLimit: MAX_ENQUEUE_ITEMS,
      meaning:
        "Queued locally for SMTP submission; recipient delivery is not confirmed",
    });
  })();
  for (const item of selected) {
    try {
      const message = queueOutboundMessage(
        db,
        item.messageId,
        smtpProfileId,
        actor.name,
      );
      db.transaction(() => {
        db.prepare(
          `UPDATE communication_batch_items SET status='queued',attempts=attempts+1,
           last_error=NULL,queued_at=datetime('now') WHERE id=? AND batch_id=?`,
        ).run(item.id, id);
        refreshBatchQueueStatus(db, id);
        appendEvent(db, id, "item_queued", actor.name, {
          itemId: item.id,
          messageId: item.messageId,
          messageStatus: message.status,
          meaning: "Queued locally; no provider delivery claim",
        });
      })();
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error)
        .replace(/[\r\n\0]+/g, " ")
        .slice(0, MAX_ERROR_LENGTH);
      db.transaction(() => {
        db.prepare(
          `UPDATE communication_batch_items SET status='failed',attempts=attempts+1,last_error=?
           WHERE id=? AND batch_id=?`,
        ).run(detail, item.id, id);
        refreshBatchQueueStatus(db, id);
        appendEvent(db, id, "item_failed", actor.name, {
          itemId: item.id,
          messageId: item.messageId,
          error: detail,
          retryable: true,
        });
      })();
    }
  }
  const status = db.transaction(() => {
    const next = refreshBatchQueueStatus(db, id);
    const current = getCommunicationBatch(db, id);
    appendEvent(db, id, "enqueue_completed", actor.name, {
      attemptedCount: selected.length,
      queuedCount: current.items.filter((item) => item.status === "queued")
        .length,
      failedCount: current.items.filter((item) => item.status === "failed")
        .length,
      remainingCount: current.items.filter((item) => item.status === "ready")
        .length,
      status: next,
    });
    return next;
  })();
  const after = getCommunicationBatch(db, id);
  writeAudit(
    db,
    "communication_batch",
    0,
    "update",
    { id, status: before.status },
    {
      id,
      status,
      queuedCount: after.items.filter((item) => item.status === "queued")
        .length,
      failedCount: after.items.filter((item) => item.status === "failed")
        .length,
    },
  );
  return after;
}

export function cancelCommunicationBatch(
  db: DB,
  id: string,
  actorInput: CommunicationBatchActor,
): CommunicationBatch {
  const actor = activeActor(db, actorInput);
  const before = getCommunicationBatch(db, id);
  if (!(before.status === "pending_approval" || before.status === "approved"))
    throw new Error("This communication batch can no longer be cancelled");
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE communication_batches SET status='cancelled',updated_at=datetime('now')
         WHERE id=? AND status IN ('pending_approval','approved')`,
      )
      .run(id);
    if (result.changes !== 1)
      throw new Error(
        "Communication batch changed; reload it before cancelling",
      );
    appendEvent(db, id, "cancelled", actor.name);
  })();
  const after = getCommunicationBatch(db, id);
  writeAudit(
    db,
    "communication_batch",
    0,
    "update",
    { id, status: before.status },
    {
      id,
      status: after.status,
    },
  );
  return after;
}
