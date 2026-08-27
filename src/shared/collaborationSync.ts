import { z } from "zod";

export const COLLABORATION_ENTITY_KINDS = [
  "proposal",
  "draft",
  "comment",
  "task",
] as const;

export const collaborationEntityKindSchema = z.enum(COLLABORATION_ENTITY_KINDS);
export type CollaborationEntityKind = z.infer<typeof collaborationEntityKindSchema>;

export const vectorClockSchema = z.record(z.string().uuid(), z.number().int().nonnegative());
export type VectorClock = z.infer<typeof vectorClockSchema>;

export const collaborationFieldSchema = z.object({
  value: z.unknown(),
  clock: vectorClockSchema,
  updatedAt: z.string().datetime(),
  deviceId: z.string().uuid(),
});

export const collaborativeDocumentSchema = z.object({
  entityKind: collaborationEntityKindSchema,
  entityId: z.string().min(1).max(180),
  fields: z.record(z.string().min(1).max(120), collaborationFieldSchema),
  clock: vectorClockSchema,
  deleted: z.boolean().default(false),
  deletion: collaborationFieldSchema.optional(),
});
export type CollaborativeDocument = z.infer<typeof collaborativeDocumentSchema>;

export const encryptedSyncEnvelopeSchema = z.object({
  protocol: z.literal("total-sync/v1"),
  workspaceId: z.string().uuid(),
  envelopeId: z.string().uuid(),
  deviceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  entityKind: collaborationEntityKindSchema,
  entityId: z.string().min(1).max(180),
  createdAt: z.string().datetime(),
  keyVersion: z.number().int().positive(),
  cipher: z.literal("aes-256-gcm"),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
  signingPublicKey: z.string().min(1),
  signature: z.string().min(1),
});
export type EncryptedSyncEnvelope = z.infer<typeof encryptedSyncEnvelopeSchema>;

export const syncConfigureSchema = z.object({
  endpoint: z.string().url().max(2048),
  workspaceId: z.string().uuid(),
  apiToken: z.string().trim().min(1).max(4096),
  recoveryKey: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean().default(true),
});
export type SyncConfigureInput = z.infer<typeof syncConfigureSchema>;

export const collaborationPublishSchema = z.object({
  entityKind: collaborationEntityKindSchema,
  entityId: z.string().min(1).max(180),
  patch: z.record(
    z.string().min(1).max(120).refine(
      (key) => !["__proto__", "constructor", "prototype"].includes(key),
      "Unsafe field name",
    ),
    z.unknown(),
  ).superRefine((patch, context) => {
    if (Object.keys(patch).length > 100)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A collaboration change cannot exceed 100 fields" });
    try {
      const json = JSON.stringify(patch);
      if (json === undefined) throw new Error("not JSON");
      if (new TextEncoder().encode(json).byteLength > 256 * 1024)
        context.addIssue({ code: z.ZodIssueCode.custom, message: "A collaboration change cannot exceed 256 KB" });
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Collaboration fields must be JSON-serializable" });
    }
  }),
  deleted: z.boolean().optional(),
});
export type CollaborationPublishInput = z.infer<typeof collaborationPublishSchema>;

export interface SyncStatus {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  workspaceId: string | null;
  deviceId: string | null;
  pending: number;
  conflicts: number;
  cursor: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export const teamInvitationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;

export const invitationAcceptSchema = z.object({
  endpoint: z.string().url().max(2048),
  apiToken: z.string().trim().min(1).max(4096),
  invitationCode: z.string().trim().min(1).max(512),
  recoveryKey: z.string().trim().min(1).max(256),
});
export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

export function parseTeamInvitationCode(value: string): { workspaceId: string; token: string } {
  const match = /^total-invite-v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{32,128})$/i.exec(value.trim());
  if (!match) throw new Error("The team invitation code is invalid");
  return { workspaceId: match[1]!, token: match[2]! };
}

export interface MergeConflict {
  field: string;
  keptDeviceId: string;
  otherDeviceId: string;
}

export interface MergeResult {
  document: CollaborativeDocument;
  changed: boolean;
  conflicts: MergeConflict[];
}

export function compareVectorClocks(a: VectorClock, b: VectorClock): "equal" | "before" | "after" | "concurrent" {
  const devices = new Set([...Object.keys(a), ...Object.keys(b)]);
  let lower = false;
  let higher = false;
  for (const device of devices) {
    const av = a[device] ?? 0;
    const bv = b[device] ?? 0;
    if (av < bv) lower = true;
    if (av > bv) higher = true;
  }
  if (lower && higher) return "concurrent";
  if (lower) return "before";
  if (higher) return "after";
  return "equal";
}

export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = {};
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)]))
    merged[device] = Math.max(a[device] ?? 0, b[device] ?? 0);
  return merged;
}

function deterministicFieldWinner(
  a: z.infer<typeof collaborationFieldSchema>,
  b: z.infer<typeof collaborationFieldSchema>,
): z.infer<typeof collaborationFieldSchema> {
  const clockOrder = compareVectorClocks(a.clock, b.clock);
  if (clockOrder === "before") return b;
  if (clockOrder === "after") return a;
  const aTie = `${a.updatedAt}\u0000${a.deviceId}\u0000${JSON.stringify(a.value)}`;
  const bTie = `${b.updatedAt}\u0000${b.deviceId}\u0000${JSON.stringify(b.value)}`;
  return aTie >= bTie ? a : b;
}

/** Field-level CRDT merge. Concurrent edits never overwrite the losing value silently: the
 * caller receives a conflict record while every device computes the same materialized winner. */
export function mergeCollaborativeDocuments(
  local: CollaborativeDocument | null,
  incoming: CollaborativeDocument,
): MergeResult {
  const remote = collaborativeDocumentSchema.parse(incoming);
  if (!local) return { document: remote, changed: true, conflicts: [] };
  if (local.entityKind !== remote.entityKind || local.entityId !== remote.entityId)
    throw new Error("Cannot merge different collaboration records");

  const fields = { ...local.fields };
  const conflicts: MergeConflict[] = [];
  for (const [name, remoteField] of Object.entries(remote.fields)) {
    const localField = fields[name];
    if (!localField) {
      fields[name] = remoteField;
      continue;
    }
    const order = compareVectorClocks(localField.clock, remoteField.clock);
    const winner = deterministicFieldWinner(localField, remoteField);
    if (
      order === "concurrent" &&
      JSON.stringify(localField.value) !== JSON.stringify(remoteField.value)
    ) {
      conflicts.push({
        field: name,
        keptDeviceId: winner.deviceId,
        otherDeviceId: winner.deviceId === localField.deviceId ? remoteField.deviceId : localField.deviceId,
      });
    }
    fields[name] = winner;
  }

  const deletion = local.deletion && remote.deletion
    ? deterministicFieldWinner(local.deletion, remote.deletion)
    : remote.deletion ?? local.deletion;
  const document = collaborativeDocumentSchema.parse({
    ...local,
    fields,
    clock: mergeVectorClocks(local.clock, remote.clock),
    deleted: deletion ? deletion.value === true : false,
    deletion,
  });
  return {
    document,
    changed: JSON.stringify(document) !== JSON.stringify(local),
    conflicts,
  };
}
