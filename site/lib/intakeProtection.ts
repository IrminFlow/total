import { createHmac, randomUUID } from "node:crypto";
import { deleteJson, intakeStoreConfigured, listJson, readJson, storeJson } from "./intakeStore";

interface ProtectionReceipt {
  id: string;
  receivedAt: string;
}

interface ProtectionRecord {
  at: string;
  expiresAt: string;
  scope: string;
  payload: string;
}

interface DeduplicationRecord extends ProtectionRecord {
  state: "reserved" | "completed" | "retryable";
  owner: string;
  reservationExpiresAt: string;
  receipt: ProtectionReceipt;
}

interface IntakeReservation {
  kind: "memory" | "stored";
  key: string;
  owner: string;
  expiresAt: number;
  record?: DeduplicationRecord;
}

export interface IntakeProtectionResult {
  allowed: boolean;
  duplicate: boolean;
  pending?: boolean;
  unavailable?: boolean;
  receipt?: ProtectionReceipt;
  idempotencyKey?: string;
  reservation?: IntakeReservation;
}

const memoryAttempts = new Map<string, { count: number; resetAt: number }>();
const memoryDuplicates = new Map<string, { expiresAt: number; receipt: ProtectionReceipt }>();
const memoryReservations = new Map<string, { owner: string; expiresAt: number; receipt: ProtectionReceipt }>();
const memoryRetryReceipts = new Map<string, { expiresAt: number; receipt: ProtectionReceipt }>();
const processKey = randomUUID();
const RESERVATION_TTL_MS = 30_000;

function securityKey(): string {
  return process.env.INTAKE_SECURITY_SECRET || process.env.SUPPORT_WEBHOOK_SECRET || process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN || processKey;
}

function digest(value: string): string {
  return createHmac("sha256", securityKey()).update(value).digest("hex");
}

function normalizedClientAddress(request: Request): string {
  let address = request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for")?.split(",")[0] || request.headers.get("x-real-ip") || "unknown";
  address = address.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return address.slice(0, 128) || "unknown";
}

function actorFor(request: Request): string {
  return digest(normalizedClientAddress(request));
}

function reserveMemoryRate(subject: string, now: number, windowMs: number, maxRequests: number): boolean {
  const current = memoryAttempts.get(subject);
  const count = !current || current.resetAt <= now ? 1 : current.count + 1;
  const resetAt = !current || current.resetAt <= now ? now + windowMs : current.resetAt;
  memoryAttempts.set(subject, { count, resetAt });
  return count <= maxRequests;
}

async function reserveStoredRate(scope: string, subject: string, now: number, windowMs: number, maxRequests: number): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowKey = new Date(windowStart).toISOString().replace(/[-:.TZ]/g, "");
  const prefix = `intake-security/rate/${scope}/${windowKey}/${subject}/`;
  const record: ProtectionRecord = {
    at: new Date(now).toISOString(),
    expiresAt: new Date(windowStart + windowMs * 2).toISOString(),
    scope,
    payload: subject,
  };
  if ((await listJson<ProtectionRecord>(prefix, maxRequests)).length >= maxRequests) return false;
  await storeJson(`${prefix}${randomUUID()}.json`, record);
  return (await listJson<ProtectionRecord>(prefix, maxRequests + 1)).length <= maxRequests;
}

/** Bounds public metadata lookups without persisting an address, email or case reference. */
export async function allowProtectedLookup(options: { request: Request; keyMaterial: string; maxActorRequests: number; maxKeyRequests: number; windowMs: number; now?: Date }): Promise<boolean> {
  const now = options.now?.getTime() ?? Date.now();
  const actor = actorFor(options.request);
  const key = digest(options.keyMaterial.slice(0, 1_000));
  const memory = () => reserveMemoryRate(`support-lookup:${actor}`, now, options.windowMs, options.maxActorRequests) && reserveMemoryRate(`support-key:${key}`, now, options.windowMs, options.maxKeyRequests);
  if (!intakeStoreConfigured()) return memory();
  try {
    const actorAllowed = await reserveStoredRate("support-lookup", actor, now, options.windowMs, options.maxActorRequests);
    if (!actorAllowed) return false;
    return await reserveStoredRate("support-key", key, now, options.windowMs, options.maxKeyRequests);
  } catch {
    return memory();
  }
}

