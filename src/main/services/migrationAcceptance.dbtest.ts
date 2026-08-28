import { readFileSync } from "fs";
import { basename, join } from "path";
import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { applyImport } from "./importers";
import { buildAutomatedMigrationAcceptance } from "./migrationAcceptance";
import { buildMigrationCertificate } from "./migrationCertificate";
import { applyImportWithProfile, applyMappingProfile, listMappingProfiles } from "./migrationTools";

interface FixtureManifest {
  fixtures: Array<{
    id: string;
    file: string;
    profile: string | null;
    expected: {
      voucherCount: number;
      sourceRows: number;
      acceptedRows: number;
      rejectedRows: number;
      totalDebitPaise: number;
      totalCreditPaise: number;
    };
  }>;
}

const fixtureRoot = join(process.cwd(), "test", "fixtures", "migrations");
const manifest = JSON.parse(
  readFileSync(join(fixtureRoot, "manifest.json"), "utf8"),
) as FixtureManifest;
const company = {
  name: "Synthetic Migration Books",
  gstin: null,
  stateCode: "27",
  address: "",
  email: null,
  phone: null,
  pan: null,
  tan: null,
  booksFrom: 2026,
  gstRegistrationType: "unregistered" as const,
};

describe("synthetic source migration acceptance", () => {
  for (const fixture of manifest.fixtures) {
    it(`reconciles ${fixture.id} and emits a checksummed certificate`, () => {
      const db = seededDb();
      const salesGroup = db
        .prepare("SELECT id FROM groups WHERE name='Sales Accounts'")
        .get() as { id: number };
      db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Sales Account',?)").run(
        salesGroup.id,
      );
      const sourceText = readFileSync(join(fixtureRoot, fixture.file), "utf8");
      const profile = fixture.profile
        ? listMappingProfiles(db).find((candidate) => candidate.name === fixture.profile)!
        : null;
      const normalized = profile
        ? applyMappingProfile(sourceText, profile)
        : sourceText;
      const imported = profile
        ? applyImportWithProfile(db, sourceText, profile)
        : applyImport(db, "generic_journal", normalized);
      const totals = db
        .prepare(
          `SELECT COUNT(DISTINCT v.id) AS voucherCount,
                  COALESCE(SUM(CASE WHEN vl.dr_cr='dr' THEN vl.amount ELSE 0 END),0) AS totalDebitPaise,
                  COALESCE(SUM(CASE WHEN vl.dr_cr='cr' THEN vl.amount ELSE 0 END),0) AS totalCreditPaise
           FROM vouchers v JOIN voucher_lines vl ON vl.voucher_id=v.id
           WHERE v.deleted_at IS NULL`,
        )
        .get() as {
        voucherCount: number;
        totalDebitPaise: number;
        totalCreditPaise: number;
      };
      const certificate = buildMigrationCertificate(
        db,
        company,
        imported.batchId,
        "2026-08-28T00:00:00.000Z",
      );
      const acceptance = buildAutomatedMigrationAcceptance({
        fixtureId: fixture.id,
        fileName: basename(fixture.file),
        sourceText,
        ...(fixture.profile ? { normalizedText: normalized } : {}),
        expected: fixture.expected,
        observed: {
          voucherCount: totals.voucherCount,
          sourceRows: imported.reconciliation.sourceRows,
          acceptedRows: imported.reconciliation.acceptedRows,
          rejectedRows: imported.reconciliation.rejectedRows,
          totalDebitPaise: totals.totalDebitPaise,
          totalCreditPaise: totals.totalCreditPaise,
          sourceSha256: imported.sourceHash,
        },
        certificate,
        generatedAt: "2026-08-28T00:00:01.000Z",
      });
      expect(acceptance.status).toBe("passed");
      expect(acceptance.comparisons.every((row) => row.status === "passed")).toBe(true);
      expect(acceptance.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      db.close();
    });
  }

  it("explains a source-to-book difference instead of certifying it", () => {
    const fixture = manifest.fixtures[0]!;
    const db = seededDb();
    const certificate = {
      status: "internal_checks_passed",
      batch: { id: 1 },
      contentSha256: "a".repeat(64),
    } as ReturnType<typeof buildMigrationCertificate>;
    const acceptance = buildAutomatedMigrationAcceptance({
      fixtureId: fixture.id,
      fileName: fixture.file,
      sourceText: "source",
      expected: fixture.expected,
      observed: {
        ...fixture.expected,
        voucherCount: fixture.expected.voucherCount + 1,
        sourceSha256: "b".repeat(64),
      },
      certificate,
    });
    expect(acceptance.status).toBe("failed");
    expect(acceptance.comparisons.find((row) => row.metric === "voucherCount")?.explanation).toContain("differs by 1");
    db.close();
  });
});
