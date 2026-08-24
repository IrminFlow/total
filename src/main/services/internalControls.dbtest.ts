import { describe, expect, it } from "vitest";
import { postSimpleVoucher, seededDb } from "../db/testdb";
import { saveUser } from "./users";
import {
  answerReviewQuestion,
  closeSession,
  controlReport,
  createReviewQuestion,
  decidePolicyException,
  boundaryAllows,
  getExportPermissions,
  getPeriodSignoff,
  listPolicyExceptions,
  listRetentionPolicies,
  listSessions,
  openSession,
  preparePeriodSignoff,
  requestPolicyException,
  resolveReviewQuestion,
  reviewPeriodSignoff,
  setBoundary,
  setExportPermissions,
  setRetentionPolicy,
  touchSession,
} from "./internalControls";

describe("collaboration and internal controls", () => {
  it("runs voucher questions through answer and independent resolution", () => {
    const db = seededDb();
    saveUser(db, { name: "Owner", role: "owner", pin: "1111" });
    const assignee = saveUser(db, {
      name: "Asha",
      role: "accountant",
      pin: "2222",
    });
    const voucher = postSimpleVoucher(db, {
      kind: "journal",
      date: "2026-08-20",
      amount: 125_000,
    });
    const question = createReviewQuestion(
      db,
      {
        voucherId: voucher.id,
        question: "Please attach the approval evidence",
        assignedToUserId: assignee.id,
        dueDate: "2026-08-25",
        priority: "urgent",
      },
      "Owner",
    );
    expect(question).toMatchObject({
      voucherId: voucher.id,
      assignedToName: "Asha",
      status: "open",
    });
    const answered = answerReviewQuestion(
      db,
      question.id,
      "Approval mail attached to the source file.",
      "Asha",
    );
    expect(answered.status).toBe("answered");
    expect(() => resolveReviewQuestion(db, question.id, "Asha")).toThrow(
      "different user",
    );
    expect(resolveReviewQuestion(db, question.id, "Owner")).toMatchObject({
      status: "resolved",
      resolvedBy: "Owner",
    });
  });

  it("requires independent period preparation and review and retains evidence", () => {
    const db = seededDb();
    const prepared = preparePeriodSignoff(
      db,
      {
        from: "2026-08-01",
        to: "2026-08-31",
        outstandingIssues: ["One advisory GST warning"],
        evidence: ["backup-2026-08-31.totalbak"],
      },
      "Asha",
    );
    expect(prepared).toMatchObject({ status: "prepared", preparedBy: "Asha" });
    expect(() =>
      reviewPeriodSignoff(db, "2026-08-01", "2026-08-31", "Checked", "Asha"),
    ).toThrow("different users");
    const reviewed = reviewPeriodSignoff(
      db,
      "2026-08-01",
      "2026-08-31",
      "Warning is documented and non-blocking.",
      "Owner",
    );
    expect(reviewed).toMatchObject({
      status: "reviewed",
      reviewedBy: "Owner",
      evidence: ["backup-2026-08-31.totalbak"],
    });
    expect(
      getPeriodSignoff(db, "2026-08-01", "2026-08-31")?.reviewNote,
    ).toContain("non-blocking");
  });

  it("separates export formats and keeps owner recovery rights immutable", () => {
    const db = seededDb();
    const matrix = getExportPermissions(db);
    matrix.accountant.json_mirror = true;
    matrix.viewer.pdf = true;
    matrix.owner.full_data = false;
    const saved = setExportPermissions(db, matrix);
    expect(saved.accountant.json_mirror).toBe(true);
    expect(saved.viewer.pdf).toBe(true);
    expect(saved.owner.full_data).toBe(true);
  });

  it("tracks shared-device sessions and enforces an explicit close state", () => {
    const db = seededDb();
    const owner = saveUser(db, { name: "Owner", role: "owner", pin: "1111" });
    openSession(db, owner.id, "session-a", "2026-08-24T09:00:00.000Z");
    touchSession(db, "session-a");
    expect(listSessions(db)[0]).toMatchObject({
      userName: "Owner",
      lockState: "active",
    });
    closeSession(db, "session-a", "locked");
    expect(listSessions(db)[0]).toMatchObject({
      lockState: "locked",
      signedOutAt: expect.any(String),
    });
  });

  it("turns configured department dimensions into an allow-list", () => {
    const db = seededDb();
    const types = db
      .prepare("SELECT id FROM voucher_types ORDER BY id LIMIT 2")
      .all() as { id: number }[];
    expect(boundaryAllows(db, "accountant", "voucher_type", types[1]!.id)).toBe(
      true,
    );
    setBoundary(
      db,
      {
        role: "accountant",
        dimensionKind: "voucher_type",
        dimensionId: types[0]!.id,
        allowed: true,
      },
      "Owner",
    );
    expect(boundaryAllows(db, "accountant", "voucher_type", types[0]!.id)).toBe(
      true,
    );
    expect(boundaryAllows(db, "accountant", "voucher_type", types[1]!.id)).toBe(
      false,
    );
    expect(boundaryAllows(db, "owner", "voucher_type", types[1]!.id)).toBe(
      true,
    );
  });

  it("requires independent exception approval and reports control activity and retention warnings", () => {
    const db = seededDb();
    const pending = requestPolicyException(
      db,
      {
        policyKind: "period_lock",
        entityType: "voucher",
        entityId: null,
        reason: "Post audited bank fee received after close",
      },
      "Asha",
    );
    expect(() =>
      decidePolicyException(db, pending.id, true, "Self approval", "Asha"),
    ).toThrow("cannot approve");
    expect(
      decidePolicyException(db, pending.id, true, "Evidence inspected", "Owner")
        .status,
    ).toBe("approved");
    expect(listPolicyExceptions(db, "approved")).toHaveLength(1);
    const policies = setRetentionPolicy(
      db,
      {
        evidenceKind: "review_questions",
        keepDays: 365,
        warnDays: 30,
        purgeRequiresApproval: true,
      },
      "Owner",
    );
    expect(
      policies.find((row) => row.evidenceKind === "review_questions"),
    ).toMatchObject({ keepDays: 365, purgeRequiresApproval: true });
    expect(listRetentionPolicies(db)).toHaveLength(5);
    expect(controlReport(db, "2026-08-01", "2026-08-31")).toMatchObject({
      overrides: 1,
      pendingExceptions: 0,
      periodSignoffStatus: "not_started",
    });
  });
});
