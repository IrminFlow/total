import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { safeStorage } from "electron";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import type { DB } from "../db/connection";
import { companyDir } from "../paths";
import { writeAudit } from "./audit";

const ENABLED_KEY = "attachments.encryption.enabled";
const KEY_KEY = "attachments.encryption.key";
const MAGIC = Buffer.from("TOTALATT1", "ascii");

function readMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(db: DB, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}

export function attachmentEncryptionEnabled(db: DB): boolean {
  try {
    return JSON.parse(readMeta(db, ENABLED_KEY) ?? "false") === true;
  } catch {
    return false;
  }
}

function vaultKey(db: DB, create: boolean): Buffer {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      "Secure credential storage is unavailable on this computer",
    );
  const stored = readMeta(db, KEY_KEY);
  if (stored) {
    const envelope = JSON.parse(stored) as { version: 1; encrypted: string };
    const key = safeStorage.decryptString(
      Buffer.from(envelope.encrypted, "base64"),
    );
    return Buffer.from(key, "base64");
  }
  if (!create) throw new Error("Attachment encryption key is missing");
  const key = randomBytes(32);
  writeMeta(db, KEY_KEY, {
    version: 1,
    encrypted: safeStorage
      .encryptString(key.toString("base64"))
      .toString("base64"),
  });
  return key;
}

function encryptBuffer(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(key: Buffer, envelope: Buffer): Buffer {
  if (
    envelope.length < MAGIC.length + 12 + 16 ||
    !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error("Attachment is not a Total encrypted attachment");
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(ivStart, tagStart),
  );
  decipher.setAuthTag(envelope.subarray(tagStart, bodyStart));
  return Buffer.concat([
    decipher.update(envelope.subarray(bodyStart)),
    decipher.final(),
  ]);
}

function assertManaged(slug: string, path: string): void {
  const root = resolve(companyDir(slug), "attachments");
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error("Attachment path is outside the managed attachment folder");
}

export function assertManagedAttachmentPath(slug: string, path: string): void {
  assertManaged(slug, path);
}

/** Idempotent removal primitive for the durable voucher-purge cleanup journal. */
export function removeManagedAttachment(slug: string, path: string): void {
  assertManaged(slug, path);
  if (existsSync(path)) unlinkSync(path);
}

function atomicWrite(path: string, data: Buffer): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, path);
}

export function storeManagedAttachment(
  db: DB,
  slug: string,
  sourcePath: string,
  destinationPath: string,
): string {
  assertManaged(slug, destinationPath);
  if (!attachmentEncryptionEnabled(db)) {
    copyFileSync(sourcePath, destinationPath);
    return destinationPath;
  }
  const encryptedPath = `${destinationPath}.totalatt`;
  atomicWrite(
    encryptedPath,
    encryptBuffer(vaultKey(db, true), readFileSync(sourcePath)),
  );
  return encryptedPath;
}

export function readManagedAttachment(
  db: DB,
  slug: string,
  path: string,
): Buffer {
  assertManaged(slug, path);
  const data = readFileSync(path);
  return path.endsWith(".totalatt")
    ? decryptBuffer(vaultKey(db, false), data)
    : data;
}

function migrateInboxFiles(db: DB, slug: string, enabled: boolean): number {
  const rows = [
    ...(db
      .prepare(
        "SELECT 'ai_document_inbox' AS sourceTable,id,source_path AS sourcePath FROM ai_document_inbox",
      )
      .all() as {
      sourceTable: "ai_document_inbox";
      id: number;
      sourcePath: string;
    }[]),
    ...(db
      .prepare(
        "SELECT 'import_voucher_attachments' AS sourceTable,id,stored_path AS sourcePath FROM import_voucher_attachments",
      )
      .all() as {
      sourceTable: "import_voucher_attachments";
      id: number;
      sourcePath: string;
    }[]),
  ];
  let changed = 0;
  for (const row of rows) {
    if (!existsSync(row.sourcePath)) continue;
    assertManaged(slug, row.sourcePath);
    if (enabled && !row.sourcePath.endsWith(".totalatt")) {
      const next = `${row.sourcePath}.totalatt`;
      atomicWrite(
        next,
        encryptBuffer(vaultKey(db, true), readFileSync(row.sourcePath)),
      );
      const pathColumn =
        row.sourceTable === "ai_document_inbox" ? "source_path" : "stored_path";
      db.prepare(
        `UPDATE ${row.sourceTable} SET ${pathColumn}=? WHERE id=?`,
      ).run(next, row.id);
      unlinkSync(row.sourcePath);
      changed += 1;
    } else if (!enabled && row.sourcePath.endsWith(".totalatt")) {
      const next = row.sourcePath.slice(0, -".totalatt".length);
      atomicWrite(
        next,
        decryptBuffer(vaultKey(db, false), readFileSync(row.sourcePath)),
      );
      const pathColumn =
        row.sourceTable === "ai_document_inbox" ? "source_path" : "stored_path";
      db.prepare(
        `UPDATE ${row.sourceTable} SET ${pathColumn}=? WHERE id=?`,
      ).run(next, row.id);
      unlinkSync(row.sourcePath);
      changed += 1;
    }
  }
  return changed;
}

export function setAttachmentEncryption(
  db: DB,
  slug: string,
  enabled: boolean,
  actor: string,
): { enabled: boolean; migratedFiles: number } {
  const before = attachmentEncryptionEnabled(db);
  if (enabled) vaultKey(db, true);
  const migratedFiles = migrateInboxFiles(db, slug, enabled);
  writeMeta(db, ENABLED_KEY, enabled);
  const after = { enabled, migratedFiles };
  writeAudit(
    db,
    "attachment_encryption",
    0,
    "update",
    { enabled: before },
    { ...after, actor },
  );
  return after;
}
