import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import type { DB } from "./connection";
import {
  assertValidCompanyDb,
  backupStamp,
  inspectBackup,
  snapshotSync,
  snapshotTo,
  type BackupPreview,
} from "./backup";
import { decryptFile, encryptFile, MAGIC as ENCRYPTED_MAGIC } from "./crypt";
import {
  adoptLegacyReimbursementEvidence,
  installVaultKeyFromBackup,
  wrapVaultKeyForBackup,
  type PortableVaultKeyEnvelope,
} from "../services/attachmentVault";
import { companyDir } from "../paths";

const PACKAGE_MAGIC = Buffer.from("TOTALCP1", "ascii");
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const COPY_BUFFER_BYTES = 1024 * 1024;

/**
 * Company-root files that are durable user state rather than generated exports or recovery data.
 * A complete restore replaces these roots as units, which also removes files created after the
 * backup instead of silently mixing two attachment generations.
 */
export const COMPLETE_BACKUP_SIDECARS = [
  "attachments",
  "setup.json",
  "inbox",
  "proposals",
  "mcp",
] as const;

export type CompleteBackupEntryRole = "database" | "attachment" | "sidecar";

export interface CompleteBackupEntry {
  path: string;
  role: CompleteBackupEntryRole;
  sizeBytes: number;
  sha256: string;
}

export interface CompleteBackupManifest {
  schema: "total.complete-backup";
  version: 1;
  createdAt: string;
  companySlug: string;
  /** Encrypted inside the outer package; used only to rebase managed absolute attachment paths. */
  sourceCompanyDirectory: string;
  sqliteIntegrity: "quick_check:ok";
  vaultKey: PortableVaultKeyEnvelope | null;
  entries: CompleteBackupEntry[];
}

export interface CreateCompleteBackupOptions {
  db: DB;
  companySlug: string;
  companyDirectory: string;
  destinationPath: string;
  passphrase: string;
  now?: Date;
}

export interface CreateCompleteBackupResult {
  path: string;
  manifest: CompleteBackupManifest;
  sizeBytes: number;
}

export interface CompleteBackupInspection {
  format: "complete" | "legacy-db";
  encrypted: boolean;
  manifest: CompleteBackupManifest | null;
  database: BackupPreview;
}

export interface RestoreCompleteBackupOptions {
  sourcePath: string;
  passphrase?: string;
  targetCompanyDirectory: string;
  targetCompanySlug: string;
  /** The currently-open target DB. When supplied it is safely packaged, checkpointed and closed. */
  liveDb?: DB;
  now?: Date;
}

export interface RestoreCompleteBackupResult {
  format: "complete" | "legacy-db";
  databasePath: string;
  restoredEntries: number;
  preRestoreBackupPath: string | null;
  attachmentsRestored: number;
}

interface MaterializedSource {
  rawPath: string;
  encrypted: boolean;
  temporaryDirectory: string;
}

function assertPassphrase(passphrase: string | undefined): asserts passphrase is string {
  if (!passphrase || passphrase.length < 8 || passphrase.length > 1024)
    throw new Error("Backup passphrase must be between 8 and 1,024 characters");
}

function beginsWith(path: string, magic: Buffer): boolean {
  if (!existsSync(path) || statSync(path).size < magic.length) return false;
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(magic.length);
    return readSync(fd, bytes, 0, bytes.length, 0) === bytes.length && bytes.equals(magic);
  } finally {
    closeSync(fd);
  }
}

function assertArchivePath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Complete backup contains an unsafe entry path");
  for (const part of path.split("/")) {
    const stem = part.split(".")[0]!.toUpperCase();
    if (
      /[<>:"|?*\u0000-\u001f]/.test(part) ||
      /[ .]$/.test(part) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
    )
      throw new Error("Complete backup contains a filename that is not portable to Windows");
  }
}

