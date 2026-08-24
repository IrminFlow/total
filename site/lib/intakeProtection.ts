import { createHmac, randomUUID } from "node:crypto";
import { intakeStoreConfigured, listJson, readJson, storeJson } from "./intakeStore";

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
  receipt: ProtectionReceipt;
}

export interface IntakeProtectionResult {
  allowed: boolean;
  duplicate: boolean;
  receipt?: ProtectionReceipt;
}

const memoryAttempts = new Map<string, { count: number; resetAt: number }>();
const memoryDuplicates = new Map<string, { expiresAt: number; receipt: ProtectionReceipt }>();
const processKey = randomUUID();

function securityKey(): string {
  return process.env.INTAKE_SECURITY_SECRET
    || process.env.SUPPORT_WEBHOOK_SECRET
    || process.env.BLOB_READ_WRITE_TOKEN
    || process.env.VERCEL_OIDC_TOKEN
    || processKey;
}

function digest(value: string): string {
  return createHmac("sha256", securityKey()).update(value).digest("hex");
}

function actorFor(request: Request): string {
  const address = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || request.headers.get("x-real-ip")
    || "unknown";
  const agent = request.headers.get("user-agent") || "unknown";
  return digest(`${address.trim().slice(0, 128)}\n${agent.slice(0, 256)}`);
}

function reserveMemoryRate(subject: string, now: number, windowMs: number, maxRequests: number): boolean {
  const current = memoryAttempts.get(subject);
  const count = !current || current.resetAt <= now ? 1 : current.count + 1;
  const resetAt = !current || current.resetAt <= now ? now + windowMs : current.resetAt;
  memoryAttempts.set(subject, { count, resetAt });
  return count <= maxRequests;
}

async function reserveStoredRate(
  scope: string,
  subject: string,
  now: number,
  windowMs: number,
  maxRequests: number,
): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowKey = new Date(windowStart).toISOString().replace(/[-:.TZ]/g, "");
  const prefix = `intake-security/rate/${scope}/${windowKey}/${subject}/`;
  const record: ProtectionRecord = {
    at: new Date(now).toISOString(),
    expiresAt: new Date(windowStart + windowMs * 2).toISOString(),
    scope,
    payload: subject,
  };
  if ((await listJson<ProtectionRecord>(prefix, maxRequests)).length >= maxRequests)
    return false;
  await storeJson(`${prefix}${randomUUID()}.json`, record);
  return (await listJson<ProtectionRecord>(prefix, maxRequests + 1)).length <= maxRequests;
}

/** Bounds public metadata lookups without persisting an address, email or case reference. */
export async function allowProtectedLookup(options: {
  request: Request;
  keyMaterial: string;
  maxActorRequests: number;
  maxKeyRequests: number;
  windowMs: number;
  now?: Date;
}): Promise<boolean> {
  const now = options.now?.getTime() ?? Date.now();
  const actor = actorFor(options.request);
  const key = digest(options.keyMaterial.slice(0, 1_000));
  const memory = () => reserveMemoryRate(`support-lookup:${actor}`, now, options.windowMs, options.maxActorRequests)
    && reserveMemoryRate(`support-key:${key}`, now, options.windowMs, options.maxKeyRequests);
  if (!intakeStoreConfigured()) return memory();
  try {
    const actorAllowed = await reserveStoredRate("support-lookup", actor, now, options.windowMs, options.maxActorRequests);
    if (!actorAllowed) return false;
    return await reserveStoredRate("support-key", key, now, options.windowMs, options.maxKeyRequests);
  } catch {
    return memory();
  }
}

function memoryProtection(
  actor: string,
  duplicateKey: string,
  now: number,
  windowMs: number,
  maxRequests: number,
  receipt: ProtectionReceipt,
): IntakeProtectionResult {
  const duplicate = memoryDuplicates.get(duplicateKey);
  if (duplicate && duplicate.expiresAt > now)
    return { allowed: true, duplicate: true, receipt: duplicate.receipt };

  const current = memoryAttempts.get(actor);
  const count = !current || current.resetAt <= now ? 1 : current.count + 1;
  const resetAt = !current || current.resetAt <= now ? now + windowMs : current.resetAt;
  memoryAttempts.set(actor, { count, resetAt });
  if (count > maxRequests) return { allowed: false, duplicate: false };
  memoryDuplicates.set(duplicateKey, { expiresAt: now + windowMs, receipt });

  if (memoryAttempts.size + memoryDuplicates.size > 20_000) {
    for (const [key, value] of memoryAttempts) if (value.resetAt <= now) memoryAttempts.delete(key);
    for (const [key, value] of memoryDuplicates) if (value.expiresAt <= now) memoryDuplicates.delete(key);
  }
  return { allowed: true, duplicate: false };
}

/**
 * Reserves one intake request. Private Blob storage makes the limit and short-lived
 * duplicate receipt shared by all serverless instances. Only keyed digests and
 * bounded timestamps are persisted; client addresses and user agents are not.
 */
export async function protectIntake(options: {
  request: Request;
  scope: "support" | "feedback";
  dedupeMaterial: string;
  receipt: ProtectionReceipt;
  maxRequests: number;
  windowMs: number;
  now?: Date;
}): Promise<IntakeProtectionResult> {
  const now = options.now?.getTime() ?? Date.now();
  const actor = actorFor(options.request);
  const payload = digest(options.dedupeMaterial.slice(0, 8_000));
  const windowStart = Math.floor(now / options.windowMs) * options.windowMs;
  const windowKey = new Date(windowStart).toISOString().replace(/[-:.TZ]/g, "");
  const duplicateKey = `${options.scope}:${actor}:${payload}:${windowKey}`;
  const memory = () => memoryProtection(
    `${options.scope}:${actor}`,
    duplicateKey,
    now,
    options.windowMs,
    options.maxRequests,
    options.receipt,
  );
  if (!intakeStoreConfigured()) return memory();

  const ratePrefix = `intake-security/rate/${options.scope}/${windowKey}/${actor}/`;
  const dedupePath = `intake-security/dedup/${options.scope}/${windowKey}/${actor}-${payload}.json`;
  const expiresAt = new Date(windowStart + options.windowMs * 2).toISOString();
  try {
    const existing = await readJson<DeduplicationRecord>(dedupePath);
    if (existing && Date.parse(existing.expiresAt) > now)
      return { allowed: true, duplicate: true, receipt: existing.receipt };

    const record: ProtectionRecord = {
      at: new Date(now).toISOString(),
      expiresAt,
      scope: options.scope,
      payload,
    };
    await storeJson(`${ratePrefix}${randomUUID()}.json`, record);
    const attempts = await listJson<ProtectionRecord>(ratePrefix, options.maxRequests + 1);
    if (attempts.length > options.maxRequests) return { allowed: false, duplicate: false };

    const dedupe: DeduplicationRecord = { ...record, receipt: options.receipt };
    try {
      await storeJson(dedupePath, dedupe);
    } catch {
      const winner = await readJson<DeduplicationRecord>(dedupePath);
      if (winner) return { allowed: true, duplicate: true, receipt: winner.receipt };
      return memory();
    }
    return { allowed: true, duplicate: false };
  } catch {
    return memory();
  }
}
