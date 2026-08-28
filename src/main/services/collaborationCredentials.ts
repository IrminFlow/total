import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import { syncConfigureSchema, type SyncConfigureInput } from "@shared/collaborationSync";
import { atomicWriteFile } from "../atomicFile";
import { dataRoot } from "../paths";
import { generateCollaborationKeyMaterial, type CollaborationKeyMaterial } from "./collaborationCrypto";

const storedWorkspaceSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url(),
  workspaceId: z.string().uuid(),
  apiToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  anonKey: z.string().min(1).optional(),
  accessTokenExpiresAt: z.string().datetime().optional(),
  encryptionKey: z.string().min(1),
});
const credentialStoreSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().uuid(),
  signingPrivateKey: z.string().min(1),
  signingPublicKey: z.string().min(1),
  workspaces: z.record(z.string(), storedWorkspaceSchema),
});
type CredentialStore = z.infer<typeof credentialStoreSchema>;

export interface CollaborationCredentials {
  enabled: boolean;
  endpoint: string;
  workspaceId: string;
  apiToken: string;
  refreshToken?: string;
  anonKey?: string;
  accessTokenExpiresAt?: string;
  deviceId: string;
  keys: CollaborationKeyMaterial;
}

function credentialsPath(): string {
  return join(dataRoot(), "collaboration-credentials.json");
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure device storage is unavailable; encrypted sync cannot be configured");
}

function blankStore(): CredentialStore {
  const generated = generateCollaborationKeyMaterial();
  return {
    version: 1,
    deviceId: randomUUID(),
    signingPrivateKey: generated.signingPrivateKey,
    signingPublicKey: generated.signingPublicKey,
    workspaces: {},
  };
}

function readStore(): CredentialStore | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  // Status and privacy screens call this even when collaboration has never been
  // configured. Avoid touching the OS keychain in that common offline path.
  requireEncryption();
  try {
    const wrapper = z.object({ version: z.literal(1), encrypted: z.string().min(1) })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    const plaintext = safeStorage.decryptString(Buffer.from(wrapper.encrypted, "base64"));
    return credentialStoreSchema.parse(JSON.parse(plaintext));
  } catch {
    throw new Error("Encrypted collaboration credentials cannot be read on this device");
  }
}

function writeStore(store: CredentialStore): void {
  requireEncryption();
  const parsed = credentialStoreSchema.parse(store);
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  const encrypted = safeStorage.encryptString(JSON.stringify(parsed)).toString("base64");
  atomicWriteFile(credentialsPath(), `${JSON.stringify({ version: 1, encrypted })}\n`, 0o600);
}

export function normalizedCollaborationEndpoint(value: string): string {
  const url = new URL(value);
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost))
    throw new Error("Sync endpoints must use HTTPS; HTTP is allowed only for localhost development");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function decodeRecoveryKey(value: string): Buffer {
  const normalized = value.trim().replace(/^total-sync-key-v1:/, "");
  const decoded = Buffer.from(normalized, "base64url");
  if (decoded.length !== 32) throw new Error("The collaboration recovery key is invalid");
  return decoded;
}

export function configureCollaborationCredentials(
  companySlug: string,
  input: SyncConfigureInput,
): { createdRecoveryKey: string | null; credentials: CollaborationCredentials } {
  const parsed = syncConfigureSchema.parse(input);
  const store = readStore() ?? blankStore();
  const existing = store.workspaces[companySlug];
  const encryptionKey = parsed.recoveryKey
    ? decodeRecoveryKey(parsed.recoveryKey)
    : existing?.workspaceId === parsed.workspaceId
      ? Buffer.from(existing.encryptionKey, "base64")
      : randomBytes(32);
  const createdRecoveryKey = !parsed.recoveryKey && (!existing || existing.workspaceId !== parsed.workspaceId)
    ? `total-sync-key-v1:${encryptionKey.toString("base64url")}`
    : null;
  store.workspaces[companySlug] = {
    enabled: parsed.enabled,
    endpoint: normalizedCollaborationEndpoint(parsed.endpoint),
    workspaceId: parsed.workspaceId,
    apiToken: parsed.apiToken,
    ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
    ...(parsed.anonKey ? { anonKey: parsed.anonKey } : {}),
    ...(parsed.accessTokenExpiresAt ? { accessTokenExpiresAt: parsed.accessTokenExpiresAt } : {}),
    encryptionKey: encryptionKey.toString("base64"),
  };
  writeStore(store);
  return { createdRecoveryKey, credentials: credentialsFromStore(store, companySlug)! };
}

function credentialsFromStore(store: CredentialStore, companySlug: string): CollaborationCredentials | null {
  const workspace = store.workspaces[companySlug];
  if (!workspace) return null;
  return {
    ...workspace,
    deviceId: store.deviceId,
    keys: {
      encryptionKey: Buffer.from(workspace.encryptionKey, "base64"),
      signingPrivateKey: store.signingPrivateKey,
      signingPublicKey: store.signingPublicKey,
    },
  };
}

export function readCollaborationCredentials(companySlug: string): CollaborationCredentials | null {
  const store = readStore();
  return store ? credentialsFromStore(store, companySlug) : null;
}

/** Atomically persists a Supabase token rotation inside the encrypted OS credential store. */
export function updateCollaborationSession(companySlug: string, session: {
  apiToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string;
}): CollaborationCredentials {
  const store = readStore();
  const workspace = store?.workspaces[companySlug];
  if (!store || !workspace) throw new Error("Encrypted collaboration is not configured");
  workspace.apiToken = session.apiToken;
  workspace.accessTokenExpiresAt = session.accessTokenExpiresAt;
  if (session.refreshToken) workspace.refreshToken = session.refreshToken;
  writeStore(store);
  return credentialsFromStore(store, companySlug)!;
}

export function setCollaborationEnabled(companySlug: string, enabled: boolean): void {
  const store = readStore();
  if (!store?.workspaces[companySlug]) throw new Error("Encrypted collaboration is not configured");
  store.workspaces[companySlug].enabled = enabled;
  writeStore(store);
}

/** Shown only after an owner explicitly requests it; callers must avoid logs and telemetry. */
export function exportCollaborationRecoveryKey(companySlug: string): string {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials) throw new Error("Encrypted collaboration is not configured");
  return `total-sync-key-v1:${credentials.keys.encryptionKey.toString("base64url")}`;
}

export function removeCollaborationCredentials(companySlug: string): void {
  const store = readStore();
  if (!store?.workspaces[companySlug]) return;
  delete store.workspaces[companySlug];
  writeStore(store);
}
