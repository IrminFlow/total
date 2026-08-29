export type ReviewStatus = "open" | "answered" | "resolved" | "cancelled";
export type ReviewPriority = "normal" | "high" | "urgent";

export interface ReviewQuestion {
  id: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  question: string;
  assignedToUserId: number | null;
  assignedToName: string | null;
  dueDate: string | null;
  priority: ReviewPriority;
  status: ReviewStatus;
  answer: string | null;
  createdBy: string;
  answeredBy: string | null;
  resolvedBy: string | null;
  createdAt: string;
  answeredAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface PeriodSignoff {
  id: number;
  periodFrom: string;
  periodTo: string;
  status: "draft" | "prepared" | "reviewed" | "reopened";
  outstandingIssues: string[];
  evidence: string[];
  preparedBy: string | null;
  preparedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
  updatedAt: string;
}

export type ExportFormat = "pdf" | "spreadsheet" | "json_mirror" | "full_data";
export type ExportPermissionMatrix = Record<
  "owner" | "accountant" | "viewer",
  Record<ExportFormat, boolean>
>;

export interface SessionRecord {
  id: number;
  userId: number;
  userName: string;
  role: "owner" | "accountant" | "viewer";
  signedInAt: string;
  lastActivityAt: string;
  signedOutAt: string | null;
  lockState: "active" | "locked" | "signed_out" | "expired";
}

export type PolicyKind =
  | "period_lock"
  | "credit_limit"
  | "validation_warning"
  | "negative_stock"
  | "other";
export interface PolicyException {
  id: number;
  policyKind: PolicyKind;
  entityType: string;
  entityId: number | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "used" | "cancelled";
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  usedAt: string | null;
}

export interface DepartmentBoundary {
  id: number;
  role: "accountant" | "viewer";
  dimensionKind: "cost_centre" | "godown" | "voucher_type";
  dimensionId: number;
  dimensionName: string;
  allowed: boolean;
}

export interface RetentionPolicy {
  evidenceKind:
    | "attachments"
    | "review_questions"
    | "signoffs"
    | "review_bundles"
    | "audit";
  keepDays: number | null;
  warnDays: number;
  purgeRequiresApproval: boolean;
  updatedBy: string;
  updatedAt: string;
  warningCount: number;
}

export interface ControlReport {
  from: string;
  to: string;
  overrides: number;
  deletedDrafts: number;
  reversals: number;
  latePostings: number;
  privilegedActions: number;
  openQuestions: number;
  overdueQuestions: number;
  pendingExceptions: number;
  periodSignoffStatus: PeriodSignoff["status"] | "not_started";
  recentExceptions: PolicyException[];
}
