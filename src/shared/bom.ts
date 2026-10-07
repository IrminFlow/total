/**
 * Bills of materials with versions (WP 2.4) — pure rules behind the BOM editor, the Manufacture
 * screen's version picker / "Explode sub-assemblies" toggle and the material-variance report.
 * No Electron, no DB.
 *
 * A BOM version lists, per ONE unit of the parent item, each component's quantity (integer
 * thousandths) and an optional scrap allowance in basis points of that quantity (500 = 5 %).
 * A version is in force on a date when effectiveFrom ≤ date ≤ effectiveTo (null = open on that
 * side). Quantities stay integers end to end.
 *
 * ROUNDING RULE (explosion): each BOM edge rounds on its own — a component's quantity for a
 * parent quantity P is round_half_up(P × perUnit × (10000 + scrapBp) / (1000 × 10000)) computed
 * exactly in BigInt, so a sub-assembly's quantity is rounded to the thousandth BEFORE its own
 * components are derived from it (what a shop floor would actually issue for it). The same leaf
 * reached through several paths is summed after rounding.
 */

import { wouldCreateBomCycle, type BomEdge } from './valuation'

export interface BomVersionLine {
  componentId: number
  /** Component quantity (thousandths) per ONE whole unit of the parent. */
  qtyMilliPerUnit: number
  /** Scrap allowance, basis points of qtyMilliPerUnit (null/0 = none). */
  scrapPctBp: number | null
}

export interface BomVersion {
  id: number
  itemId: number
  name: string
  /** ISO date; null = from the beginning. */
  effectiveFrom: string | null
  /** ISO date (inclusive); null = open-ended. */
  effectiveTo: string | null
  isDefault: boolean
  lines: BomVersionLine[]
}

export const versionInForce = (v: Pick<BomVersion, 'effectiveFrom' | 'effectiveTo'>, date: string): boolean =>
  (v.effectiveFrom == null || v.effectiveFrom <= date) && (v.effectiveTo == null || date <= v.effectiveTo)

/**
 * The version of `itemId` to use on `date`: among its versions in force that day, the one with
 * the latest effectiveFrom (null counts as earliest); ties → the default, then the higher id.
 * When none is in force, the item's default version (the fallback); else null (no BOM).
 */
export function pickBomVersion(versions: readonly BomVersion[], itemId: number, date: string): BomVersion | null {
  const own = versions.filter((v) => v.itemId === itemId)
  const inForce = own.filter((v) => versionInForce(v, date))
  if (inForce.length > 0) {
    return [...inForce].sort((a, b) => {
      const fa = a.effectiveFrom ?? ''
      const fb = b.effectiveFrom ?? ''
      if (fa !== fb) return fa < fb ? 1 : -1
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return b.id - a.id
    })[0]!
  }
  return own.find((v) => v.isDefault) ?? null
}

/** Half-up rounding of n / d for non-negative BigInts. */
const divRound = (n: bigint, d: bigint): bigint => (n * 2n + d) / (2n * d)

/** Gross component quantity (thousandths) for `parentQtyMilli` of the parent — see the
 *  rounding rule above. */
export function componentQtyMilli(parentQtyMilli: number, qtyMilliPerUnit: number, scrapPctBp: number | null = null): number {
  if (parentQtyMilli <= 0 || qtyMilliPerUnit <= 0) return 0
  const scrap = BigInt(Math.max(0, scrapPctBp ?? 0))
  return Number(divRound(BigInt(parentQtyMilli) * BigInt(qtyMilliPerUnit) * (10000n + scrap), 10_000_000n))
}

export interface BomNode {
  itemId: number
  qtyMilli: number
  /** The version this node was expanded with (null = a leaf / no BOM). */
  versionId: number | null
  /** Expanded children; empty for a leaf (and for direct components in single-level mode). */
  children: BomNode[]
  /** true when the node has a BOM of its own on the date (a sub-assembly). */
  hasBom: boolean
}

export interface SubAssemblyNeed {
  itemId: number
  /** Total quantity of this sub-assembly the explosion needs (summed over paths). */
  qtyMilli: number
  versionId: number
}

