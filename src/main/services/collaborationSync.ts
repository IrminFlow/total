import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  collaborationPublishSchema,
  collaborativeDocumentSchema,
  compareVectorClocks,
  deriveSyncPhase,
  encryptedSyncEnvelopeSchema,
  invitationAcceptSchema,
  mergeCollaborativeDocuments,
  parseTeamInvitationCode,
  teamInvitationSchema,
  type CollaborationPublishInput,
  type CollaborativeDocument,
  type EncryptedSyncEnvelope,
  type SyncStatus,
  type InvitationAcceptInput,
  type TeamInvitation,
} from "@shared/collaborationSync";
import type { DB } from "../db/connection";
import {
  decryptCollaborationEnvelope,
  encryptCollaborationDocument,
} from "./collaborationCrypto";
import {
  readCollaborationCredentials,
  normalizedCollaborationEndpoint,
  type CollaborationCredentials,
} from "./collaborationCredentials";

const MAX_ENVELOPES_PER_REQUEST = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

type Row = Record<string, unknown>;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function state(db: DB, key: string): string | null {
  return (db.prepare("SELECT value FROM sync_state WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
}

function setState(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

function localDocument(db: DB, kind: string, id: string): CollaborativeDocument | null {
  const row = db.prepare("SELECT document_json FROM sync_records WHERE entity_kind=? AND entity_id=?").get(kind, id) as { document_json: string } | undefined;
  return row ? collaborativeDocumentSchema.parse(JSON.parse(row.document_json)) : null;
}

function saveDocument(db: DB, document: CollaborativeDocument): void {
  const json = JSON.stringify(document);
  const latest = Object.values(document.fields).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  db.prepare(`INSERT INTO sync_records(entity_kind,entity_id,document_json,document_hash,updated_at,updated_by_device,deleted)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET
    document_json=excluded.document_json,document_hash=excluded.document_hash,updated_at=excluded.updated_at,
    updated_by_device=excluded.updated_by_device,deleted=excluded.deleted`).run(
      document.entityKind,
      document.entityId,
      json,
      sha256(json),
      document.deletion?.updatedAt ?? latest?.updatedAt ?? new Date(0).toISOString(),
      document.deletion?.deviceId ?? latest?.deviceId ?? Object.keys(document.clock).sort()[0] ?? "unknown",
      document.deleted ? 1 : 0,
    );
}

function nextSequence(db: DB, deviceId: string): number {
  const row = db.prepare("SELECT MAX(sequence) value FROM sync_envelopes WHERE device_id=?").get(deviceId) as { value: number | null };
  return (row.value ?? 0) + 1;
}

export function publishCollaborationChange(
  db: DB,
  companySlug: string,
  value: CollaborationPublishInput,
): CollaborativeDocument {
  const input = collaborationPublishSchema.parse(value);
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  const current = localDocument(db, input.entityKind, input.entityId);
  const now = new Date().toISOString();
  const counter = (current?.clock[credentials.deviceId] ?? 0) + 1;
  const clock = { ...(current?.clock ?? {}), [credentials.deviceId]: counter };
  const fieldUpdates = Object.fromEntries(Object.entries(input.patch).map(([name, fieldValue]) => [
    name,
    { value: fieldValue, clock, updatedAt: now, deviceId: credentials.deviceId },
  ]));
  const document = collaborativeDocumentSchema.parse({
    entityKind: input.entityKind,
    entityId: input.entityId,
    fields: { ...(current?.fields ?? {}), ...fieldUpdates },
    clock,
    deleted: input.deleted ?? current?.deleted ?? false,
    deletion: input.deleted === undefined
      ? current?.deletion
      : { value: input.deleted, clock, updatedAt: now, deviceId: credentials.deviceId },
  });
  const envelope = encryptCollaborationDocument({
    workspaceId: credentials.workspaceId,
    envelopeId: randomUUID(),
    deviceId: credentials.deviceId,
    sequence: nextSequence(db, credentials.deviceId),
    createdAt: now,
    document,
    keys: credentials.keys,
  });
  const envelopeJson = JSON.stringify(envelope);
  db.transaction(() => {
    saveDocument(db, document);
    db.prepare(`INSERT INTO sync_envelopes(envelope_id,direction,device_id,sequence,entity_kind,entity_id,envelope_json,content_hash,state,created_at)
      VALUES(?,'outgoing',?,?,?,?,?,?,'pending',?)`).run(
        envelope.envelopeId,
        envelope.deviceId,
        envelope.sequence,
        envelope.entityKind,
        envelope.entityId,
        envelopeJson,
        sha256(envelopeJson),
        envelope.createdAt,
      );
    const resolve = db.prepare(`UPDATE sync_conflicts SET resolved=1,resolved_at=datetime('now')
      WHERE resolved=0 AND entity_kind=? AND entity_id=? AND field_name=?`);
    for (const field of Object.keys(input.patch))
      resolve.run(input.entityKind, input.entityId, field);
  })();
  return document;
}

export function listCollaborationRecords(db: DB, includeDeleted = false): CollaborativeDocument[] {
  const rows = db.prepare(`SELECT document_json FROM sync_records ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY updated_at DESC,entity_kind,entity_id`).all() as { document_json: string }[];
  return rows.map((row) => collaborativeDocumentSchema.parse(JSON.parse(row.document_json)));
}

function applyIncoming(db: DB, envelope: EncryptedSyncEnvelope, credentials: CollaborationCredentials): void {
  if (envelope.workspaceId !== credentials.workspaceId) throw new Error("Envelope belongs to another workspace");
  if (db.prepare("SELECT 1 FROM sync_envelopes WHERE envelope_id=?").get(envelope.envelopeId)) return;
  const document = decryptCollaborationEnvelope(envelope, credentials.keys.encryptionKey);
  const local = localDocument(db, document.entityKind, document.entityId);
  const merged = mergeCollaborativeDocuments(local, document);
  const resolvedFields = Object.entries(document.fields).flatMap(([field, incoming]) => {
    const existing = local?.fields[field];
    return existing && compareVectorClocks(existing.clock, incoming.clock) === "before" ? [field] : [];
  });
  const json = JSON.stringify(envelope);
  db.transaction(() => {
    db.prepare(`INSERT INTO sync_envelopes(envelope_id,direction,device_id,sequence,entity_kind,entity_id,envelope_json,content_hash,state,created_at,processed_at)
      VALUES(?,'incoming',?,?,?,?,?,?,'applied',?,datetime('now'))`).run(
        envelope.envelopeId,
        envelope.deviceId,
        envelope.sequence,
        envelope.entityKind,
        envelope.entityId,
        json,
        sha256(json),
        envelope.createdAt,
      );
    if (merged.changed) saveDocument(db, merged.document);
    const resolve = db.prepare(`UPDATE sync_conflicts SET resolved=1,resolved_at=datetime('now')
      WHERE resolved=0 AND entity_kind=? AND entity_id=? AND field_name=?`);
    for (const field of resolvedFields)
      resolve.run(envelope.entityKind, envelope.entityId, field);
    const insert = db.prepare(`INSERT INTO sync_conflicts(envelope_id,entity_kind,entity_id,field_name,kept_device_id,other_device_id)
      VALUES(?,?,?,?,?,?)`);
    for (const conflict of merged.conflicts)
      insert.run(envelope.envelopeId, envelope.entityKind, envelope.entityId, conflict.field, conflict.keptDeviceId, conflict.otherDeviceId);
  })();
}

async function boundedJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > MAX_RESPONSE_BYTES) throw new Error("Sync response exceeded the 2 MB limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Sync response exceeded the 2 MB limit");
  if (!response.ok) throw new Error(`Sync server returned HTTP ${response.status}`);
  return JSON.parse(text);
}

async function collaborationRequest(
  url: string,
  apiToken: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await boundedJson(await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function listTeamInvitations(companySlug: string): Promise<TeamInvitation[]> {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  const result = z.object({ invitations: z.array(teamInvitationSchema).max(100) }).parse(
    await collaborationRequest(
      `${credentials.endpoint}/v1/workspaces/${credentials.workspaceId}/invitations`,
      credentials.apiToken,
      { method: "GET" },
    ),
  );
  return result.invitations;
}

export async function createTeamInvitation(
  companySlug: string,
  expiresInHours: number,
): Promise<{ invitation: TeamInvitation; invitationCode: string }> {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  return z.object({
    invitation: teamInvitationSchema,
    invitationCode: z.string().min(1).max(512),
  }).parse(await collaborationRequest(
    `${credentials.endpoint}/v1/workspaces/${credentials.workspaceId}/invitations`,
    credentials.apiToken,
    { method: "POST", body: JSON.stringify({ expiresInHours }) },
  ));
}

export async function revokeTeamInvitation(
  companySlug: string,
  invitationId: string,
): Promise<TeamInvitation> {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  const result = z.object({ invitation: teamInvitationSchema }).parse(await collaborationRequest(
    `${credentials.endpoint}/v1/workspaces/${credentials.workspaceId}/invitations/${invitationId}`,
    credentials.apiToken,
    { method: "DELETE" },
  ));
  return result.invitation;
}

/** Accepts backend membership before the caller stores the separately shared E2E recovery key. */
export async function acceptTeamInvitation(
  input: InvitationAcceptInput,
): Promise<{ workspaceId: string; endpoint: string; apiToken: string; recoveryKey: string }> {
  const parsed = invitationAcceptSchema.parse(input);
  const invitation = parseTeamInvitationCode(parsed.invitationCode);
  const endpoint = normalizedCollaborationEndpoint(parsed.endpoint);
  const result = z.object({ workspaceId: z.string().uuid() }).parse(await collaborationRequest(
    `${endpoint}/v1/invitations/accept`,
    parsed.apiToken,
    { method: "POST", body: JSON.stringify({ invitationCode: parsed.invitationCode }) },
  ));
  if (result.workspaceId !== invitation.workspaceId)
    throw new Error("Invitation response did not match the requested workspace");
  return {
    workspaceId: result.workspaceId,
    endpoint,
    apiToken: parsed.apiToken,
    recoveryKey: parsed.recoveryKey,
  };
}

export async function runCollaborationSync(db: DB, companySlug: string, fetchImpl: typeof fetch = fetch): Promise<SyncStatus> {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  const attemptedAt = new Date().toISOString();
  db.transaction(() => {
    setState(db, "last_attempted_at", attemptedAt);
    setState(db, "sync_phase", "syncing");
  })();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const base = `${credentials.endpoint}/v1/workspaces/${encodeURIComponent(credentials.workspaceId)}/envelopes`;
    const pendingRows = db.prepare("SELECT envelope_json FROM sync_envelopes WHERE direction='outgoing' AND state='pending' ORDER BY sequence LIMIT ?").all(MAX_ENVELOPES_PER_REQUEST) as { envelope_json: string }[];
    if (pendingRows.length) {
      const envelopes = pendingRows.map((row) => encryptedSyncEnvelopeSchema.parse(JSON.parse(row.envelope_json)));
      const result = z.object({ accepted: z.array(z.string().uuid()).max(MAX_ENVELOPES_PER_REQUEST) }).parse(await boundedJson(await fetchImpl(base, {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ envelopes }),
        signal: controller.signal,
      })));
      const acknowledge = db.prepare("UPDATE sync_envelopes SET state='acknowledged',processed_at=datetime('now') WHERE envelope_id=? AND direction='outgoing'");
      db.transaction(() => result.accepted.forEach((id) => acknowledge.run(id)))();
    }
    const cursor = state(db, "cursor");
    const pullUrl = `${base}?limit=${MAX_ENVELOPES_PER_REQUEST}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const pull = z.object({
      envelopes: z.array(encryptedSyncEnvelopeSchema).max(MAX_ENVELOPES_PER_REQUEST),
      cursor: z.string().max(1024).nullable(),
    }).parse(await boundedJson(await fetchImpl(pullUrl, {
      headers: { authorization: `Bearer ${credentials.apiToken}` },
      signal: controller.signal,
    })));
    for (const envelope of pull.envelopes) applyIncoming(db, envelope, credentials);
    const syncedAt = new Date().toISOString();
    db.transaction(() => {
      if (pull.cursor) setState(db, "cursor", pull.cursor);
      setState(db, "last_synced_at", syncedAt);
      setState(db, "last_error", "");
      setState(db, "sync_phase", "idle");
    })();
    return getCollaborationSyncStatus(db, companySlug);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Sync failed";
    db.transaction(() => {
      setState(db, "last_error", message);
      setState(db, "sync_phase", "error");
    })();
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

export function getCollaborationSyncStatus(db: DB, companySlug: string): SyncStatus {
  let credentials: CollaborationCredentials | null = null;
  try { credentials = readCollaborationCredentials(companySlug); } catch { /* status remains usable */ }
  const pending = (db.prepare("SELECT COUNT(*) value FROM sync_envelopes WHERE direction='outgoing' AND state='pending'").get() as { value: number }).value;
  const conflicts = (db.prepare("SELECT COUNT(*) value FROM sync_conflicts WHERE resolved=0").get() as { value: number }).value;
  const configured = credentials !== null;
  const enabled = credentials?.enabled ?? false;
  const lastError = state(db, "last_error") || null;
  return {
    phase: deriveSyncPhase({
      configured,
      enabled,
      pending,
      persistedPhase: state(db, "sync_phase"),
      lastError,
    }),
    configured,
    enabled,
    endpoint: credentials?.endpoint ?? null,
    workspaceId: credentials?.workspaceId ?? null,
    deviceId: credentials?.deviceId ?? null,
    pending,
    conflicts,
    cursor: state(db, "cursor"),
    lastAttemptedAt: state(db, "last_attempted_at"),
    lastSyncedAt: state(db, "last_synced_at"),
    lastError,
  };
}
