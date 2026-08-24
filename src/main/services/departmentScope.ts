import type { VoucherInputParsed } from "@shared/schemas";
import type { DB } from "../db/connection";
import type { Role } from "./roles";

export type DepartmentDimension = "voucher_type" | "godown" | "cost_centre";

interface BoundaryRow {
  dimension_kind: DepartmentDimension;
  dimension_id: number;
  allowed: number;
}

interface DimensionScope {
  configured: boolean;
  allowed: Set<number>;
}

interface RoleScope {
  voucher_type: DimensionScope;
  godown: DimensionScope;
  cost_centre: DimensionScope;
}

interface VoucherDimensions {
  voucherTypeIds: number[];
  godownIds: Array<number | null>;
  costCentreIds: number[];
}

export interface ApprovalScopeTarget {
  payload: VoucherInputParsed;
  targetVoucherId: number | null;
  postedVoucherId: number | null;
}

const EMPTY_SCOPE = (): RoleScope => ({
  voucher_type: { configured: false, allowed: new Set<number>() },
  godown: { configured: false, allowed: new Set<number>() },
  cost_centre: { configured: false, allowed: new Set<number>() },
});

function roleScope(db: DB, role: Role): RoleScope {
  const scope = EMPTY_SCOPE();
  if (role === "owner") return scope;
  const rows = db
    .prepare(
      `SELECT dimension_kind, dimension_id, allowed
       FROM department_boundaries WHERE role = ?`,
    )
    .all(role) as BoundaryRow[];
  for (const row of rows) {
    const dimension = scope[row.dimension_kind];
    dimension.configured = true;
    if (row.allowed) dimension.allowed.add(row.dimension_id);
  }
  return scope;
}

export function hasDepartmentScope(db: DB, role: Role): boolean {
  const scope = roleScope(db, role);
  return Object.values(scope).some((dimension) => dimension.configured);
}

function dimensionsAllowed(
  scope: RoleScope,
  dimensions: VoucherDimensions,
): boolean {
  if (
    scope.voucher_type.configured &&
    (dimensions.voucherTypeIds.length !== 1 ||
      !scope.voucher_type.allowed.has(dimensions.voucherTypeIds[0]!))
  )
    return false;

  if (scope.godown.configured) {
    if (
      dimensions.godownIds.length === 0 ||
      dimensions.godownIds.some(
        (id) => id == null || !scope.godown.allowed.has(id),
      )
    )
      return false;
  }

  if (scope.cost_centre.configured) {
    if (
      dimensions.costCentreIds.length === 0 ||
      dimensions.costCentreIds.some(
        (id) => !scope.cost_centre.allowed.has(id),
      )
    )
      return false;
  }
  return true;
}

function voucherDimensionsById(
  db: DB,
  voucherIds: number[],
): Map<number, VoucherDimensions> {
  const result = new Map<number, VoucherDimensions>();
  const unique = [...new Set(voucherIds)];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const ids = unique.slice(offset, offset + 500);
    const marks = ids.map(() => "?").join(",");
    const vouchers = db
      .prepare(
        `SELECT id, voucher_type_id AS voucherTypeId FROM vouchers WHERE id IN (${marks})`,
      )
      .all(...ids) as { id: number; voucherTypeId: number }[];
    for (const voucher of vouchers) {
      result.set(voucher.id, {
        voucherTypeIds: [voucher.voucherTypeId],
        godownIds: [],
        costCentreIds: [],
      });
    }
    const godowns = db
      .prepare(
        `SELECT DISTINCT voucher_id AS voucherId, godown_id AS godownId
         FROM inventory_lines WHERE voucher_id IN (${marks})`,
      )
      .all(...ids) as { voucherId: number; godownId: number | null }[];
    for (const row of godowns)
      result.get(row.voucherId)?.godownIds.push(row.godownId);
    const costCentres = db
      .prepare(
        `SELECT DISTINCT line.voucher_id AS voucherId,
                allocation.cost_centre_id AS costCentreId
         FROM voucher_line_cost_allocations allocation
         JOIN voucher_lines line ON line.id = allocation.voucher_line_id
         WHERE line.voucher_id IN (${marks})`,
      )
      .all(...ids) as { voucherId: number; costCentreId: number }[];
    for (const row of costCentres)
      result.get(row.voucherId)?.costCentreIds.push(row.costCentreId);
  }
  return result;
}