function writeAll(fd: number, bytes: Buffer, position: number | null = null): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      position === null ? null : position + offset,
    );
    if (written < 1) throw new Error("Complete backup write made no progress");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every supported Windows filesystem. The file itself is
    // still fsynced; POSIX filesystems receive the additional rename durability guarantee.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function assertCompanyDirectory(directory: string, slug: string): void {
  if (resolve(directory) !== resolve(companyDir(slug)))
    throw new Error("Company backup path does not match the company identifier");
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Complete backup supports regular files only");
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(`Complete backup will not follow symbolic links: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!stat.isFile())
      throw new Error(`Complete backup supports regular files only: ${path}`);
    found.push(path);
  };
  visit(root);
  return found;
}

function toArchiveRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  assertArchivePath(value);
  return value;
}

function buildEntries(
  companyDirectory: string,
  snapshotPath: string,
): Array<CompleteBackupEntry & { sourcePath: string }> {
  const entries: Array<CompleteBackupEntry & { sourcePath: string }> = [];
  const add = (archivePath: string, role: CompleteBackupEntryRole, sourcePath: string): void => {
    assertArchivePath(archivePath);
    const sizeBytes = statSync(sourcePath).size;
    entries.push({
      path: archivePath,
      role,
      sizeBytes,
      sha256: sha256File(sourcePath),
      sourcePath,
    });
  };
  add("database/company.db", "database", snapshotPath);
  for (const rootName of COMPLETE_BACKUP_SIDECARS) {
    const root = join(companyDirectory, rootName);
    for (const sourcePath of walkFiles(root)) {
      const archivePath = `company/${toArchiveRelative(companyDirectory, sourcePath)}`;
      add(
        archivePath,
        archivePath.startsWith("company/attachments/") ? "attachment" : "sidecar",
        sourcePath,
      );
    }
  }
  return entries.sort((a, b) => {
    if (a.role === "database") return -1;
    if (b.role === "database") return 1;
    return a.path.localeCompare(b.path);
  });
}

function validateManifest(value: unknown): CompleteBackupManifest {
  if (!value || typeof value !== "object") throw new Error("Complete backup manifest is invalid");
  const manifest = value as Partial<CompleteBackupManifest>;
  if (
    manifest.schema !== "total.complete-backup" ||
    manifest.version !== 1 ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.companySlug !== "string" ||
    !manifest.companySlug ||
    typeof manifest.sourceCompanyDirectory !== "string" ||
    !manifest.sourceCompanyDirectory ||
    manifest.sqliteIntegrity !== "quick_check:ok" ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < 1 ||
    manifest.entries.length > MAX_ENTRIES
  )
    throw new Error("Complete backup manifest is invalid or unsupported");

  const paths = new Set<string>();
  let databases = 0;
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") throw new Error("Complete backup entry is invalid");
    assertArchivePath(entry.path);
    if (
      paths.has(entry.path) ||
      !["database", "attachment", "sidecar"].includes(entry.role) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("Complete backup entry is invalid");
    paths.add(entry.path);
    if (entry.role === "database") {
      databases += 1;
      if (entry.path !== "database/company.db")
        throw new Error("Complete backup database entry is invalid");
    } else if (!entry.path.startsWith("company/")) {
      throw new Error("Complete backup sidecar entry is invalid");
    } else {
      const root = entry.path.slice("company/".length).split("/")[0];
      if (!(COMPLETE_BACKUP_SIDECARS as readonly string[]).includes(root ?? ""))
        throw new Error("Complete backup contains an unsupported sidecar root");
      if (
        (entry.role === "attachment" && root !== "attachments") ||
        (root === "attachments" && entry.role !== "attachment")
      )
        throw new Error("Complete backup attachment entry is invalid");
    }
  }
  if (databases !== 1) throw new Error("Complete backup must contain one database snapshot");
  if (manifest.vaultKey !== null && typeof manifest.vaultKey !== "object")
    throw new Error("Complete backup vault-key envelope is invalid");
  return manifest as CompleteBackupManifest;
}

function writeRawPackage(
  path: string,
  manifest: CompleteBackupManifest,
  entries: Array<CompleteBackupEntry & { sourcePath: string }>,
): void {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES)
    throw new Error("Complete backup manifest is too large");
  const fd = openSync(path, "wx", 0o600);
  const copyBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(manifestBytes.length);
    writeAll(fd, PACKAGE_MAGIC);
    writeAll(fd, length);
    writeAll(fd, manifestBytes);
    for (const entry of entries) {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const source = openSync(entry.sourcePath, constants.O_RDONLY | noFollow);
      try {
        const sourceStat = fstatSync(source);
        if (!sourceStat.isFile() || sourceStat.size !== entry.sizeBytes)
          throw new Error(`Complete backup source changed while being packaged: ${entry.path}`);
        for (;;) {
          const bytes = readSync(source, copyBuffer, 0, copyBuffer.length, null);
          if (bytes === 0) break;
          writeAll(fd, copyBuffer.subarray(0, bytes));
        }
      } finally {
        closeSync(source);
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readManifest(rawPath: string): { manifest: CompleteBackupManifest; dataOffset: number } {
  const fd = openSync(rawPath, "r");
  try {
    const header = Buffer.alloc(PACKAGE_MAGIC.length + 4);
    if (readSync(fd, header, 0, header.length, 0) !== header.length)
      throw new Error("Complete backup is truncated");
    if (!header.subarray(0, PACKAGE_MAGIC.length).equals(PACKAGE_MAGIC))
      throw new Error("Complete backup header is invalid");
    const manifestLength = header.readUInt32LE(PACKAGE_MAGIC.length);
    if (manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES)
      throw new Error("Complete backup manifest length is invalid");
    const bytes = Buffer.alloc(manifestLength);
    if (readSync(fd, bytes, 0, bytes.length, header.length) !== bytes.length)
      throw new Error("Complete backup manifest is truncated");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Complete backup manifest is not valid JSON");
    }
    return { manifest: validateManifest(parsed), dataOffset: header.length + manifestLength };
  } finally {
    closeSync(fd);
  }
}

function destinationFor(stage: string, entry: CompleteBackupEntry): string {
  if (entry.path === "database/company.db") return join(stage, "company.db");
  const relativePath = entry.path.slice("company/".length);
  const destination = resolve(stage, ...relativePath.split("/"));
  const resolvedStage = resolve(stage);
  if (!destination.startsWith(`${resolvedStage}${sep}`))
    throw new Error("Complete backup entry escapes the restore staging folder");
  return destination;
}

function extractAndVerify(rawPath: string, stage: string): CompleteBackupManifest {
  const { manifest, dataOffset } = readManifest(rawPath);
  const expectedSize = manifest.entries.reduce((sum, entry) => sum + entry.sizeBytes, dataOffset);
  if (!Number.isSafeInteger(expectedSize) || statSync(rawPath).size !== expectedSize)
    throw new Error("Complete backup length does not match its manifest");

  const source = openSync(rawPath, "r");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = dataOffset;
  try {
    for (const entry of manifest.entries) {
      const destination = destinationFor(stage, entry);
      mkdirSync(dirname(destination), { recursive: true });
      const output = openSync(destination, "wx", 0o600);
      const hash = createHash("sha256");
      let remaining = entry.sizeBytes;
      try {
        while (remaining > 0) {
          const requested = Math.min(buffer.length, remaining);
          const bytes = readSync(source, buffer, 0, requested, position);
          if (bytes !== requested) throw new Error("Complete backup entry is truncated");
          writeAll(output, buffer.subarray(0, bytes));
          hash.update(buffer.subarray(0, bytes));
          remaining -= bytes;
          position += bytes;
        }
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      if (hash.digest("hex") !== entry.sha256)
        throw new Error(`Complete backup checksum failed for ${entry.path}`);
    }
  } finally {
    closeSync(source);
  }
  const stagedDb = join(stage, "company.db");
  assertValidCompanyDb(stagedDb);
  const encryptedAttachments = manifest.entries.some(
    (entry) => entry.role === "attachment" && entry.path.endsWith(".totalatt"),
  );
  if (encryptedAttachments && !manifest.vaultKey)
    throw new Error("Complete backup has encrypted attachments but no portable vault key");
  return manifest;
}

async function materializeSource(
  sourcePath: string,
  passphrase: string | undefined,
): Promise<MaterializedSource> {
  if (!existsSync(sourcePath)) throw new Error("Backup file not found");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "total-complete-backup-read-"));
  const rawPath = join(temporaryDirectory, "package.raw");
  try {
    if (beginsWith(sourcePath, ENCRYPTED_MAGIC)) {
      assertPassphrase(passphrase);
      await decryptFile(sourcePath, rawPath, passphrase);
      return { rawPath, encrypted: true, temporaryDirectory };
    }
    copyFileSync(sourcePath, rawPath);
    return { rawPath, encrypted: false, temporaryDirectory };
  } catch (error) {
    safeRemove(temporaryDirectory);
    throw error;
  }
}

function safeRemove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function createCompleteBackup(
  options: CreateCompleteBackupOptions,
): Promise<CreateCompleteBackupResult> {
  assertPassphrase(options.passphrase);
  if (!options.db.open) throw new Error("Company database is not open");
  const companyDirectory = resolve(options.companyDirectory);
  const destinationPath = resolve(options.destinationPath);
  assertCompanyDirectory(companyDirectory, options.companySlug);
  if (!existsSync(companyDirectory)) throw new Error("Company folder was not found");
  if (existsSync(destinationPath)) throw new Error("Backup destination already exists");
  for (const root of COMPLETE_BACKUP_SIDECARS) {
    const durableRoot = resolve(companyDirectory, root);
    if (destinationPath === durableRoot || destinationPath.startsWith(`${durableRoot}${sep}`))
      throw new Error("A complete backup cannot be written inside a durable company sidecar");
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(destinationPath), ".total-backup-write-"));
  const snapshotPath = join(temporaryDirectory, "company.db");
  const rawPath = join(temporaryDirectory, "package.raw");
  const encryptedPath = join(temporaryDirectory, "package.encrypted");
  const verifyDirectory = join(temporaryDirectory, "verify");
  try {
    adoptLegacyReimbursementEvidence(options.db, options.companySlug);
    await snapshotTo(options.db, snapshotPath);
    assertValidCompanyDb(snapshotPath);
    const withSources = buildEntries(companyDirectory, snapshotPath);
    const vaultKey = wrapVaultKeyForBackup(options.db, options.passphrase);
    if (
      withSources.some((entry) => entry.role === "attachment" && entry.path.endsWith(".totalatt")) &&
      !vaultKey
    )
      throw new Error("Encrypted attachments cannot be backed up because their vault key is missing");
    const entries = withSources.map(({ sourcePath: _sourcePath, ...entry }) => entry);
    const manifest: CompleteBackupManifest = {
      schema: "total.complete-backup",
      version: 1,
      createdAt: (options.now ?? new Date()).toISOString(),
      companySlug: options.companySlug,
      sourceCompanyDirectory: companyDirectory,
      sqliteIntegrity: "quick_check:ok",
      vaultKey,
      entries,
    };
    writeRawPackage(rawPath, manifest, withSources);
    await encryptFile(rawPath, encryptedPath, options.passphrase);

    // Verify the final encrypted bytes, not just the pre-encryption staging files.
    const decryptedVerification = join(temporaryDirectory, "verified.raw");
    await decryptFile(encryptedPath, decryptedVerification, options.passphrase);
    mkdirSync(verifyDirectory);
    const verifiedManifest = extractAndVerify(decryptedVerification, verifyDirectory);
    const verifiedDb = new Database(join(verifyDirectory, "company.db"));
    try {
      rebaseManagedAttachmentPaths(
        verifiedDb,
        verifiedManifest,
        verifyDirectory,
        companyDirectory,
      );
      verifiedDb.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      verifiedDb.close();
    }
    chmodSync(encryptedPath, 0o600);
    renameSync(encryptedPath, destinationPath);
    fsyncDirectory(dirname(destinationPath));
    return { path: destinationPath, manifest, sizeBytes: statSync(destinationPath).size };
  } finally {
    safeRemove(temporaryDirectory);
  }
}

export async function inspectCompleteBackup(
  sourcePath: string,
  passphrase?: string,
): Promise<CompleteBackupInspection> {
  const materialized = await materializeSource(sourcePath, passphrase);
  try {
    if (beginsWith(materialized.rawPath, SQLITE_MAGIC)) {
      return {
        format: "legacy-db",
        encrypted: materialized.encrypted,
        manifest: null,
        database: inspectBackup(materialized.rawPath),
      };
    }
    const stage = join(materialized.temporaryDirectory, "verify");
    mkdirSync(stage);
    const manifest = extractAndVerify(materialized.rawPath, stage);
    return {
      format: "complete",
      encrypted: materialized.encrypted,
      manifest,
      database: inspectBackup(join(stage, "company.db")),
    };
  } finally {
    safeRemove(materialized.temporaryDirectory);
  }
}

function rollbackInstalledTargets(
  targetCompanyDirectory: string,
  rollbackDirectory: string,
  roots: readonly string[],
): void {
  for (const root of [...roots].reverse()) {
    safeRemove(join(targetCompanyDirectory, root));
    const previous = join(rollbackDirectory, root);
    if (existsSync(previous)) renameSync(previous, join(targetCompanyDirectory, root));
  }
}

function installStagedCompany(
  stage: string,
  targetCompanyDirectory: string,
  sidecarRoots: readonly string[],
): void {
  mkdirSync(targetCompanyDirectory, { recursive: true });
  const rollbackDirectory = join(
    targetCompanyDirectory,
    `.restore-rollback-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(rollbackDirectory);
  const roots = ["company.db", ...sidecarRoots];
  let preserveRollback = false;
  try {
    for (const root of roots) {
      const target = join(targetCompanyDirectory, root);
      if (existsSync(target)) renameSync(target, join(rollbackDirectory, root));
    }
    fsyncDirectory(targetCompanyDirectory);
    fsyncDirectory(rollbackDirectory);
    for (const root of roots) {
      const source = join(stage, root);
      if (existsSync(source)) renameSync(source, join(targetCompanyDirectory, root));
    }
    fsyncDirectory(targetCompanyDirectory);
    assertValidCompanyDb(join(targetCompanyDirectory, "company.db"));
    safeRemove(`${join(targetCompanyDirectory, "company.db")}-wal`);
    safeRemove(`${join(targetCompanyDirectory, "company.db")}-shm`);
  } catch (error) {
    try {
      rollbackInstalledTargets(targetCompanyDirectory, rollbackDirectory, roots);
    } catch (rollbackError) {
      preserveRollback = true;
      throw new Error(
        `Restore failed and rollback also failed. Recovery files remain at ${rollbackDirectory}. ` +
          `Restore error: ${error instanceof Error ? error.message : String(error)}. ` +
          `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  } finally {
    if (!preserveRollback) safeRemove(rollbackDirectory);
  }
}

const MANAGED_PATH_COLUMNS = [
  ["voucher_attachments", "stored_path"],
  ["import_voucher_attachments", "stored_path"],
  ["ai_document_inbox", "source_path"],
  ["employee_reimbursements", "attachment_path"],
] as const;

function managedRelativePath(path: string, sourceCompanyDirectory: string): string[] | null {
  const normalizedRoot = sourceCompanyDirectory.replace(/[\\/]+$/, "");
  const attachmentRoot = `${normalizedRoot}${normalizedRoot.includes("\\") ? "\\" : "/"}attachments`;
  if (path === attachmentRoot) return [];
  if (!path.startsWith(`${attachmentRoot}/`) && !path.startsWith(`${attachmentRoot}\\`)) return null;
  const parts = path
    .slice(attachmentRoot.length + 1)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === ".."))
    throw new Error("Restored database contains an unsafe managed attachment path");
  return parts;
}

/** Rebase only paths that were inside the source managed attachment root; external HR evidence
 *  paths remain untouched. Every rebased reference must point at a file verified from the package. */
function rebaseManagedAttachmentPaths(
  db: Database.Database,
  manifest: CompleteBackupManifest,
  stagedCompanyDirectory: string,
  targetCompanyDirectory: string,
): void {
  const transaction = db.transaction(() => {
    for (const [table, column] of MANAGED_PATH_COLUMNS) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!exists) continue;
      const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!columns.some((candidate) => candidate.name === column)) continue;
      const rows = db
        .prepare(`SELECT id,${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as Array<{ id: number; path: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`);
      for (const row of rows) {
        if (typeof row.path !== "string") continue;
        const parts = managedRelativePath(row.path, manifest.sourceCompanyDirectory);
        if (!parts) continue;
        const stagedPath = join(stagedCompanyDirectory, "attachments", ...parts);
        if (!existsSync(stagedPath) || !lstatSync(stagedPath).isFile())
          throw new Error(`Complete backup is missing a referenced attachment (${table} #${row.id})`);
        update.run(join(targetCompanyDirectory, "attachments", ...parts), row.id);
      }
    }
  });
  transaction();
}

export async function restoreCompleteBackup(
  options: RestoreCompleteBackupOptions,
): Promise<RestoreCompleteBackupResult> {
  const targetCompanyDirectory = resolve(options.targetCompanyDirectory);
  assertCompanyDirectory(targetCompanyDirectory, options.targetCompanySlug);
  const materialized = await materializeSource(options.sourcePath, options.passphrase);
  const installParent = dirname(targetCompanyDirectory);
  mkdirSync(installParent, { recursive: true });
  const stageRoot = mkdtempSync(join(installParent, ".total-restore-stage-"));
  const stage = join(stageRoot, "company");
  mkdirSync(stage);
  let preRestoreBackupPath: string | null = null;
  try {
    if (beginsWith(materialized.rawPath, SQLITE_MAGIC)) {
      assertValidCompanyDb(materialized.rawPath);
      copyFileSync(materialized.rawPath, join(stage, "company.db"));
      if (options.liveDb) {
        const backupDirectory = join(targetCompanyDirectory, "backups");
        mkdirSync(backupDirectory, { recursive: true });
        preRestoreBackupPath = join(
          backupDirectory,
          `${backupStamp(options.now)}-pre-restore-legacy.db`,
        );
        snapshotSync(options.liveDb, preRestoreBackupPath);
        options.liveDb.pragma("wal_checkpoint(TRUNCATE)");
        options.liveDb.close();
      }
      // Legacy compatibility intentionally replaces only SQLite. Existing sidecars are retained.
      installStagedCompany(stage, targetCompanyDirectory, []);
      return {
        format: "legacy-db",
        databasePath: join(targetCompanyDirectory, "company.db"),
        restoredEntries: 1,
        preRestoreBackupPath,
        attachmentsRestored: 0,
      };
    }

    assertPassphrase(options.passphrase);
    const manifest = extractAndVerify(materialized.rawPath, stage);
    const stagedDbPath = join(stage, "company.db");
    const stagedDb = new Database(stagedDbPath);
    try {
      rebaseManagedAttachmentPaths(
        stagedDb,
        manifest,
        stage,
        targetCompanyDirectory,
      );
      if (manifest.vaultKey) {
        installVaultKeyFromBackup(stagedDb, manifest.vaultKey, options.passphrase);
      }
      stagedDb.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      stagedDb.close();
    }
    assertValidCompanyDb(stagedDbPath);

    if (options.liveDb) {
      const backupDirectory = join(targetCompanyDirectory, "backups");
      mkdirSync(backupDirectory, { recursive: true });
      preRestoreBackupPath = join(
        backupDirectory,
        `${backupStamp(options.now)}-pre-restore.totalcomplete`,
      );
      await createCompleteBackup({
        db: options.liveDb,
        companySlug: options.targetCompanySlug,
        companyDirectory: targetCompanyDirectory,
        destinationPath: preRestoreBackupPath,
        passphrase: options.passphrase,
        now: options.now,
      });
      options.liveDb.pragma("wal_checkpoint(TRUNCATE)");
      options.liveDb.close();
    }

    installStagedCompany(stage, targetCompanyDirectory, COMPLETE_BACKUP_SIDECARS);
    return {
      format: "complete",
      databasePath: join(targetCompanyDirectory, "company.db"),
      restoredEntries: manifest.entries.length,
      preRestoreBackupPath,
      attachmentsRestored: manifest.entries.filter((entry) => entry.role === "attachment").length,
    };
  } finally {
    safeRemove(stageRoot);
    safeRemove(materialized.temporaryDirectory);
  }
}
