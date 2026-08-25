export interface CommercialState {
  version: 1;
  analytics: {
    enabled: boolean;
    installationId: string;
    activatedMonth: string;
    events: Record<string, { count: number; firstAt: string; lastAt: string }>;
  };
  referral: { ownCode: string; attributedCode: string | null; attributedAt: string | null };
  partner: { enabled: boolean; labels: Record<string, string> };
  learning: { completed: string[]; freshTrainingCompanies: number };
  followedIdeas: string[];
}

export interface LearningModule {
  id: string;
  title: string;
  outcome: string;
  exercise: string;
  evidence: string;
}

export const LEARNING_MODULES: LearningModule[] = [
  { id: "books", title: "Double-entry foundations", outcome: "Post and explain balanced sales, purchase, receipt and payment vouchers.", exercise: "In a fresh training company, post one credit sale and its later receipt.", evidence: "Trial balance remains balanced and the customer outstanding clears." },
  { id: "gst", title: "GST evidence and returns", outcome: "Trace tax from source voucher to GSTR-1 and GSTR-3B.", exercise: "Inspect an intra-state and inter-state sale, then resolve one return exception.", evidence: "The return row drills back to the exact posted voucher lines." },
  { id: "banking", title: "Bank reconciliation", outcome: "Import and review matches without silently clearing books.", exercise: "Import the training statement, accept one match and document one exception.", evidence: "The reconciliation difference is explained by reviewed open rows." },
  { id: "controls", title: "Close and internal controls", outcome: "Use review, sign-off, verified backup and period lock correctly.", exercise: "Run month close, resolve the gates and record a sign-off without changing source evidence.", evidence: "The close record links the backup, checks and reviewer identity." },
  { id: "migration", title: "Implementation and migration", outcome: "Preview, clean and apply an import while preserving lineage.", exercise: "Dry-run the sample migration, explain its rejections and apply only the accepted batch.", evidence: "Imported records retain batch and source-hash evidence." },
  { id: "privacy", title: "Privacy, AI and integrations", outcome: "Configure scoped automation without giving it posting authority.", exercise: "Preview an Assist payload and create an inert voucher proposal or scoped MCP token.", evidence: "The audit trail shows review and no secret or book payload is logged." },
];

const KEY = "total:commercial:v1";
const EVENT_ALLOWLIST = new Set([
  "company_created",
  "first_voucher_posted",
  "first_backup_verified",
  "first_register_opened",
  "week_1_return",
  "month_1_return",
]);

function checksum(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0").slice(0, 2);
}

export function referralCode(seed: string): string {
  const body = seed.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(8, "T").slice(0, 8);
  return `TOTAL-${body}-${checksum(body)}`;
}

export function validReferralCode(code: string): boolean {
  const match = /^TOTAL-([A-Z0-9]{8})-([A-Z0-9]{2})$/.exec(code.trim().toUpperCase());
  return !!match && checksum(match[1]!) === match[2];
}

export function freshCommercialState(
  seed = crypto.randomUUID().replaceAll("-", "").slice(0, 12),
  now = new Date(),
): CommercialState {
  const installationId = seed.toLowerCase();
  return {
    version: 1,
    analytics: {
      enabled: false,
      installationId,
      activatedMonth: now.toISOString().slice(0, 7),
      events: {},
    },
    referral: { ownCode: referralCode(seed), attributedCode: null, attributedAt: null },
    partner: { enabled: false, labels: {} },
    learning: { completed: [], freshTrainingCompanies: 0 },
    followedIdeas: [],
  };
}

export function readCommercialState(storage: Storage): CommercialState {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "null") as CommercialState | null;
    if (parsed?.version === 1 && parsed.analytics?.installationId) return parsed;
  } catch {
    // Replace malformed device-only preferences; books are never involved.
  }
  const state = freshCommercialState();
  writeCommercialState(storage, state);
  return state;
}

export function writeCommercialState(storage: Storage, state: CommercialState): void {
  storage.setItem(KEY, JSON.stringify(state));
}

export function recordCohortEvent(
  storage: Storage,
  event: string,
  now = new Date(),
): CommercialState {
  const state = readCommercialState(storage);
  if (!readProductFlags(storage).flags.telemetry || !state.analytics.enabled || !EVENT_ALLOWLIST.has(event)) return state;
  const timestamp = now.toISOString();
  const before = state.analytics.events[event];
  state.analytics.events[event] = {
    count: (before?.count ?? 0) + 1,
    firstAt: before?.firstAt ?? timestamp,
    lastAt: timestamp,
  };
  writeCommercialState(storage, state);
  return state;
}

export function cohortPayload(
  state: CommercialState,
  appVersion: string,
  platform: string,
): Record<string, unknown> {
  return {
    schema: 1,
    installationId: state.analytics.installationId,
    activatedMonth: state.analytics.activatedMonth,
    appVersion,
    platform,
    events: Object.entries(state.analytics.events)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, ...value })),
  };
}

export function certificationProgress(state: CommercialState): {
  completed: number;
  total: number;
  eligible: boolean;
} {
  const completed = LEARNING_MODULES.filter((module) =>
    state.learning.completed.includes(module.id),
  ).length;
  return { completed, total: LEARNING_MODULES.length, eligible: completed === LEARNING_MODULES.length };
}
import { readProductFlags } from "./productFlags";