export function voucherInDepartmentScope(
  db: DB,
  role: Role,
  voucherId: number,
): boolean {
  const dimensions = voucherDimensionsById(db, [voucherId]).get(voucherId);
  if (!dimensions) return false;
  return dimensionsAllowed(roleScope(db, role), dimensions);
}

export function assertVoucherDepartmentScope(
  db: DB,
  role: Role,
  voucherId: number,
): void {
  const dimensions = voucherDimensionsById(db, [voucherId]).get(voucherId);
  if (!dimensions) throw new Error("Voucher was not found");
  if (!dimensionsAllowed(roleScope(db, role), dimensions)) {
    throw new Error(
      "This voucher is outside your configured department boundaries",
    );
  }
}

export function assertVoucherIdsDepartmentScope(
  db: DB,
  role: Role,
  voucherIds: number[],
): void {
  const unique = [...new Set(voucherIds)];
  const scope = roleScope(db, role);
  const dimensions = voucherDimensionsById(db, unique);
  for (const voucherId of unique) {
    const target = dimensions.get(voucherId);
    if (!target) throw new Error("Voucher was not found");
    if (!dimensionsAllowed(scope, target))
      throw new Error(
        "This voucher is outside your configured department boundaries",
      );
  }
}

export function filterVoucherRowsByDepartmentScope<T extends { id: number }>(
  db: DB,
  role: Role,
  rows: T[],
): T[] {
  const scope = roleScope(db, role);
  if (!Object.values(scope).some((dimension) => dimension.configured)) return rows;
  const dimensions = voucherDimensionsById(
    db,
    rows.map((row) => row.id),
  );
  return rows.filter((row) => {
    const target = dimensions.get(row.id);
    return !!target && dimensionsAllowed(scope, target);
  });
}

export function filterVoucherLinkedRowsByDepartmentScope<T>(
  db: DB,
  role: Role,
  rows: T[],
  voucherIdOf: (row: T) => number,
): T[] {
  const scope = roleScope(db, role);
  if (!Object.values(scope).some((dimension) => dimension.configured))
    return rows;
  const dimensions = voucherDimensionsById(
    db,
    rows.map(voucherIdOf),
  );
  return rows.filter((row) => {
    const target = dimensions.get(voucherIdOf(row));
    return !!target && dimensionsAllowed(scope, target);
  });
}

export function voucherInputInDepartmentScope(
  db: DB,
  role: Role,
  input: VoucherInputParsed,
): boolean {
  if (role === "owner") return true;
  const dimensions: VoucherDimensions = {
    voucherTypeIds: [input.voucherTypeId],
    godownIds: input.inventory.map((line) => line.godownId),
    costCentreIds: input.lines.flatMap((line) =>
      line.costAllocations.map((allocation) => allocation.costCentreId),
    ),
  };
  return dimensionsAllowed(roleScope(db, role), dimensions);
}

export function assertVoucherInputDepartmentScope(
  db: DB,
  role: Role,
  input: VoucherInputParsed,
): void {
  if (!voucherInputInDepartmentScope(db, role, input)) {
    throw new Error(
      "This voucher is outside your configured department boundaries",
    );
  }
}

export function approvalRequestInDepartmentScope(
  db: DB,
  role: Role,
  request: ApprovalScopeTarget,
): boolean {
  if (!hasDepartmentScope(db, role)) return true;
  if (!voucherInputInDepartmentScope(db, role, request.payload)) return false;
  return [request.targetVoucherId, request.postedVoucherId]
    .filter((id): id is number => id != null)
    .every((id) => voucherInDepartmentScope(db, role, id));
}

export function assertApprovalRequestDepartmentScope(
  db: DB,
  role: Role,
  request: ApprovalScopeTarget,
): void {
  if (!approvalRequestInDepartmentScope(db, role, request)) {
    throw new Error(
      "This approval request is outside your configured department boundaries",
    );
  }
}

export function assertCompanyWideSurfaceAllowed(
  db: DB,
  role: Role,
  surface: string,
): void {
  if (!hasDepartmentScope(db, role)) return;
  throw new Error(
    `${surface} is unavailable while department boundaries are active because it would expose company-wide data`,
  );
}
