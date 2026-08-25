import type { VoucherInputParsed } from "@shared/schemas";
import { formatPaise } from "@shared/money";

export interface ProposalReviewSummary {
  debit: number;
  credit: number;
  balanced: boolean;
  explanation: string;
  warnings: string[];
}

export function proposalReviewSummary(
  voucher: VoucherInputParsed,
  ledgerNames: ReadonlyMap<number, string>,
  voucherTypeName: string,
): ProposalReviewSummary {
  const debit = voucher.lines
    .filter((line) => line.drCr === "dr")
    .reduce((sum, line) => sum + line.amount, 0);
  const credit = voucher.lines
    .filter((line) => line.drCr === "cr")
    .reduce((sum, line) => sum + line.amount, 0);
  const unknown = voucher.lines
    .filter((line) => !ledgerNames.has(line.ledgerId))
    .map((line) => line.ledgerId);
  const warnings: string[] = [];
  if (debit !== credit) {
    warnings.push(
      `Debits and credits differ by ${formatPaise(Math.abs(debit - credit), { symbol: true })}.`,
    );
  }
  if (unknown.length > 0) {
    warnings.push(
      `Unknown ledger ${[...new Set(unknown)].map((id) => `#${id}`).join(", ")}.`,
    );
  }
  if (!voucher.narration?.trim()) {
    warnings.push("Narration is blank. Add context before posting when the entry is not self-explanatory.");
  }
  if (!voucher.reference?.trim()) {
    warnings.push("Reference is blank. Check whether the source document has an invoice or bank reference.");
  }

  const debitNames = voucher.lines
    .filter((line) => line.drCr === "dr")
    .map((line) => ledgerNames.get(line.ledgerId) ?? `ledger #${line.ledgerId}`);
  const creditNames = voucher.lines
    .filter((line) => line.drCr === "cr")
    .map((line) => ledgerNames.get(line.ledgerId) ?? `ledger #${line.ledgerId}`);
  return {
    debit,
    credit,
    balanced: debit === credit,
    explanation: `${voucherTypeName} dated ${voucher.date} will debit ${debitNames.join(", ")} and credit ${creditNames.join(", ")} for ${formatPaise(Math.max(debit, credit), { symbol: true })}.`,
    warnings,
  };
}
