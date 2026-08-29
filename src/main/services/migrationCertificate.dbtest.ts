import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import type { CompanyInfo } from "@shared/domain";
import { writeAudit } from "./audit";
import { recordImportBatch } from "./importBatches";
import { buildMigrationCertificate } from "./migrationCertificate";
import { verifyCertificateContent } from "./migrationCertificateManifest";

const company: CompanyInfo = {
  name: "Migration Books",
  stateCode: "27",
  gstin: null,
  gstRegistrationType: "unregistered",
  address: "Mumbai",
  booksFrom: 2025,
  email: null,
  phone: null,
  pan: null,
  tan: null,
};

describe("migration import evidence receipt", () => {
  it("binds retained batch identity, current-book metrics and audit evidence", () => {
    const db = seededDb();
    const summary = {
      created: 2,
      updated: 0,
      reconciliation: { sourceRows: 2, acceptedRows: 2, rejectedRows: 0 },
    };
    const batch = recordImportBatch(db, "busy", "source,csv\n1,2", {
      sourceRows: 2,
      acceptedRows: 2,
      rejectedRows: 0,
      summary,
    });
    writeAudit(db, "import_batch", batch.id, "import", null, {
      sourceHash: batch.sourceHash,
    });

    const certificate = buildMigrationCertificate(
      db,
      company,
      batch.id,
      "2026-08-25T10:00:00.000Z",
    );

    expect(certificate).toMatchObject({
      schema: "total.migration-import-evidence",
      schemaVersion: 1,
      generatedAt: "2026-08-25T10:00:00.000Z",
      status: "internal_checks_passed",
      independentAcceptance: { status: "not_performed" },
      batch: {
        id: batch.id,
        kind: "busy",
        sourceSha256: batch.sourceHash,
        sourceBytes: Buffer.byteLength("source,csv\n1,2"),
        rowCounts: { source: 2, accepted: 2, rejected: 0 },
        retainedSummary: summary,
      },
      measurement: {
        metrics: {
          openingDebit: 0,
          openingCredit: 0,
          voucherCount: 0,
          receivables: 0,
          payables: 0,
          stockValue: 0,
          taxLiability: 0,
          attachments: 0,
        },
      },
      auditEvidence: {
        importEvent: {
          entity: "import_batch",
          sourceSha256: batch.sourceHash,
          rowHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        chain: { ok: true },
      },
    });
    expect(certificate.checks.every((check) => check.status === "passed")).toBe(
      true,
    );
    expect(verifyCertificateContent(certificate)).toBe(true);
    db.close();
  });

  it("flags unresolved rejected rows without calling the certificate accepted", () => {
    const db = seededDb();
    const batch = recordImportBatch(db, "marg", "bad,row", {
      sourceRows: 1,
      acceptedRows: 0,
      rejectedRows: 1,
      summary: { errors: [{ line: 1, message: "Missing ledger" }] },
    });
    writeAudit(db, "import_batch", batch.id, "import", null, {});
    const certificate = buildMigrationCertificate(db, company, batch.id);
    expect(certificate.status).toBe("attention_required");
    expect(
      certificate.checks.find((check) => check.id === "rejected_rows")?.status,
    ).toBe("attention");
    expect(certificate.independentAcceptance.status).toBe("not_performed");
    db.close();
  });

  it("requires attention when Tally retained non-rejected warnings", () => {
    const db = seededDb();
    const batch = recordImportBatch(db, "tally", "<ENVELOPE />", {
      sourceRows: 1,
      acceptedRows: 1,
      rejectedRows: 0,
      summary: {
        vouchers: 0,
        warnings: [
          'Ledger "Unknown party": group "Missing" not found, placed under Suspense A/c',
        ],
      },
    });
    writeAudit(db, "tally_import", batch.id, "import", null, {
      sourceHash: batch.sourceHash,
    });

    const evidence = buildMigrationCertificate(db, company, batch.id);

    expect(evidence.status).toBe("attention_required");
    expect(
      evidence.checks.find((check) => check.id === "retained_warnings"),
    ).toMatchObject({ status: "attention" });
    db.close();
  });
});