function memoryProtection(actor: string, duplicateKey: string, now: number, windowMs: number, maxRequests: number, receipt: ProtectionReceipt): IntakeProtectionResult {
  const duplicate = memoryDuplicates.get(duplicateKey);
  if (duplicate && duplicate.expiresAt > now) return { allowed: true, duplicate: true, receipt: duplicate.receipt };

  const reservation = memoryReservations.get(duplicateKey);
  if (reservation && reservation.expiresAt > now) return { allowed: false, duplicate: false, pending: true };
  if (reservation) memoryReservations.delete(duplicateKey);
  const retry = memoryRetryReceipts.get(duplicateKey);
  if (retry && retry.expiresAt <= now) memoryRetryReceipts.delete(duplicateKey);
  const stableReceipt = retry && retry.expiresAt > now ? retry.receipt : receipt;

  const current = memoryAttempts.get(actor);
  const count = !current || current.resetAt <= now ? 1 : current.count + 1;
  const resetAt = !current || current.resetAt <= now ? now + windowMs : current.resetAt;
  memoryAttempts.set(actor, { count, resetAt });
  if (count > maxRequests) return { allowed: false, duplicate: false };
  const owner = randomUUID();
  memoryReservations.set(duplicateKey, {
    owner,
    expiresAt: now + RESERVATION_TTL_MS,
    receipt: stableReceipt,
  });
  memoryRetryReceipts.delete(duplicateKey);

  if (memoryAttempts.size + memoryDuplicates.size > 20_000) {
    for (const [key, value] of memoryAttempts) if (value.resetAt <= now) memoryAttempts.delete(key);
    for (const [key, value] of memoryDuplicates) if (value.expiresAt <= now) memoryDuplicates.delete(key);
    for (const [key, value] of memoryReservations) if (value.expiresAt <= now) memoryReservations.delete(key);
    for (const [key, value] of memoryRetryReceipts) if (value.expiresAt <= now) memoryRetryReceipts.delete(key);
  }
  return {
    allowed: true,
    duplicate: false,
    receipt: stableReceipt,
    idempotencyKey: digest(`delivery\n${duplicateKey}`),
    reservation: {
      kind: "memory",
      key: duplicateKey,
      owner,
      expiresAt: now + windowMs,
    },
  };
}

export async function completeIntake(result: IntakeProtectionResult): Promise<void> {
  const reservation = result.reservation;
  if (!reservation) return;
  if (reservation.kind === "memory") {
    const current = memoryReservations.get(reservation.key);
    if (current?.owner !== reservation.owner) return;
    memoryReservations.delete(reservation.key);
    memoryDuplicates.set(reservation.key, {
      expiresAt: reservation.expiresAt,
      receipt: current.receipt,
    });
    return;
  }
  const current = await readJson<DeduplicationRecord>(reservation.key);
  if (current?.state !== "reserved" || current.owner !== reservation.owner) return;
  await storeJson(reservation.key, { ...current, state: "completed", reservationExpiresAt: current.expiresAt }, true);
}

export async function releaseIntake(result: IntakeProtectionResult): Promise<void> {
  const reservation = result.reservation;
  if (!reservation) return;
  if (reservation.kind === "memory") {
    const current = memoryReservations.get(reservation.key);
    if (current?.owner === reservation.owner) {
      memoryReservations.delete(reservation.key);
      memoryRetryReceipts.set(reservation.key, {
        expiresAt: reservation.expiresAt,
        receipt: current.receipt,
      });
    }
    return;
  }
  const current = await readJson<DeduplicationRecord>(reservation.key).catch(() => null);
  if (current?.state === "reserved" && current.owner === reservation.owner)
    await storeJson(reservation.key, { ...current, state: "retryable", reservationExpiresAt: current.at }, true).catch(() => undefined);
}

