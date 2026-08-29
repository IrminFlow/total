import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from "crypto";
import { safeStorage } from "electron";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { atomicWriteFile } from "../atomicFile";
import { companyExportsDir, dataRoot } from "../paths";

interface StoredIdentity {
  version: 1;
  keyId: string;
  publicKeyPem: string;
  encryptedPrivateKeyPem: string;
  createdAt: string;
}

export interface ExportSigningStatus {
  enabled: boolean;
  keyId: string | null;
  publicKeyPem: string | null;
  createdAt: string | null;
}

export interface ExportSignature {
  schema: "total.export-signature.v1";
  keyId: string;
  algorithm: "Ed25519";
  artifact: string;
  sha256: string;
  signedAt: string;
  signature: string;
  publicKeyPem: string;
}

function identityPath(): string {
  return join(dataRoot(), "export-signing.json");
}

function readIdentity(): StoredIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(identityPath(), "utf8")) as StoredIdentity;
    return parsed.version === 1 && parsed.keyId ? parsed : null;
  } catch {
    return null;
  }
}

export function signingStatus(): ExportSigningStatus {
  const identity = readIdentity();
  return identity
    ? {
        enabled: true,
        keyId: identity.keyId,
        publicKeyPem: identity.publicKeyPem,
        createdAt: identity.createdAt,
      }
    : { enabled: false, keyId: null, publicKeyPem: null, createdAt: null };
}

export function initializeSigningIdentity(): ExportSigningStatus {
  const existing = readIdentity();
  if (existing) return signingStatus();
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure credential storage is unavailable on this computer");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyId = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 20);
  const stored: StoredIdentity = {
    version: 1,
    keyId,
    publicKeyPem,
    encryptedPrivateKeyPem: safeStorage.encryptString(privateKeyPem).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dataRoot(), { recursive: true });
  atomicWriteFile(identityPath(), JSON.stringify(stored, null, 2));
  return signingStatus();
}

function assertExportPath(slug: string, path: string): void {
  const root = resolve(companyExportsDir(slug));
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error("Only files in this company's exports folder can be signed");
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function signExportArtifact(
  slug: string,
  path: string,
): { signaturePath: string; signature: ExportSignature } {
  assertExportPath(slug, path);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error("Export artifact not found");
  const identity = readIdentity();
  if (!identity) throw new Error("Create a local export-signing identity first");
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure credential storage is unavailable");
  const sha256 = sha256File(path);
  const signedAt = new Date().toISOString();
  const message = Buffer.from(`total.export-signature.v1\n${sha256}\n${signedAt}`, "utf8");
  const privateKeyPem = safeStorage.decryptString(
    Buffer.from(identity.encryptedPrivateKeyPem, "base64"),
  );
  const signature: ExportSignature = {
    schema: "total.export-signature.v1",
    keyId: identity.keyId,
    algorithm: "Ed25519",
    artifact: path.split(/[\\/]/).pop() ?? "artifact",
    sha256,
    signedAt,
    signature: sign(null, message, privateKeyPem).toString("base64"),
    publicKeyPem: identity.publicKeyPem,
  };
  const signaturePath = `${path}.total-signature.json`;
  mkdirSync(dirname(signaturePath), { recursive: true });
  atomicWriteFile(signaturePath, JSON.stringify(signature, null, 2));
  return { signaturePath, signature };
}

export function signExportIfEnabled(
  slug: string,
  path: string,
): { signaturePath: string; signature: ExportSignature } | null {
  return readIdentity() ? signExportArtifact(slug, path) : null;
}

export function verifyExportSignature(
  artifactPath: string,
  signaturePath = `${artifactPath}.total-signature.json`,
): boolean {
  try {
    const signature = JSON.parse(readFileSync(signaturePath, "utf8")) as ExportSignature;
    const sha256 = sha256File(artifactPath);
    if (sha256 !== signature.sha256) return false;
    const message = Buffer.from(
      `total.export-signature.v1\n${signature.sha256}\n${signature.signedAt}`,
      "utf8",
    );
    return verify(
      null,
      message,
      signature.publicKeyPem,
      Buffer.from(signature.signature, "base64"),
    );
  } catch {
    return false;
  }
}
