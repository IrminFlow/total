import { mkdirSync } from "fs";
import { basename, join } from "path";
import type { CompanyInfo } from "@shared/domain";
import { fyFromStartYear, todayISO } from "@shared/dates";
import { formatPaise } from "@shared/money";
import type { DB } from "../db/connection";
import { atomicWriteFile } from "../atomicFile";
import { companyExportsDir } from "../paths";
import { writeAudit, verifyAuditChain } from "./audit";
import { signExportIfEnabled } from "./exportSigning";
import { writeExportPdf } from "./pdf";
import { reportHtml, type ReportRowSpec } from "./reportHtml";
import { dashboard, stockValue, trialBalance } from "./reports";
import { certificateContentSha256 } from "./migrationCertificateManifest";

export interface MigrationCertificateMetricSet {
  openingDebit: number;
  openingCredit: number;
  voucherCount: number;
  receivables: number;
  payables: number;
  stockValue: number;
  taxLiability: number;
  attachments: number;
}

export interface MigrationCertificateCheck {
  id: string;
  status: "passed" | "attention";
  statement: string;
  evidence: string;
}

interface ImportAuditEvidence {
  id: number;
  entity: string;
  at: string;
  userName: string | null;
  appVersion: string | null;
  rowHash: string;
  sourceSha256: string | null;
}

export interface MigrationReconciliationCertificateContent {
  schema: "total.migration-reconciliation-certificate";
  schemaVersion: 1;
  generatedAt: string;
  status: "checks_passed" | "attention_required";
  statement: string;
  independentAcceptance: {
    status: "not_performed";
    statement: string;
  };
  company: {
    name: string;
    gstin: string | null;
    booksFrom: number;
  };
  batch: {
    id: number;
    kind: string;
    sourceSha256: string;
    sourceBytes: number;
    appliedAt: string;
    rowCounts: {
      source: number;
      accepted: number;
      rejected: number;
    };
    retainedSummary: unknown;
    retainedSummarySha256: string;
  };
  measurement: {
    asOn: string;
    basis: string;
    metrics: MigrationCertificateMetricSet;
  };
  checks: MigrationCertificateCheck[];
  auditEvidence: {
    importEvent: ImportAuditEvidence | null;
    chain: ReturnType<typeof verifyAuditChain>;
  };
}

export type MigrationReconciliationCertificate =
  MigrationReconciliationCertificateContent & {
    contentSha256: string;
  };

interface BatchRow {
  id: number;
  kind: string;
  sourceHash: string;
  sourceBytes: number;
  sourceRows: number;
  acceptedRows: number;
  rejectedRows: number;
  summaryJson: string;
  appliedAt: string;
}

function importBatch(db: DB, batchId: number): BatchRow {
  const row = db
    .prepare(
      `SELECT id,kind,source_hash AS sourceHash,source_bytes AS sourceBytes,
              source_rows AS sourceRows,accepted_rows AS acceptedRows,rejected_rows AS rejectedRows,
              summary_json AS summaryJson,applied_at AS appliedAt
       FROM import_batches WHERE id=?`,
    )
    .get(batchId) as BatchRow | undefined;
  if (!row) throw new Error(`Import batch #${batchId} was not found`);
  return row;
}

function readRetainedSummary(row: BatchRow): unknown {
  try {
    return JSON.parse(row.summaryJson) as unknown;
  } catch {
    throw new Error(`Import batch #${row.id} has a corrupted retained summary`);
  }
}

function importAuditEvidence(
  db: DB,
  batch: BatchRow,
): ImportAuditEvidence | null {
  const expectedEntity =
    batch.kind === "tally" ? "tally_import" : "import_batch";
  const row = db
    .prepare(
      `SELECT id,entity,at,user_name AS userName,app_version AS appVersion,
              row_hash AS rowHash,after_json AS afterJson
       FROM audit_log WHERE entity_id=? AND action='import' AND entity=?
       ORDER BY id LIMIT 1`,
    )
    .get(batch.id, expectedEntity) as
    | (Omit<ImportAuditEvidence, "sourceSha256"> & { afterJson: string | null })
    | undefined;
  if (!row) return null;
  let sourceSha256: string | null = null;
  try {
    const after = JSON.parse(row.afterJson ?? "null") as Record<
      string,
      unknown
    > | null;
    if (typeof after?.sourceHash === "string") sourceSha256 = after.sourceHash;
  } catch {
    // The audit-chain check below will also flag mutated row contents; keep the event visible.
  }
  const { afterJson: _afterJson, ...evidence } = row;
  return { ...evidence, sourceSha256 };
}