export type ExplosionResult =
  | {
      ok: true
      /** The top item's version used (null = it has no BOM: leaves are empty). */
      versionId: number | null
      /** What the Manufacture screen's raw rows become: direct components ('single') or the
       *  leaves of the full tree ('full'), summed per component, first-seen order. */
      rows: { componentId: number; qtyMilli: number }[]
      tree: BomNode
      /** Components that have their own BOM — in 'full' mode those that were expanded (they are
       *  NOT manufactured implicitly), in 'single' mode the direct components with a BOM. */
      subAssemblies: SubAssemblyNeed[]
    }
  | { ok: false; error: 'cycle'; path: number[] }

const MAX_DEPTH = 64

/**
 * Expand `qtyMilli` of `itemId` through its BOM as of `atDate`. `versionId` pins the top-level
 * version (else pickBomVersion); sub-assemblies always use the version in force on the date.
 * 'single' = the direct components; 'full' = recurse into every component that has a BOM and
 * return the leaves. Cycle-safe: a component already on the current path (or a depth beyond
 * 64) returns `{ ok: false, error: 'cycle', path }` instead of looping.
 */
export function explodeBom(
  itemId: number,
  qtyMilli: number,
  versions: readonly BomVersion[],
  atDate: string,
  opts: { levels: 'single' | 'full'; versionId?: number | null }
): ExplosionResult {
  const top =
    opts.versionId != null
      ? (versions.find((v) => v.id === opts.versionId && v.itemId === itemId) ?? null)
      : pickBomVersion(versions, itemId, atDate)
  const rows = new Map<number, number>()
  const subs = new Map<number, SubAssemblyNeed>()
  const state: { cycle: number[] | null } = { cycle: null }

  const expand = (id: number, qty: number, version: BomVersion | null, path: number[], depth: number): BomNode => {
    const node: BomNode = { itemId: id, qtyMilli: qty, versionId: version?.id ?? null, children: [], hasBom: version != null }
    if (!version || state.cycle) return node
    for (const line of version.lines) {
      const childQty = componentQtyMilli(qty, line.qtyMilliPerUnit, line.scrapPctBp)
      const childVersion = pickBomVersion(versions, line.componentId, atDate)
      if (path.includes(line.componentId) || line.componentId === id || depth >= MAX_DEPTH) {
        state.cycle = [...path, id, line.componentId]
        return node
      }
      const recurse = opts.levels === 'full' && childVersion != null
      if (childVersion) {
        const s = subs.get(line.componentId)
        if (s) s.qtyMilli += childQty
        else subs.set(line.componentId, { itemId: line.componentId, qtyMilli: childQty, versionId: childVersion.id })
      }
      if (recurse) {
        node.children.push(expand(line.componentId, childQty, childVersion, [...path, id], depth + 1))
      } else {
        node.children.push({ itemId: line.componentId, qtyMilli: childQty, versionId: null, children: [], hasBom: childVersion != null })
        rows.set(line.componentId, (rows.get(line.componentId) ?? 0) + childQty)
      }
      if (state.cycle) return node
    }
    return node
  }

  const tree = expand(itemId, qtyMilli, top, [], 0)
  if (state.cycle) return { ok: false, error: 'cycle', path: state.cycle }
  return {
    ok: true,
    versionId: top?.id ?? null,
    rows: [...rows.entries()].map(([componentId, q]) => ({ componentId, qtyMilli: q })),
    tree,
    subAssemblies: [...subs.values()]
  }
}

/**
 * Would saving `lines` as a version of `itemId` close a loop through the BOM graph? Every
 * version of every OTHER item counts as an edge (any of them can be picked on some date); the
 * item's own other versions are irrelevant to a cycle through itself — wouldCreateBomCycle
 * ignores the item's existing edges.
 */
export function versionWouldCycle(itemId: number, componentIds: number[], versions: readonly BomVersion[]): boolean {
  const edges: BomEdge[] = versions.flatMap((v) => v.lines.map((l) => ({ itemId: v.itemId, componentId: l.componentId })))
  return wouldCreateBomCycle(itemId, componentIds, edges)
}

/** Validate a version before save: positive quantities, no duplicates, not itself, sane dates
 *  and scrap. Returns user-facing messages ([] = fine). */