/**
 * Reserves one intake request. Private Blob storage makes the limit and short-lived
 * duplicate receipt shared by all serverless instances. A reservation becomes a
 * duplicate only after the caller confirms durable delivery. Only keyed digests
 * and bounded timestamps are persisted; client addresses are not.
 */
export async function protectIntake(options: { request: Request; scope: "support" | "feedback"; dedupeMaterial: string; receipt: ProtectionReceipt; maxRequests: number; windowMs: number; now?: Date }): Promise<IntakeProtectionResult> {
  const now = options.now?.getTime() ?? Date.now();
  const actor = actorFor(options.request);
  const payload = digest(options.dedupeMaterial.slice(0, 8_000));
  const windowStart = Math.floor(now / options.windowMs) * options.windowMs;
  const windowKey = new Date(windowStart).toISOString().replace(/[-:.TZ]/g, "");
  const duplicateKey = `${options.scope}:${actor}:${payload}:${windowKey}`;
  const idempotencyKey = digest(`delivery\n${duplicateKey}`);
  const memory = () => memoryProtection(`${options.scope}:${actor}`, duplicateKey, now, options.windowMs, options.maxRequests, options.receipt);
  if (!intakeStoreConfigured()) return memory();

  const ratePrefix = `intake-security/rate/${options.scope}/${windowKey}/${actor}/`;
  const dedupePath = `intake-security/dedup/${options.scope}/${windowKey}/${actor}-${payload}.json`;
  const expiresAt = new Date(windowStart + options.windowMs * 2).toISOString();
  try {
    const existing = await readJson<DeduplicationRecord>(dedupePath);
    if (existing?.state === "completed" && Date.parse(existing.expiresAt) > now)
      return { allowed: true, duplicate: true, receipt: existing.receipt, idempotencyKey };
    if (existing?.state === "reserved" && Date.parse(existing.reservationExpiresAt) > now) return { allowed: false, duplicate: false, pending: true };
    const retryReceipt = existing?.state === "retryable" && Date.parse(existing.expiresAt) > now ? existing.receipt : null;
    if (existing) await deleteJson(dedupePath).catch(() => undefined);

    const record: ProtectionRecord = {
      at: new Date(now).toISOString(),
      expiresAt,
      scope: options.scope,
      payload,
    };
    await storeJson(`${ratePrefix}${randomUUID()}.json`, record);
    const attempts = await listJson<ProtectionRecord>(ratePrefix, options.maxRequests + 1);
    if (attempts.length > options.maxRequests) return { allowed: false, duplicate: false };

    const owner = randomUUID();
    const dedupe: DeduplicationRecord = {
      ...record,
      state: "reserved",
      owner,
      reservationExpiresAt: new Date(now + RESERVATION_TTL_MS).toISOString(),
      receipt: retryReceipt ?? options.receipt,
    };
    try {
      await storeJson(dedupePath, dedupe);
    } catch {
      const winner = await readJson<DeduplicationRecord>(dedupePath);
      if (winner?.state === "completed") return { allowed: true, duplicate: true, receipt: winner.receipt, idempotencyKey };
      if (winner?.state === "reserved") return { allowed: false, duplicate: false, pending: true };
      return { allowed: false, duplicate: false, unavailable: true };
    }
    return {
      allowed: true,
      duplicate: false,
      receipt: dedupe.receipt,
      idempotencyKey,
      reservation: {
        kind: "stored",
        key: dedupePath,
        owner,
        expiresAt: Date.parse(expiresAt),
        record: dedupe,
      },
    };
  } catch {
    return { allowed: false, duplicate: false, unavailable: true };
  }
}
