import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DB } from "../db/connection";
import { encryptFile } from "../db/crypt";
import { companyExportsDir } from "../paths";
import type {
  ControlReport,
  DepartmentBoundary,
  ExportFormat,
  ExportPermissionMatrix,
  PeriodSignoff,
  PolicyException,
  PolicyKind,
  RetentionPolicy,
  ReviewPriority,
  ReviewQuestion,
  ReviewStatus,
  SessionRecord,
} from "@shared/internalControls";
import { writeAudit } from "./audit";
import type { Role } from "./roles";
import { IN_BOOKS, requireInBooksVoucher } from "./vouchers";

type AnyRow = Record<string, unknown>;
const parseArray = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
};

function mapReview(row: AnyRow): ReviewQuestion {
  return {
    id: Number(row.id),
    voucherId: Number(row.voucher_id),
    voucherNumber: String(row.voucher_number),
    voucherDate: String(row.voucher_date),
    question: String(row.question),
    assignedToUserId:
      row.assigned_to_user_id == null ? null : Number(row.assigned_to_user_id),
    assignedToName:
      row.assigned_to_name == null ? null : String(row.assigned_to_name),
    dueDate: row.due_date == null ? null : String(row.due_date),
    priority: row.priority as ReviewPriority,
    status: row.status as ReviewStatus,
    answer: row.answer == null ? null : String(row.answer),
    createdBy: String(row.created_by),
    answeredBy: row.answered_by == null ? null : String(row.answered_by),
    resolvedBy: row.resolved_by == null ? null : String(row.resolved_by),
    createdAt: String(row.created_at),
    answeredAt: row.answered_at == null ? null : String(row.answered_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    updatedAt: String(row.updated_at),
  };
}

export function listReviewQuestions(
  db: DB,
  status?: ReviewStatus,
): ReviewQuestion[] {
  const rows = db
    .prepare(
      `SELECT q.*, v.number voucher_number, v.date voucher_date, u.name assigned_to_name
    FROM review_questions q JOIN vouchers v ON v.id=q.voucher_id LEFT JOIN users u ON u.id=q.assigned_to_user_id
    WHERE ${IN_BOOKS} ${status ? "AND q.status=?" : ""}
    ORDER BY CASE q.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
    CASE q.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
    CASE WHEN q.due_date IS NULL THEN 1 ELSE 0 END,q.due_date,q.id DESC`,
    )
    .all(...(status ? [status] : [])) as AnyRow[];
  return rows.map(mapReview);
}

export function createReviewQuestion(
  db: DB,
  input: {
    voucherId: number;
    question: string;
    assignedToUserId: number | null;
    dueDate: string | null;
    priority: ReviewPriority;
  },
  actor: string,
): ReviewQuestion {
  requireInBooksVoucher(db, input.voucherId);
  if (
    input.assignedToUserId &&
    !db
      .prepare("SELECT 1 FROM users WHERE id=? AND active=1")
      .get(input.assignedToUserId)
  )
    throw new Error("Assignee is not active");
  const result = db
    .prepare(
      `INSERT INTO review_questions(voucher_id,question,assigned_to_user_id,due_date,priority,created_by) VALUES(?,?,?,?,?,?)`,
    )
    .run(
      input.voucherId,
      input.question.trim(),
      input.assignedToUserId,
      input.dueDate,
      input.priority,
      actor,
    );
  const after = listReviewQuestions(db).find(
    (row) => row.id === Number(result.lastInsertRowid),
  )!;
  writeAudit(db, "review_question", after.id, "create", null, after);
  return after;
}

export function answerReviewQuestion(
  db: DB,
  id: number,
  answer: string,
  actor: string,
): ReviewQuestion {
  const before = listReviewQuestions(db).find((row) => row.id === id);
  if (!before) throw new Error("Review question not found");
  if (before.status !== "open")
    throw new Error("Only open questions can be answered");
  db.prepare(
    `UPDATE review_questions SET status='answered',answer=?,answered_by=?,answered_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
  ).run(answer.trim(), actor, id);
  const after = listReviewQuestions(db).find((row) => row.id === id)!;
  writeAudit(db, "review_question", id, "update", before, after);
  return after;
}

export function resolveReviewQuestion(
  db: DB,
  id: number,
  actor: string,
): ReviewQuestion {
  const before = listReviewQuestions(db).find((row) => row.id === id);
  if (!before) throw new Error("Review question not found");
  if (before.status !== "answered")
    throw new Error("Answer the question before resolving it");
  if (before.answeredBy === actor)
    throw new Error("A different user must resolve the answer");
  db.prepare(
    `UPDATE review_questions SET status='resolved',resolved_by=?,resolved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
  ).run(actor, id);
  const after = listReviewQuestions(db).find((row) => row.id === id)!;
  writeAudit(db, "review_question", id, "update", before, after);
  return after;
}

function mapSignoff(row: AnyRow): PeriodSignoff {
  return {
    id: Number(row.id),
    periodFrom: String(row.period_from),
    periodTo: String(row.period_to),
    status: row.status as PeriodSignoff["status"],
    outstandingIssues: parseArray(row.outstanding_issues_json),
    evidence: parseArray(row.evidence_json),
    preparedBy: row.prepared_by == null ? null : String(row.prepared_by),
    preparedAt: row.prepared_at == null ? null : String(row.prepared_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
    reviewNote: row.review_note == null ? null : String(row.review_note),
    reopenedBy: row.reopened_by == null ? null : String(row.reopened_by),
    reopenedAt: row.reopened_at == null ? null : String(row.reopened_at),
    updatedAt: String(row.updated_at),
  };
}
export function getPeriodSignoff(
  db: DB,
  from: string,
  to: string,
): PeriodSignoff | null {
  const row = db
    .prepare(
      "SELECT * FROM period_signoffs WHERE period_from=? AND period_to=?",
    )
    .get(from, to) as AnyRow | undefined;
  return row ? mapSignoff(row) : null;
}
export function preparePeriodSignoff(
  db: DB,
  input: {
    from: string;
    to: string;
    outstandingIssues: string[];
    evidence: string[];
  },
  actor: string,
): PeriodSignoff {
  const before = getPeriodSignoff(db, input.from, input.to);
  if (before?.status === "reviewed")
    throw new Error("Reopen the reviewed sign-off before changing it");
  db.prepare(
    `INSERT INTO period_signoffs(period_from,period_to,status,outstanding_issues_json,evidence_json,prepared_by,prepared_at)
    VALUES(?,?,'prepared',?,?,?,datetime('now')) ON CONFLICT(period_from,period_to) DO UPDATE SET status='prepared',outstanding_issues_json=excluded.outstanding_issues_json,evidence_json=excluded.evidence_json,prepared_by=excluded.prepared_by,prepared_at=datetime('now'),reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,updated_at=datetime('now')`,
  ).run(
    input.from,
    input.to,
    JSON.stringify(input.outstandingIssues),
    JSON.stringify(input.evidence),
    actor,
  );
  const after = getPeriodSignoff(db, input.from, input.to)!;
  writeAudit(
    db,
    "period_signoff",
    after.id,
    before ? "update" : "create",
    before,
    after,
  );
  return after;
}
export function reviewPeriodSignoff(
  db: DB,
  from: string,
  to: string,
  note: string,
  actor: string,
): PeriodSignoff {
  const before = getPeriodSignoff(db, from, to);
  if (!before || before.status !== "prepared")
    throw new Error("Prepare this period before review");
  if (before.preparedBy === actor)
    throw new Error("Preparer and reviewer must be different users");
  db.prepare(
    `UPDATE period_signoffs SET status='reviewed',reviewed_by=?,reviewed_at=datetime('now'),review_note=?,updated_at=datetime('now') WHERE id=?`,
  ).run(actor, note.trim() || null, before.id);
  const after = getPeriodSignoff(db, from, to)!;
  writeAudit(db, "period_signoff", after.id, "update", before, after);
  return after;
}
export function reopenPeriodSignoff(
  db: DB,
  from: string,
  to: string,
  reason: string,
  actor: string,
): PeriodSignoff {
  const before = getPeriodSignoff(db, from, to);
  if (!before || before.status !== "reviewed")
    throw new Error("Only a reviewed sign-off can be reopened");
  db.prepare(
    `UPDATE period_signoffs SET status='reopened',reopened_by=?,reopened_at=datetime('now'),review_note=?,updated_at=datetime('now') WHERE id=?`,
  ).run(actor, reason.trim(), before.id);
  const after = getPeriodSignoff(db, from, to)!;
  writeAudit(db, "period_signoff", after.id, "update", before, after);
  return after;
}

const formats: ExportFormat[] = [
  "pdf",
  "spreadsheet",
  "json_mirror",
  "full_data",
];
const roles: Role[] = ["owner", "accountant", "viewer"];
export function getExportPermissions(db: DB): ExportPermissionMatrix {
  const out = {} as ExportPermissionMatrix;
  for (const role of roles)
    out[role] = {
      pdf: false,
      spreadsheet: false,
      json_mirror: false,
      full_data: false,
    };
  for (const row of db
    .prepare("SELECT role,format,allowed FROM export_permissions")
    .all() as { role: Role; format: ExportFormat; allowed: number }[])
    out[row.role][row.format] = !!row.allowed;
  return out;
}
export function setExportPermissions(
  db: DB,
  matrix: ExportPermissionMatrix,
): ExportPermissionMatrix {
  const before = getExportPermissions(db);
  db.transaction(() => {
    for (const role of roles)
      for (const format of formats)
        db.prepare(
          `INSERT INTO export_permissions(role,format,allowed) VALUES(?,?,?) ON CONFLICT(role,format) DO UPDATE SET allowed=excluded.allowed`,
        ).run(
          role,
          format,
          role === "owner" ? 1 : matrix[role][format] ? 1 : 0,
        );
  })();
  const after = getExportPermissions(db);
  writeAudit(db, "export_permissions", 0, "update", before, after);
  return after;
}
export function exportAllowed(
  db: DB,
  role: Role,
  format: ExportFormat,
): boolean {
  return getExportPermissions(db)[role][format];
}

export function openSession(
  db: DB,
  userId: number,
  token: string,
  at = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO user_sessions(session_token,user_id,signed_in_at,last_activity_at) VALUES(?,?,?,?)`,
  ).run(token, userId, at, at);
}
export function touchSession(db: DB, token: string): void {
  db.prepare(
    `UPDATE user_sessions SET last_activity_at=datetime('now') WHERE session_token=? AND lock_state='active'`,
  ).run(token);
}
export function closeSession(
  db: DB,
  token: string,
  state: "locked" | "signed_out" | "expired",
): void {
  db.prepare(
    `UPDATE user_sessions SET lock_state=?,signed_out_at=datetime('now'),last_activity_at=datetime('now') WHERE session_token=? AND lock_state='active'`,
  ).run(state, token);
}
export function listSessions(db: DB): SessionRecord[] {
  return db
    .prepare(
      `SELECT s.id,s.user_id userId,u.name userName,u.role,s.signed_in_at signedInAt,s.last_activity_at lastActivityAt,s.signed_out_at signedOutAt,s.lock_state lockState FROM user_sessions s JOIN users u ON u.id=s.user_id ORDER BY s.last_activity_at DESC LIMIT 100`,
    )
    .all() as SessionRecord[];
}

function mapException(row: AnyRow): PolicyException {
  return {
    id: Number(row.id),
    policyKind: row.policy_kind as PolicyKind,
    entityType: String(row.entity_type),
    entityId: row.entity_id == null ? null : Number(row.entity_id),
    reason: String(row.reason),
    status: row.status as PolicyException["status"],
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    decisionNote: row.decision_note == null ? null : String(row.decision_note),
    usedAt: row.used_at == null ? null : String(row.used_at),
  };
}
export function listPolicyExceptions(
  db: DB,
  status?: PolicyException["status"],
): PolicyException[] {
  return (
    db
      .prepare(
        `SELECT * FROM policy_exceptions ${status ? "WHERE status=?" : ""} ORDER BY requested_at DESC,id DESC`,
      )
      .all(...(status ? [status] : [])) as AnyRow[]
  ).map(mapException);
}
export function requestPolicyException(
  db: DB,
  input: {
    policyKind: PolicyKind;
    entityType: string;
    entityId: number | null;
    reason: string;
  },
  actor: string,
): PolicyException {
  const id = Number(
    db
      .prepare(
        `INSERT INTO policy_exceptions(policy_kind,entity_type,entity_id,reason,requested_by) VALUES(?,?,?,?,?)`,
      )
      .run(
        input.policyKind,
        input.entityType,
        input.entityId,
        input.reason.trim(),
        actor,
      ).lastInsertRowid,
  );
  const after = listPolicyExceptions(db).find((r) => r.id === id)!;
  writeAudit(db, "policy_exception", id, "create", null, after);
  return after;
}
export function decidePolicyException(
  db: DB,
  id: number,
  approved: boolean,
  note: string,
  actor: string,
): PolicyException {
  const before = listPolicyExceptions(db).find((r) => r.id === id);
  if (!before || before.status !== "pending")
    throw new Error("Pending policy exception not found");
  if (before.requestedBy === actor)
    throw new Error("Requester cannot approve their own exception");
  db.prepare(
    `UPDATE policy_exceptions SET status=?,decided_by=?,decided_at=datetime('now'),decision_note=? WHERE id=?`,
  ).run(approved ? "approved" : "rejected", actor, note.trim() || null, id);
  const after = listPolicyExceptions(db).find((r) => r.id === id)!;
  writeAudit(db, "policy_exception", id, "update", before, after);
  return after;
}
export function usePolicyException(
  db: DB,
  id: number,
  kind: PolicyKind,
  actor: string,
): PolicyException {
  const before = listPolicyExceptions(db).find((r) => r.id === id);
  if (!before || before.status !== "approved" || before.policyKind !== kind)
    throw new Error(
      `An approved ${kind.replace("_", " ")} exception is required`,
    );
  db.prepare(
    `UPDATE policy_exceptions SET status='used',used_at=datetime('now') WHERE id=?`,
  ).run(id);
  const after = listPolicyExceptions(db).find((r) => r.id === id)!;
  writeAudit(db, "policy_exception", id, "update", before, {
    ...after,
    usedBy: actor,
  });
  return after;
}

export function listBoundaries(db: DB): DepartmentBoundary[] {
  return (
    db
      .prepare(
        `SELECT b.*,CASE b.dimension_kind WHEN 'cost_centre' THEN (SELECT name FROM cost_centres WHERE id=b.dimension_id) WHEN 'godown' THEN (SELECT name FROM godowns WHERE id=b.dimension_id) ELSE (SELECT name FROM voucher_types WHERE id=b.dimension_id) END dimension_name FROM department_boundaries b ORDER BY b.role,b.dimension_kind,dimension_name`,
      )
      .all() as AnyRow[]
  ).map((r) => ({
    id: Number(r.id),
    role: r.role as "accountant" | "viewer",
    dimensionKind: r.dimension_kind as DepartmentBoundary["dimensionKind"],
    dimensionId: Number(r.dimension_id),
    dimensionName: String(r.dimension_name ?? `#${r.dimension_id}`),
    allowed: !!r.allowed,
  }));
}
export function setBoundary(
  db: DB,
  input: {
    role: "accountant" | "viewer";
    dimensionKind: DepartmentBoundary["dimensionKind"];
    dimensionId: number;
    allowed: boolean;
  },
  actor: string,
): DepartmentBoundary[] {
  const before = listBoundaries(db);
  db.prepare(
    `INSERT INTO department_boundaries(role,dimension_kind,dimension_id,allowed) VALUES(?,?,?,?) ON CONFLICT(role,dimension_kind,dimension_id) DO UPDATE SET allowed=excluded.allowed`,
  ).run(
    input.role,
    input.dimensionKind,
    input.dimensionId,
    input.allowed ? 1 : 0,
  );
  const after = listBoundaries(db);
  writeAudit(
    db,
    "department_boundary",
    input.dimensionId,
    "update",
    before,
    after,
  );
  return after;
}
export function boundaryAllows(
  db: DB,
  role: Role,
  kind: DepartmentBoundary["dimensionKind"],
  id: number,
): boolean {
  if (role === "owner") return true;
  const rows = db
    .prepare(
      `SELECT dimension_id id,allowed FROM department_boundaries WHERE role=? AND dimension_kind=?`,
    )
    .all(role, kind) as { id: number; allowed: number }[];
  if (rows.length === 0) return true;
  return rows.some((row) => row.id === id && !!row.allowed);
}