export function validateBomVersion(
  v: { itemId: number; name: string; effectiveFrom: string | null; effectiveTo: string | null; lines: BomVersionLine[] },
  itemName: (id: number) => string = (id) => `Item #${id}`
): string[] {
  const out: string[] = []
  if (!v.name.trim()) out.push('Name the BOM version')
  if (v.effectiveFrom && v.effectiveTo && v.effectiveTo < v.effectiveFrom) out.push('“Effective to” is before “effective from”')
  const seen = new Set<number>()
  for (const l of v.lines) {
    if (l.componentId === v.itemId) out.push('An item cannot be its own component')
    if (seen.has(l.componentId)) out.push(`${itemName(l.componentId)} is listed twice — combine the rows`)
    seen.add(l.componentId)
    if (!(Number.isSafeInteger(l.qtyMilliPerUnit) && l.qtyMilliPerUnit > 0)) out.push(`${itemName(l.componentId)}: enter a quantity per unit`)
    if (l.scrapPctBp != null && !(Number.isSafeInteger(l.scrapPctBp) && l.scrapPctBp >= 0 && l.scrapPctBp <= 100_000)) {
      out.push(`${itemName(l.componentId)}: scrap must be between 0 % and 1000 %`)
    }
  }
  return out
}

// ---------- material variance (WP 2.4 report) ----------

export interface VarianceInputLine {
  componentId: number
  qtyMilli: number
}

export interface MaterialVarianceRow {
  componentId: number
  /** BOM standard for the quantity produced (thousandths). */
  standardQtyMilli: number
  actualQtyMilli: number
  /** Engine cost of the actual consumption, paise. */
  actualValuePaise: number
  /** The standard quantity valued at the actual unit cost (paise). */
  standardValuePaise: number
  /** actual − standard (positive = over-consumption). */
  qtyVarianceMilli: number
  /** actualValue − standardValue (positive = adverse). */
  valueVariancePaise: number
}

const mulDivRound = (a: number, b: number, d: number): number => {
  if (d === 0) return 0
  const neg = a < 0 !== b < 0
  const r = Number(divRound(BigInt(Math.abs(a)) * BigInt(Math.abs(b)), BigInt(Math.abs(d))))
  return neg && r !== 0 ? -r : r
}

/**
 * Standard vs actual per component. Each component's standard quantity is valued at the unit
 * cost the engine actually charged for it on this manufacture (actualValue ÷ actualQty, kept as
 * an exact ratio: standardValue = round(actualValue × standardQty ÷ actualQty)), so equal
 * quantities give exactly zero value variance. A standard component that wasn't consumed at all
 * is valued at `fallbackUnitCost(componentId)` paise per whole unit (the item's running average
 * at the voucher's date; 0 when unknown). Order: standard components first (BOM order), then
 * unplanned actual components.
 */
export function materialVariance(
  standard: readonly VarianceInputLine[],
  actual: readonly (VarianceInputLine & { valuePaise: number })[],
  fallbackUnitCost: (componentId: number) => number = () => 0
): MaterialVarianceRow[] {
  const std = new Map<number, number>()
  for (const s of standard) std.set(s.componentId, (std.get(s.componentId) ?? 0) + s.qtyMilli)
  const act = new Map<number, { qty: number; value: number }>()
  for (const a of actual) {
    const cur = act.get(a.componentId) ?? { qty: 0, value: 0 }
    act.set(a.componentId, { qty: cur.qty + a.qtyMilli, value: cur.value + a.valuePaise })
  }
  const ids = [...std.keys(), ...[...act.keys()].filter((id) => !std.has(id))]
  return ids.map((componentId) => {
    const standardQtyMilli = std.get(componentId) ?? 0
    const a = act.get(componentId) ?? { qty: 0, value: 0 }
    const standardValuePaise =
      a.qty > 0 ? mulDivRound(a.value, standardQtyMilli, a.qty) : mulDivRound(fallbackUnitCost(componentId), standardQtyMilli, 1000)
    return {
      componentId,
      standardQtyMilli,
      actualQtyMilli: a.qty,
      actualValuePaise: a.value,
      standardValuePaise,
      qtyVarianceMilli: a.qty - standardQtyMilli,
      valueVariancePaise: a.value - standardValuePaise
    }
  })
}
