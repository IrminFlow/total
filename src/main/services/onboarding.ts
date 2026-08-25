import { existsSync, readFileSync } from "fs";
import { atomicWriteFile } from "../atomicFile";
import type { DB } from "../db/connection";
import { findOrCreateLedger } from "./masters";

export type BusinessType = "retailer" | "wholesaler" | "service" | "manufacturer" | "freelancer" | "professional";
export type PriorSoftware = "tally" | "busy" | "marg" | "zoho" | "excel" | "first-time";

export interface OnboardingProfile {
  schema: 1;
  businessType: BusinessType;
  priorSoftware: PriorSoftware;
  needsInventory: boolean;
  needsPayroll: boolean;
  createdAt: string;
  setupSteps: Record<"company" | "ledgers" | "opening" | "bank" | "tax" | "backup" | "firstVoucher", boolean>;
}

const LEDGERS: Record<BusinessType, [string, string][]> = {
  retailer: [["Retail Sales", "Sales Accounts"], ["Shop Rent", "Indirect Expenses"], ["Card Settlement", "Bank Accounts"]],
  wholesaler: [["Wholesale Sales", "Sales Accounts"], ["Freight Inward", "Direct Expenses"], ["Trade Discounts", "Indirect Expenses"]],
  service: [["Service Revenue", "Sales Accounts"], ["Professional Software", "Indirect Expenses"], ["Client Advances", "Current Liabilities"]],
  manufacturer: [["Manufacturing Sales", "Sales Accounts"], ["Factory Wages", "Direct Expenses"], ["Power & Fuel", "Direct Expenses"]],
  freelancer: [["Freelance Income", "Sales Accounts"], ["Internet & Software", "Indirect Expenses"], ["Professional Fees", "Indirect Expenses"]],
  professional: [["Professional Fees", "Sales Accounts"], ["Retainership Income", "Sales Accounts"], ["Office Expenses", "Indirect Expenses"]],
};

export function defaultOnboardingProfile(input: {
  businessType?: BusinessType;
  priorSoftware?: PriorSoftware;
  needsInventory?: boolean;
  needsPayroll?: boolean;
  now?: Date;
} = {}): OnboardingProfile {
  return {
    schema: 1,
    businessType: input.businessType ?? "service",
    priorSoftware: input.priorSoftware ?? "first-time",
    needsInventory: input.needsInventory ?? false,
    needsPayroll: input.needsPayroll ?? false,
    createdAt: (input.now ?? new Date()).toISOString(),
    setupSteps: { company: true, ledgers: false, opening: false, bank: false, tax: false, backup: false, firstVoucher: false },
  };
}

export function writeOnboardingProfile(path: string, profile: OnboardingProfile): void {
  atomicWriteFile(path, `${JSON.stringify(profile, null, 2)}\n`, 0o600);
}

export function readOnboardingProfile(path: string): OnboardingProfile {
  if (!existsSync(path)) return defaultOnboardingProfile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OnboardingProfile;
    return parsed.schema === 1 ? parsed : defaultOnboardingProfile();
  } catch {
    return defaultOnboardingProfile();
  }
}

export function applyBusinessTemplate(db: DB, businessType: BusinessType): string[] {
  return LEDGERS[businessType].map(([name, group]) => {
    findOrCreateLedger(db, name, group);
    return name;
  });
}

export function onboardingStatus(db: DB, profile: OnboardingProfile, backupCount: number): {
  profile: OnboardingProfile;
  score: number;
  openingDifference: number;
  openingRows: { id: number; name: string; openingBalance: number }[];
  missing: string[];
} {
  const openingRows = db.prepare("SELECT id,name,opening_balance AS openingBalance FROM ledgers WHERE opening_balance <> 0 ORDER BY ABS(opening_balance) DESC,name").all() as { id: number; name: string; openingBalance: number }[];
  const openingDifference = openingRows.reduce((sum, row) => sum + row.openingBalance, 0);
  const voucherCount = (db.prepare("SELECT COUNT(*) AS count FROM vouchers WHERE deleted_at IS NULL").get() as { count: number }).count;
  const bankCount = (db.prepare("SELECT COUNT(*) AS count FROM ledgers l JOIN groups g ON g.id=l.group_id WHERE g.name='Bank Accounts'").get() as { count: number }).count;
  const ledgerCount = (db.prepare("SELECT COUNT(*) AS count FROM ledgers WHERE is_system=0").get() as { count: number }).count;
  const next: OnboardingProfile = { ...profile, setupSteps: { ...profile.setupSteps,
    ledgers: ledgerCount > 0,
    opening: openingDifference === 0,
    bank: bankCount > 0,
    tax: true,
    backup: backupCount > 0,
    firstVoucher: voucherCount > 0,
  }};
  const missing = Object.entries(next.setupSteps).filter(([, done]) => !done).map(([step]) => step);
  const score = Math.round(((Object.keys(next.setupSteps).length - missing.length) / Object.keys(next.setupSteps).length) * 100);
  return { profile: next, score, openingDifference, openingRows, missing };
}