export function listRetentionPolicies(db: DB): RetentionPolicy[] {
  return (
    db
      .prepare(
        `SELECT p.*,CASE p.evidence_kind WHEN 'review_questions' THEN (SELECT COUNT(*) FROM review_questions WHERE p.keep_days IS NOT NULL AND created_at <= datetime('now','-'||p.keep_days||' days','+'||p.warn_days||' days')) WHEN 'signoffs' THEN (SELECT COUNT(*) FROM period_signoffs WHERE p.keep_days IS NOT NULL AND updated_at <= datetime('now','-'||p.keep_days||' days','+'||p.warn_days||' days')) WHEN 'review_bundles' THEN (SELECT COUNT(*) FROM review_bundle_exports WHERE p.keep_days IS NOT NULL AND created_at <= datetime('now','-'||p.keep_days||' days','+'||p.warn_days||' days')) WHEN 'audit' THEN (SELECT COUNT(*) FROM audit_log WHERE p.keep_days IS NOT NULL AND at <= datetime('now','-'||p.keep_days||' days','+'||p.warn_days||' days')) ELSE 0 END warning_count FROM evidence_retention_policies p ORDER BY evidence_kind`,
      )
      .all() as AnyRow[]
  ).map((r) => ({
    evidenceKind: r.evidence_kind as RetentionPolicy["evidenceKind"],
    keepDays: r.keep_days == null ? null : Number(r.keep_days),
    warnDays: Number(r.warn_days),
    purgeRequiresApproval: !!r.purge_requires_approval,
    updatedBy: String(r.updated_by),
    updatedAt: String(r.updated_at),
    warningCount: Number(r.warning_count),
  }));
}
export function setRetentionPolicy(
  db: DB,
  input: {
    evidenceKind: RetentionPolicy["evidenceKind"];
    keepDays: number | null;
    warnDays: number;
    purgeRequiresApproval: boolean;
  },
  actor: string,
): RetentionPolicy[] {
  const before = listRetentionPolicies(db);
  db.prepare(
    `UPDATE evidence_retention_policies SET keep_days=?,warn_days=?,purge_requires_approval=?,updated_by=?,updated_at=datetime('now') WHERE evidence_kind=?`,
  ).run(
    input.keepDays,
    input.warnDays,
    input.purgeRequiresApproval ? 1 : 0,
    actor,
    input.evidenceKind,
  );
  const after = listRetentionPolicies(db);
  writeAudit(db, "retention_policy", 0, "update", before, after);
  return after;
}