function bookMetrics(
  db: DB,
  company: CompanyInfo,
  asOn: string,
): {
  metrics: MigrationCertificateMetricSet;
  trialDebit: number;
  trialCredit: number;
} {
  const trial = trialBalance(db, asOn);
  const dash = dashboard(db, asOn, fyFromStartYear(company.booksFrom).from);
  const voucherCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM vouchers
         WHERE deleted_at IS NULL AND is_optional=0 AND post_dated=0 AND date<=?`,
      )
      .get(asOn) as { count: number }
  ).count;
  const attachments = (
    db
      .prepare("SELECT COUNT(*) AS count FROM import_voucher_attachments")
      .get() as {
      count: number;
    }
  ).count;
  return {
    metrics: {
      openingDebit: trial.openingDebitTotal,
      openingCredit: trial.openingCreditTotal,
      voucherCount,
      receivables: dash.receivables,
      payables: dash.payables,
      stockValue: stockValue(db, asOn),
      taxLiability: dash.gstPayable,
      attachments,
    },
    trialDebit: trial.totalDebit,
    trialCredit: trial.totalCredit,
  };
}

/** Build the exact certificate payload without writing files. This is intentionally a self-check,
 * not an acceptance decision: expected source-system balances and a named reviewer belong in the
 * release acceptance evidence, not in an app-generated receipt. */
export function buildMigrationCertificate(
  db: DB,
  company: CompanyInfo,
  batchId: number,
  generatedAt = new Date().toISOString(),
): MigrationReconciliationCertificate {
  const batch = importBatch(db, batchId);
  const retainedSummary = readRetainedSummary(batch);
  const asOn = todayISO();
  const measurement = bookMetrics(db, company, asOn);
  const metrics = measurement.metrics;
  const auditEvent = importAuditEvidence(db, batch);
  const chain = verifyAuditChain(db);
  const checks: MigrationCertificateCheck[] = [
    {
      id: "source_identity",
      status: /^[a-f0-9]{64}$/.test(batch.sourceHash) ? "passed" : "attention",
      statement: "A SHA-256 source identity is retained with the batch.",
      evidence: batch.sourceHash,
    },
    {
      id: "row_accounting",
      status:
        batch.acceptedRows + batch.rejectedRows === batch.sourceRows
          ? "passed"
          : "attention",
      statement: "Accepted and rejected rows account for every source row.",
      evidence: `${batch.acceptedRows} accepted + ${batch.rejectedRows} rejected = ${batch.sourceRows} source`,
    },
    {
      id: "rejected_rows",
      status: batch.rejectedRows === 0 ? "passed" : "attention",
      statement: "No rejected source rows remain for follow-up.",
      evidence: `${batch.rejectedRows} rejected row(s)`,
    },
    {
      id: "trial_balance",
      status:
        measurement.trialDebit === measurement.trialCredit
          ? "passed"
          : "attention",
      statement: "The current trial balance has equal debit and credit totals.",
      evidence: `Debit ${formatPaise(measurement.trialDebit)} · Credit ${formatPaise(measurement.trialCredit)}`,
    },
    {
      id: "import_audit_event",
      status:
        auditEvent?.sourceSha256 === batch.sourceHash ? "passed" : "attention",
      statement:
        "The batch identity is linked to its tamper-evident import audit event.",
      evidence:
        auditEvent?.sourceSha256 === batch.sourceHash
          ? `Audit #${auditEvent.id} · ${auditEvent.rowHash}`
          : auditEvent
            ? `Audit #${auditEvent.id} does not retain the same source SHA-256`
            : "No matching import audit event",
    },
    {
      id: "audit_chain",
      status: chain.ok ? "passed" : "attention",
      statement:
        "The retained audit chain verified at certificate generation time.",
      evidence: chain.ok
        ? `${chain.rowsChecked} row(s) · head ${chain.headHash}`
        : `${chain.reason ?? "unknown failure"} at row ${chain.firstBrokenId ?? "unknown"}`,
    },
  ];
  const content: MigrationReconciliationCertificateContent = {
    schema: "total.migration-reconciliation-certificate",
    schemaVersion: 1,
    generatedAt,
    status: checks.every((check) => check.status === "passed")
      ? "checks_passed"
      : "attention_required",
    statement:
      "Total measured the open company's books and linked the result to this retained import batch.",
    independentAcceptance: {
      status: "not_performed",
      statement:
        "This certificate is not independent migration acceptance. A named reviewer must compare these actual metrics with the source system and approve separate acceptance evidence.",
    },
    company: {
      name: company.name,
      gstin: company.gstin,
      booksFrom: company.booksFrom,
    },
    batch: {
      id: batch.id,
      kind: batch.kind,
      sourceSha256: batch.sourceHash,
      sourceBytes: batch.sourceBytes,
      appliedAt: batch.appliedAt,
      rowCounts: {
        source: batch.sourceRows,
        accepted: batch.acceptedRows,
        rejected: batch.rejectedRows,
      },
      retainedSummary,
      retainedSummarySha256: certificateContentSha256(retainedSummary),
    },
    measurement: {
      asOn,
      basis:
        "Actual values recomputed from the open Total company. Amounts are integer paise; attachments count retained import-linked documents.",
      metrics,
    },
    checks,
    auditEvidence: { importEvent: auditEvent, chain },
  };
  return { ...content, contentSha256: certificateContentSha256(content) };
}

