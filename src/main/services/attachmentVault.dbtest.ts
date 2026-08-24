import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^sealed:/, ""),
  },
}));

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { postSimpleVoucher, seededDb } from "../db/testdb";
import { companyDir, ensureCompanyTree } from "../paths";
import {
  attachmentEncryptionEnabled,
  readManagedAttachment,
  setAttachmentEncryption,
  storeManagedAttachment,
} from "./attachmentVault";

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("platform-protected attachment vault", () => {
  it("encrypts new managed files and migrates retained Assist and imported paths both ways", () => {
    root = mkdtempSync(join(tmpdir(), "total-attachments-"));
    process.env.TOTAL_DATA_DIR = root;
    const slug = "vault-books";
    ensureCompanyTree(slug);
    const db = seededDb();
    const source = join(root, "invoice.png");
    writeFileSync(source, Buffer.from("private invoice bytes"));
    const assist = join(companyDir(slug), "attachments", "assist");
    mkdirSync(assist, { recursive: true });
    setAttachmentEncryption(db, slug, true, "Owner");
    const stored = storeManagedAttachment(
      db,
      slug,
      source,
      join(assist, "invoice.png"),
    );
    expect(stored).toMatch(/\.totalatt$/);
    expect(readFileSync(stored).toString("utf8")).not.toContain(
      "private invoice bytes",
    );
    expect(readManagedAttachment(db, slug, stored).toString()).toBe(
      "private invoice bytes",
    );
    db.prepare(
      `INSERT INTO ai_document_inbox(document_kind,source_path,source_hash,status,extracted_json,created_by)
       VALUES('supplier_invoice',?,?,'review','{}','Owner')`,
    ).run(stored, "a".repeat(64));
    const importedPlain = join(assist, "legacy-import.pdf");
    writeFileSync(importedPlain, Buffer.from("legacy imported evidence"));
    const voucherPlain = join(assist, "posted-voucher-receipt.jpg");
    writeFileSync(voucherPlain, Buffer.from("posted voucher evidence"));
    db.prepare(
      "INSERT INTO import_batches(kind,source_hash,source_bytes,source_rows,accepted_rows,rejected_rows,summary_json) VALUES('generic_journal',?,1,1,1,0,'{}')",
    ).run("b".repeat(64));
    const batchId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number })
        .id,
    );
    const voucher = postSimpleVoucher(db, {
      date: "2025-04-01",
      amount: 10_000,
      kind: "journal",
    });
    db.prepare(
      `INSERT INTO import_voucher_attachments(import_batch_id,voucher_id,source_filename,stored_path,sha256,linked_by)
       VALUES(? ,?,'legacy-import.pdf',?,?,'Owner')`,
    ).run(batchId, voucher.id, importedPlain, "c".repeat(64));
    db.prepare(
      `INSERT INTO voucher_attachments(voucher_id,original_name,stored_path,kind,size_bytes,added_by)
       VALUES(?,'posted-voucher-receipt.jpg',?,'receipt',?, 'Owner')`,
    ).run(voucher.id, voucherPlain, Buffer.byteLength("posted voucher evidence"));
    const encrypted = setAttachmentEncryption(db, slug, true, "Owner");
    expect(encrypted.migratedFiles).toBe(2);
    const encryptedImport = (
      db
        .prepare("SELECT stored_path AS path FROM import_voucher_attachments")
        .get() as { path: string }
    ).path;
    expect(encryptedImport).toMatch(/\.totalatt$/);
    expect(readManagedAttachment(db, slug, encryptedImport).toString()).toBe(
      "legacy imported evidence",
    );
    const encryptedVoucher = (
      db.prepare("SELECT stored_path AS path FROM voucher_attachments").get() as {
        path: string;
      }
    ).path;
    expect(encryptedVoucher).toMatch(/\.totalatt$/);
    expect(readManagedAttachment(db, slug, encryptedVoucher).toString()).toBe(
      "posted voucher evidence",
    );
    const result = setAttachmentEncryption(db, slug, false, "Owner");
    expect(result).toMatchObject({ enabled: false, migratedFiles: 3 });
    expect(attachmentEncryptionEnabled(db)).toBe(false);
    const path = (
      db.prepare("SELECT source_path AS path FROM ai_document_inbox").get() as {
        path: string;
      }
    ).path;
    expect(readFileSync(path).toString()).toBe("private invoice bytes");
    const importedPath = (
      db
        .prepare("SELECT stored_path AS path FROM import_voucher_attachments")
        .get() as { path: string }
    ).path;
    expect(readFileSync(importedPath).toString()).toBe(
      "legacy imported evidence",
    );
    const voucherPath = (
      db.prepare("SELECT stored_path AS path FROM voucher_attachments").get() as {
        path: string;
      }
    ).path;
    expect(voucherPath).not.toMatch(/\.totalatt$/);
    expect(readFileSync(voucherPath).toString()).toBe(
      "posted voucher evidence",
    );
  });

  it("rejects a managed-looking destination whose parent escapes through a symlink", () => {
    root = mkdtempSync(join(tmpdir(), "total-attachments-symlink-"));
    process.env.TOTAL_DATA_DIR = root;
    const slug = "vault-symlink-books";
    ensureCompanyTree(slug);
    const db = seededDb();
    const attachments = join(companyDir(slug), "attachments");
    const outside = join(root, "outside");
    mkdirSync(attachments, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(attachments, "escape"), "dir");
    const source = join(root, "receipt.pdf");
    writeFileSync(source, "private evidence");

    expect(() =>
      storeManagedAttachment(db, slug, source, join(attachments, "escape", "receipt.pdf")),
    ).toThrow(/outside|symbolic/i);
    expect(() => readFileSync(join(outside, "receipt.pdf"))).toThrow();
  });
});