export function controlReport(db: DB, from: string, to: string): ControlReport {
  const scalar = (sql: string, ...params: unknown[]) =>
    Number((db.prepare(sql).get(...params) as { n: number }).n);
  const exactSignoff = getPeriodSignoff(db, from, to);
  const latestContained = exactSignoff
    ? null
    : (db
        .prepare(
          `SELECT * FROM period_signoffs WHERE period_from >= ? AND period_to <= ? ORDER BY period_to DESC,id DESC LIMIT 1`,
        )
        .get(from, to) as AnyRow | undefined);
  const signoff =
    exactSignoff ?? (latestContained ? mapSignoff(latestContained) : null);
  return {
    from,
    to,
    overrides: scalar(
      `SELECT COUNT(*) n FROM policy_exceptions WHERE status IN ('approved','used') AND date(COALESCE(decided_at,requested_at)) BETWEEN ? AND ?`,
      from,
      to,
    ),
    deletedDrafts: scalar(
      `SELECT COUNT(*) n FROM audit_log WHERE entity='voucher_draft' AND action='delete' AND date(at) BETWEEN ? AND ?`,
      from,
      to,
    ),
    reversals: scalar(
      `SELECT COUNT(*) n FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND (v.narration LIKE '%reversal%' OR v.narration LIKE '%reversed%')`,
      from,
      to,
    ),
    latePostings: scalar(
      `SELECT COUNT(*) n FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND julianday(date(v.created_at))-julianday(v.date)>7`,
      from,
      to,
    ),
    privilegedActions: scalar(
      `SELECT COUNT(*) n FROM audit_log WHERE date(at) BETWEEN ? AND ? AND (entity IN ('permission_matrix','export_permissions','user','department_boundary','retention_policy') OR action IN ('delete'))`,
      from,
      to,
    ),
    openQuestions: scalar(
      `SELECT COUNT(*) n FROM review_questions q JOIN vouchers v ON v.id=q.voucher_id WHERE q.status IN ('open','answered') AND ${IN_BOOKS}`,
    ),
    overdueQuestions: scalar(
      `SELECT COUNT(*) n FROM review_questions q JOIN vouchers v ON v.id=q.voucher_id WHERE q.status IN ('open','answered') AND q.due_date<date('now') AND ${IN_BOOKS}`,
    ),
    pendingExceptions: scalar(
      `SELECT COUNT(*) n FROM policy_exceptions WHERE status='pending'`,
    ),
    periodSignoffStatus: signoff?.status ?? "not_started",
    recentExceptions: listPolicyExceptions(db).slice(0, 10),
  };
}

