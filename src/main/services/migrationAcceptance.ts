import { createHash } from "crypto";
import type { MigrationReconciliationCertificate } from "./migrationCertificate";
import { certificateContentSha256 } from "./migrationCertificateManifest";

export interface MigrationExpectedResult {
  voucherCount: number;
  sourceRows: number;
  acceptedRows: number;
  rejectedRows: number;
  totalDebitPaise: number;
  totalCreditPaise: number;
}

export interface MigrationObservedResult extends MigrationExpectedResult {
  sourceSha256: string;
}

export interface MigrationComparison {
  metric: keyof MigrationExpectedResult | "sourceSha256" | "internalCertificate";
  expected: number | string;
  actual: number | string;
  difference: number | null;
  status: "passed" | "failed";
  explanation: string;
}

export interface AutomatedMigrationAcceptance {
  schema: "total.synthetic-migration-acceptance";
  schemaVersion: 1;
  generatedAt: string;
  fixtureId: string;
  scope: "synthetic_fixture_only";
  status: "passed" | "failed";
  statement: string;
  source: {
    fileName: string;
    sha256: string;
    normalizedSha256: string;
    normalization: "mapping_profile" | "none";
  };
  importCertificate: { batchId: number; contentSha256: string; status: string };
  comparisons: MigrationComparison[];
  contentSha256: string;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function compareNumber(
  metric: keyof MigrationExpectedResult,
  expected: number,
  actual: number,
): MigrationComparison {
  const difference = actual - expected;
  return {
    metric,
    expected,
    actual,
    difference,
    status: difference === 0 ? "passed" : "failed",
    explanation:
      difference === 0
        ? `${metric} matches the fixture source.`
        : `${metric} differs by ${difference}; inspect rejected rows, mappings and source totals.`,
  };
}

export function buildAutomatedMigrationAcceptance(input: {
  fixtureId: string;
  fileName: string;
  sourceText: string;
  normalizedText?: string;
  expected: MigrationExpectedResult;
  observed: MigrationObservedResult;
  certificate: MigrationReconciliationCertificate;
  generatedAt?: string;
}): AutomatedMigrationAcceptance {
  const comparisons: MigrationComparison[] = (
    Object.keys(input.expected) as (keyof MigrationExpectedResult)[]
  ).map((metric) =>
    compareNumber(metric, input.expected[metric], input.observed[metric]),
  );
  const selectedSourceSha256 = sha256Text(input.sourceText);
  const normalizedSourceSha256 = sha256Text(
    input.normalizedText ?? input.sourceText,
  );
  comparisons.push({
    metric: "sourceSha256",
    expected: selectedSourceSha256,
    actual: input.observed.sourceSha256,
    difference: null,
    status:
      selectedSourceSha256 === input.observed.sourceSha256 ? "passed" : "failed",
    explanation:
      selectedSourceSha256 === input.observed.sourceSha256
        ? "The retained import bytes match the original source-system payload."
        : "The retained import bytes do not match the original source-system payload; rerun from the retained source file.",
  });
  comparisons.push({
    metric: "internalCertificate",
    expected: "internal_checks_passed",
    actual: input.certificate.status,
    difference: null,
    status:
      input.certificate.status === "internal_checks_passed" ? "passed" : "failed",
    explanation:
      input.certificate.status === "internal_checks_passed"
        ? "Total's batch identity, row accounting, trial balance and audit-chain checks passed."
        : "The internal import certificate requires attention; inspect its failed checks before acceptance.",
  });
  const status: AutomatedMigrationAcceptance["status"] = comparisons.every(
    (comparison) => comparison.status === "passed",
  )
    ? "passed"
    : "failed";
  const content: Omit<AutomatedMigrationAcceptance, "contentSha256"> = {
    schema: "total.synthetic-migration-acceptance" as const,
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    fixtureId: input.fixtureId,
    scope: "synthetic_fixture_only" as const,
    status,
    statement:
      "This automated result proves the importer contract against synthetic data. It does not replace reconciliation of a representative export from the customer's source system.",
    source: {
      fileName: input.fileName,
      sha256: selectedSourceSha256,
      normalizedSha256: normalizedSourceSha256,
      normalization: input.normalizedText === undefined ? "none" : "mapping_profile",
    },
    importCertificate: {
      batchId: input.certificate.batch.id,
      contentSha256: input.certificate.contentSha256,
      status: input.certificate.status,
    },
    comparisons,
  };
  return { ...content, contentSha256: certificateContentSha256(content) };
}
