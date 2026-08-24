import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "crypto";
import { safeStorage } from "electron";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { basename, dirname, extname, join, resolve, sep } from "path";
import type { DB } from "../db/connection";
import { companyDir } from "../paths";
import { writeAudit } from "./audit";

const ENABLED_KEY = "attachments.encryption.enabled";
const KEY_KEY = "attachments.encryption.key";
const MAGIC = Buffer.from("TOTALATT1", "ascii");
const PORTABLE_KEY_AAD = Buffer.from("total.attachment-vault-key.v1", "utf8");
const PORTABLE_KEY_SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/**
 * A passphrase-protected copy of the attachment vault key. The normal key envelope in SQLite is
 * deliberately device-bound through Electron safeStorage; this envelope exists only inside a
 * complete, encrypted backup so the same attachment bytes can be opened on a replacement device.
 */
export interface PortableVaultKeyEnvelope {
  version: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

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

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 8 || passphrase.length > 1024)
    throw new Error("Backup passphrase must be between 8 and 1,024 characters");
}

/**
 * Wrap the current raw vault key for a portable complete backup. Returns null when this company
 * has never created a vault key. The caller must keep the returned envelope inside an encrypted
 * package; it is not a replacement for the device-bound envelope stored in SQLite.
 */
export function wrapVaultKeyForBackup(
  db: DB,
  passphrase: string,
): PortableVaultKeyEnvelope | null {
  const stored = readMeta(db, KEY_KEY);
  if (!stored) return null;
  assertPassphrase(passphrase);
  const raw = vaultKey(db, false);
  if (raw.length !== 32) throw new Error("Attachment encryption key is invalid");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrappingKey = scryptSync(
    passphrase,
    salt,
    32,
    PORTABLE_KEY_SCRYPT,
  );
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(PORTABLE_KEY_AAD);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  return {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decodeEnvelopeField(value: string, expectedBytes: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value)
    throw new Error("Portable attachment key envelope is invalid");
  return decoded;
}

/**
 * Re-protect a portable vault key with this device's safeStorage and install it in a restored DB.
 * Authentication is completed before SQLite is mutated, so a wrong passphrase cannot replace a
 * usable local envelope.
 */
export function installVaultKeyFromBackup(
  db: DB,
  envelope: PortableVaultKeyEnvelope,
  passphrase: string,
): void {
  assertPassphrase(passphrase);
  if (
    envelope.version !== 1 ||
    envelope.kdf !== "scrypt" ||
    !safeStorage.isEncryptionAvailable()
  )
    throw new Error("Portable attachment key cannot be installed on this computer");
  try {
    const salt = decodeEnvelopeField(envelope.salt, 16);
    const iv = decodeEnvelopeField(envelope.iv, 12);
    const tag = decodeEnvelopeField(envelope.tag, 16);
    const ciphertext = decodeEnvelopeField(envelope.ciphertext, 32);
    const wrappingKey = scryptSync(
      passphrase,
      salt,
      32,
      PORTABLE_KEY_SCRYPT,
    );
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
    decipher.setAAD(PORTABLE_KEY_AAD);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (raw.length !== 32) throw new Error("invalid key length");
    writeMeta(db, KEY_KEY, {
      version: 1,
      encrypted: safeStorage
        .encryptString(raw.toString("base64"))
        .toString("base64"),
    });
  } catch {
    throw new Error("Wrong passphrase or corrupted attachment key envelope");
  }
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

function managedRoot(slug: string): string {
  return resolve(companyDir(slug), "attachments");
}

function lexicallyManaged(slug: string, path: string): boolean {
  const root = managedRoot(slug);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}${sep}`);
}

function assertManaged(slug: string, path: string): void {
  const root = managedRoot(slug);
  const target = resolve(path);
  if (!lexicallyManaged(slug, target))
    throw new Error("Attachment path is outside the managed attachment folder");
  if (!existsSync(root)) throw new Error("Managed attachment folder is missing");
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())
    throw new Error("Managed attachment folder is not a regular directory");
  const rootReal = realpathSync(root);
  const checkedPath = existsSync(target) ? target : dirname(target);
  const checkedEntry = lstatSync(checkedPath);
  if (checkedEntry.isSymbolicLink())
    throw new Error("Managed attachment paths cannot contain symbolic links");
  const checkedReal = realpathSync(checkedPath);
  if (checkedReal !== rootReal && !checkedReal.startsWith(`${rootReal}${sep}`))
    throw new Error("Attachment path resolves outside the managed attachment folder");
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    throw new Error("Managed attachments cannot be symbolic links");
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory handles cannot be fsynced on every Windows filesystem.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readRegularFileNoFollow(path: string): Buffer {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Attachment is not a regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written < 1) throw new Error("Attachment write made no progress");
    offset += written;
  }
}

function atomicWrite(path: string, data: Buffer): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeAll(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (existsSync(path)) throw new Error(`Attachment destination already exists: ${basename(path)}`);
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function assertRegularManagedFile(slug: string, path: string): void {
  assertManaged(slug, path);
  if (!lstatSync(path).isFile()) throw new Error("Attachment is not a regular file");
}

function assertManagedDestination(slug: string, path: string): void {
  const root = resolve(companyDir(slug), "attachments");
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error("Attachment path is outside the managed attachment folder");
  assertManaged(slug, path);
}

export function assertManagedAttachmentPath(slug: string, path: string): void {
  assertManaged(slug, path);
}

/** Idempotent removal primitive for the durable voucher-purge cleanup journal. */
export function removeManagedAttachment(slug: string, path: string): void {
  if (!existsSync(path)) {
    assertManaged(slug, path);
    return;
  }
  assertRegularManagedFile(slug, path);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

export function storeManagedAttachment(
  db: DB,
  slug: string,
  sourcePath: string,
  destinationPath: string,
): string {
  assertManagedDestination(slug, destinationPath);
  const source = readRegularFileNoFollow(sourcePath);
  if (!attachmentEncryptionEnabled(db)) {
    atomicWrite(destinationPath, source);
    return destinationPath;
  }
  const encryptedPath = `${destinationPath}.totalatt`;
  assertManagedDestination(slug, encryptedPath);
  atomicWrite(
    encryptedPath,
    encryptBuffer(vaultKey(db, true), source),
  );
  return encryptedPath;
}

/**
 * Adopt reimbursement evidence created by older builds that stored only an external absolute
 * path. Complete backup calls this before taking its SQLite snapshot so an apparently successful
 * package can never retain a reference to another computer's filesystem.
 */
export function adoptLegacyReimbursementEvidence(db: DB, slug: string): number {
  const rows = db
    .prepare(
      "SELECT id,attachment_path AS path FROM employee_reimbursements WHERE attachment_path IS NOT NULL",
    )
    .all() as Array<{ id: number; path: string }>;
  const destinationDirectory = join(companyDir(slug), "attachments", "payroll", "reimbursements");
  let adopted = 0;
  for (const row of rows) {
    if (lexicallyManaged(slug, row.path)) continue;
    if (!existsSync(row.path))
      throw new Error(`Reimbursement evidence is missing (claim #${row.id})`);
    const source = lstatSync(row.path);
    if (source.isSymbolicLink() || !source.isFile() || source.size > 25 * 1024 * 1024)
      throw new Error(`Reimbursement evidence is not a regular file up to 25 MB (claim #${row.id})`);
    mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
    const extension = extname(row.path).toLowerCase();
    const portableExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
    const managed = storeManagedAttachment(
      db,
      slug,
      row.path,
      join(destinationDirectory, `${randomUUID()}${portableExtension}`),
    );
    try {
      db.prepare("UPDATE employee_reimbursements SET attachment_path=? WHERE id=?").run(
        managed,
        row.id,
      );
    } catch (error) {
      removeManagedAttachment(slug, managed);
      throw error;
    }
    adopted += 1;
  }
  if (adopted > 0)
    writeAudit(db, "reimbursement_evidence", 0, "update", null, {
      adopted,
      reason: "complete_backup",
    });
  return adopted;
}

export function readManagedAttachment(
  db: DB,
  slug: string,
  path: string,
): Buffer {
  assertRegularManagedFile(slug, path);
  const data = readRegularFileNoFollow(path);
  return path.endsWith(".totalatt")
    ? decryptBuffer(vaultKey(db, false), data)
    : data;
}

const MANAGED_ATTACHMENT_TABLES = [
  { table: "ai_document_inbox", pathColumn: "source_path", externalLegacy: false },
  { table: "import_voucher_attachments", pathColumn: "stored_path", externalLegacy: false },
  { table: "voucher_attachments", pathColumn: "stored_path", externalLegacy: false },
  { table: "employee_reimbursements", pathColumn: "attachment_path", externalLegacy: true },
] as const;

function migrateManagedFiles(db: DB, slug: string, enabled: boolean): number {
  const rows = MANAGED_ATTACHMENT_TABLES.flatMap(({ table, pathColumn, externalLegacy }) =>
    (
      db
        .prepare(
          `SELECT id,${pathColumn} AS sourcePath FROM ${table} WHERE ${pathColumn} IS NOT NULL`,
        )
        .all() as Array<{ id: number; sourcePath: string }>
    ).map((row) => ({ ...row, table, pathColumn, externalLegacy })),
  );
  let changed = 0;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.sourcePath) ?? [];
    group.push(row);
    grouped.set(row.sourcePath, group);
  }
  for (const [sourcePath, references] of grouped) {
    if (!existsSync(sourcePath)) continue;
    if (!lexicallyManaged(slug, sourcePath)) {
      if (references.every((row) => row.externalLegacy)) continue;
      throw new Error("Attachment path is outside the managed attachment folder");
    }
    assertManaged(slug, sourcePath);
    if (enabled && !sourcePath.endsWith(".totalatt")) {
      const next = `${sourcePath}.totalatt`;
      if (existsSync(next))
        throw new Error(`Encrypted attachment destination already exists: ${basename(next)}`);
      atomicWrite(
        next,
        encryptBuffer(vaultKey(db, true), readRegularFileNoFollow(sourcePath)),
      );
      try {
        db.transaction(() => {
          for (const row of references)
            db.prepare(`UPDATE ${row.table} SET ${row.pathColumn}=? WHERE id=?`).run(
              next,
              row.id,
            );
        })();
      } catch (error) {
        unlinkSync(next);
        throw error;
      }
      unlinkSync(sourcePath);
      fsyncDirectory(dirname(sourcePath));
      changed += 1;
    } else if (!enabled && sourcePath.endsWith(".totalatt")) {
      const next = sourcePath.slice(0, -".totalatt".length);
      if (existsSync(next))
        throw new Error(`Decrypted attachment destination already exists: ${basename(next)}`);
      atomicWrite(
        next,
        decryptBuffer(vaultKey(db, false), readRegularFileNoFollow(sourcePath)),
      );
      try {
        db.transaction(() => {
          for (const row of references)
            db.prepare(`UPDATE ${row.table} SET ${row.pathColumn}=? WHERE id=?`).run(
              next,
              row.id,
            );
        })();
      } catch (error) {
        unlinkSync(next);
        throw error;
      }
      unlinkSync(sourcePath);
      fsyncDirectory(dirname(sourcePath));
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
  const migratedFiles = migrateManagedFiles(db, slug, enabled);
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
