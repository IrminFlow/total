import type { DB } from "../db/connection";
import type { Role } from "./roles";
import type { VoucherInputParsed } from "@shared/schemas";
import type { ApprovalRequest } from "./approvals";
import type { SaveVoucherResult } from "./vouchers";
import * as approvals from "./approvals";
import * as discountAuthority from "./discountAuthority";
import { saveVoucher } from "./vouchers";

export interface VoucherPostingActor {
  id: number;
  name: string;
  role: Role;
}

export type ControlledVoucherPostResult =
  | (SaveVoucherResult & { approvalRequired: false })
  | { approvalRequired: true; request: ApprovalRequest };

/** Apply the same sales-invoice discount ceiling to every voucher posting surface. */
export function assertVoucherDiscountAuthority(
  db: DB,
  input: VoucherInputParsed,
  actor: Pick<VoucherPostingActor, "name" | "role"> | null,
): void {
  const voucherKind = db
    .prepare("SELECT kind FROM voucher_types WHERE id=?")
    .get(input.voucherTypeId) as { kind: string } | undefined;
  if (voucherKind?.kind !== "sales") return;

  discountAuthority.assertDiscountAuthority(db, {
    role: actor?.role ?? "owner",
    actorName: actor?.name ?? "Local user",
    customerLedgerId: input.partyLedgerId ?? null,
    contextKind: "sales_invoice",
    lines: input.inventory.map((line) => ({
      stockItemId: line.stockItemId,
      requestedDiscountBps: discountAuthority.invoiceDiscountBps(
        line.qtyMilli,
        line.ratePaise,
        line.discountPaise ?? 0,
      ),
    })),
  });
}

/**
 * Route a validated voucher either into maker-checker or into the books.
 * Call `assertVoucherDiscountAuthority` before entering a larger transaction so
 * blocked-attempt evidence is retained even when posting is refused.
 */
export function postVoucherWithApprovalControl(
  db: DB,
  input: VoucherInputParsed,
  actor: VoucherPostingActor | null,
  existingId?: number,
  options: { creditOverrideReason?: string | null } = {},
): ControlledVoucherPostResult {
  if (actor && approvals.requiresApproval(db, input)) {
    return {
      approvalRequired: true,
      request: approvals.createApprovalRequest(db, input, actor, existingId),
    };
  }
  const saved = saveVoucher(db, input, existingId, options);
  return { ...saved, approvalRequired: false };
}