export async function exportReviewBundle(
  db: DB,
  slug: string,
  from: string,
  to: string,
  passphrase: string,
  actor: string,
): Promise<{ path: string; questionCount: number; evidenceCount: number }> {
  const questions = listReviewQuestions(db).filter(
    (q) => q.voucherDate >= from && q.voucherDate <= to,
  );
  const signoff = getPeriodSignoff(db, from, to);
  const audits = db
    .prepare(
      `SELECT entity,entity_id entityId,action,at,user_name userName,before_json beforeJson,after_json afterJson FROM audit_log WHERE date(at) BETWEEN ? AND ? ORDER BY id`,
    )
    .all(from, to);
  const payload = {
    schema: "total.review-bundle.v1",
    period: { from, to },
    exportedAt: new Date().toISOString(),
    questions,
    signoff,
    audit: audits,
  };
  const dir = mkdtempSync(join(tmpdir(), "total-review-"));
  const plain = join(dir, "review-bundle.json");
  writeFileSync(plain, JSON.stringify(payload, null, 2), "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(
    companyExportsDir(slug),
    `review-bundle-${from}-${to}-${stamp}.totalreview`,
  );
  await encryptFile(plain, path, passphrase);
  rmSync(dir, { recursive: true, force: true });
  const evidenceCount = (signoff?.evidence.length ?? 0) + audits.length;
  const id = Number(
    db
      .prepare(
        `INSERT INTO review_bundle_exports(period_from,period_to,path,question_count,evidence_count,created_by) VALUES(?,?,?,?,?,?)`,
      )
      .run(from, to, path, questions.length, evidenceCount, actor)
      .lastInsertRowid,
  );
  writeAudit(db, "review_bundle", id, "export", null, {
    from,
    to,
    path,
    questionCount: questions.length,
    evidenceCount,
  });
  return { path, questionCount: questions.length, evidenceCount };
}