function certificateRows(
  certificate: MigrationReconciliationCertificate,
): ReportRowSpec[] {
  const metricLabels: Record<keyof MigrationCertificateMetricSet, string> = {
    openingDebit: "Opening debit",
    openingCredit: "Opening credit",
    voucherCount: "Voucher count",
    receivables: "Receivables",
    payables: "Payables",
    stockValue: "Stock value",
    taxLiability: "Tax liability",
    attachments: "Import-linked attachments",
  };
  const countMetrics = new Set<keyof MigrationCertificateMetricSet>([
    "voucherCount",
    "attachments",
  ]);
  const rows: ReportRowSpec[] = [
    {
      cells: ["Certificate", "Status", certificate.status.replaceAll("_", " ")],
      bold: true,
    },
    {
      cells: [
        "Identity",
        "Batch",
        `#${certificate.batch.id} · ${certificate.batch.kind}`,
      ],
    },
    { cells: ["Identity", "Source SHA-256", certificate.batch.sourceSha256] },
    {
      cells: [
        "Identity",
        "Source bytes",
        String(certificate.batch.sourceBytes),
      ],
    },
    { cells: ["Identity", "Applied", certificate.batch.appliedAt] },
    {
      cells: [
        "Rows",
        "Source / accepted / rejected",
        `${certificate.batch.rowCounts.source} / ${certificate.batch.rowCounts.accepted} / ${certificate.batch.rowCounts.rejected}`,
      ],
    },
  ];
  for (const [key, value] of Object.entries(
    certificate.measurement.metrics,
  ) as [keyof MigrationCertificateMetricSet, number][]) {
    rows.push({
      cells: [
        "Current books",
        metricLabels[key],
        countMetrics.has(key) ? String(value) : formatPaise(value),
      ],
    });
  }
  for (const check of certificate.checks) {
    rows.push({
      cells: [
        check.status === "passed" ? "Check · passed" : "Check · attention",
        check.statement,
        check.evidence,
      ],
    });
  }
  rows.push(
    {
      cells: [
        "Retained summary",
        "SHA-256",
        certificate.batch.retainedSummarySha256,
      ],
    },
    {
      cells: [
        "Retained summary",
        "Exact JSON",
        JSON.stringify(certificate.batch.retainedSummary),
      ],
    },
    {
      cells: ["Certificate", "Content SHA-256", certificate.contentSha256],
      bold: true,
      rule: true,
    },
    {
      cells: [
        "Review boundary",
        "Independent acceptance",
        certificate.independentAcceptance.statement,
      ],
      bold: true,
    },
  );
  return rows;
}

export async function exportMigrationCertificate(
  db: DB,
  company: CompanyInfo,
  slug: string,
  batchId: number,
  actor: string,
): Promise<{
  jsonPath: string;
  pdfPath: string;
  contentSha256: string;
  status: MigrationReconciliationCertificate["status"];
  signaturePaths?: { json: string; pdf: string };
}> {
  const certificate = buildMigrationCertificate(db, company, batchId);
  const stamp = certificate.generatedAt.replace(/[:.]/g, "-");
  const root = companyExportsDir(slug);
  mkdirSync(root, { recursive: true });
  const jsonPath = join(
    root,
    `migration-certificate-batch-${batchId}-${stamp}.json`,
  );
  atomicWriteFile(jsonPath, `${JSON.stringify(certificate, null, 2)}\n`);
  const html = reportHtml({
    title: "Migration reconciliation certificate",
    company,
    periodLabel: `Batch #${batchId} · measured as on ${certificate.measurement.asOn}`,
    columns: [
      { label: "Section", align: "l", width: 95 },
      { label: "Measure", align: "l", width: 180 },
      { label: "Evidence", align: "l" },
    ],
    rows: certificateRows(certificate),
    footNote: certificate.independentAcceptance.statement,
    provenance: {
      period: `Import batch #${batchId}; source applied ${certificate.batch.appliedAt}`,
      accountingBasis: "Voucher lines and opening balances; integer paise",
      dataFreshness: `Certificate ${certificate.contentSha256}`,
      generatedAt: certificate.generatedAt,
    },
  });
  const pdfPath = await writeExportPdf(
    slug,
    `migration-certificate-batch-${batchId}-${stamp}.pdf`,
    html,
    { pageSize: "A4", pageNumbers: true },
  );
  const signedJson = signExportIfEnabled(slug, jsonPath);
  const signedPdf = signExportIfEnabled(slug, pdfPath);
  writeAudit(db, "migration_certificate", batchId, "export", null, {
    actor,
    status: certificate.status,
    contentSha256: certificate.contentSha256,
    json: basename(jsonPath),
    pdf: basename(pdfPath),
    signed: Boolean(signedJson && signedPdf),
  });
  return {
    jsonPath,
    pdfPath,
    contentSha256: certificate.contentSha256,
    status: certificate.status,
    ...(signedJson && signedPdf
      ? {
          signaturePaths: {
            json: signedJson.signaturePath,
            pdf: signedPdf.signaturePath,
          },
        }
      : {}),
  };
}
