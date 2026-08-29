// Bill-of-materials explosion: scrap, yield, and nested sub-assemblies (#125, #126).
//
// Two different numbers inflate a requirement and they are not interchangeable:
//
//   scrapBp  — per COMPONENT, hundredths of a percent. Cutting 100 shirts from cloth wastes
//              cloth and nothing else, so it inflates that one line's issue quantity.
//   yieldBp  — per FINISHED ITEM, hundredths of a percent. Of 100 units started, 97 pass, so
//              you must start more of EVERYTHING; it inflates every component equally.
//
// Defaults (scrap 0, yield 10000 = 100.00%) collapse to the plain multiplication that this app
// has always done, which is why an existing BOM keeps producing yesterday's numbers.

/** Deeper than this is a data-entry accident, not a product structure. */
export const MAX_BOM_DEPTH = 20

/** 100.00% expressed in hundredths of a percent — the identity for both scrap and yield. */
export const BP_ONE = 10000

export interface BomComponentSpec {
  componentId: number
  /** Component quantity (thousandths) per ONE whole unit of the parent. */
  qtyMilliPerUnit: number
  /** Wastage on this component alone, hundredths of a percent. */
  scrapBp: number
}

export interface BomSpec {
  /** Good units out of units started, hundredths of a percent. 10000 = nothing is lost. */
  yieldBp: number
  lines: BomComponentSpec[]
}

/** itemId → its BOM. An item absent from the map is a raw material (nothing to explode). */
export type BomGraph = ReadonlyMap<number, BomSpec>

export interface BomRequirementNode {
  componentId: number
  /** Quantity to issue of this component (thousandths), scrap and yield already applied. */
  qtyMilli: number
  scrapBp: number
  /** Yield of the parent this line was inflated by — carried so the UI can explain itself. */
  parentYieldBp: number
  /** 1 for the finished item's own components, 2 for a sub-assembly's components, … */
  depth: number
  /** True when this component has a BOM of its own and `children` explodes it. */
  isSubAssembly: boolean
  children: BomRequirementNode[]
}

export interface BomExplosion {
  /** The structure, one entry per line of the finished item's BOM, nested all the way down. */
  tree: BomRequirementNode[]
  /** Leaves only — the things actually bought — summed across every place they appear. */
  raw: { componentId: number; qtyMilli: number }[]
  /** Intermediate items that carry their own BOM, summed the same way. */
  subAssemblies: { componentId: number; qtyMilli: number }[]
}

function assertBp(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new Error(`${what} must be an integer in hundredths of a percent`)
}

/**
 * Issue quantity for one BOM line.
 *
 * All of it in BigInt: qtyMilli × qtyMilli overflows the 2^53 a double holds exactly, and a
 * quantity that is out by a thousandth because of a float is exactly the class of bug this
 * codebase forbids. One rounding, at the end, on the single exact ratio
 *
 *     perUnit × parentQty × (10000 + scrap)  /  (1000 × yield)
 *
 * rather than rounding scrap and yield separately: two roundings of the same line drift in the
 * same direction, and the drift shows up as a phantom half-metre of cloth.
 */
export function componentIssueQtyMilli(
  qtyMilliPerUnit: number,
  parentQtyMilli: number,
  scrapBp: number,
  yieldBp: number
): number {
  assertBp(scrapBp, 'Scrap')
  assertBp(yieldBp, 'Yield')
  if (!Number.isInteger(qtyMilliPerUnit) || !Number.isInteger(parentQtyMilli)) {
    throw new Error('Quantities are integer thousandths')
  }
  if (scrapBp < 0) throw new Error('Scrap cannot be negative')
  if (scrapBp >= BP_ONE) {
    // 100% scrap means every unit issued is wasted, so no quantity would ever be enough.
    throw new Error('Scrap of 100% or more can never produce anything — lower it')
  }
  if (yieldBp <= 0) throw new Error('Yield of 0% can never produce anything — raise it')
  if (qtyMilliPerUnit < 0 || parentQtyMilli < 0) throw new Error('Quantities cannot be negative')

  const num = BigInt(qtyMilliPerUnit) * BigInt(parentQtyMilli) * BigInt(BP_ONE + scrapBp)
  const den = 1000n * BigInt(yieldBp)
  // Round half up: (2n + d) / 2d, floored. Deterministic, and independent of platform maths.
  return Number((2n * num + den) / (2n * den))
}

/**
 * Explode `qtyMilli` of `itemId` through the whole BOM graph.
 *
 * Rounding happens once per level rather than once at the leaf, because the intermediate number
 * is a real quantity: it is the amount of the sub-assembly the shop floor actually makes, it is
 * the number the screen shows, and the raw materials under it have to be the materials for that
 * number rather than for an unrounded ghost of it.
 */
export function explodeBom(graph: BomGraph, itemId: number, qtyMilli: number): BomExplosion {
  const raw = new Map<number, number>()
  const subs = new Map<number, number>()

  const walk = (parentId: number, parentQtyMilli: number, depth: number, path: number[]): BomRequirementNode[] => {
    const spec = graph.get(parentId)
    if (!spec) return []
    if (depth > MAX_BOM_DEPTH) {
      throw new Error(
        `Bill of materials nests more than ${MAX_BOM_DEPTH} levels deep — check for a sub-assembly that contains itself`
      )
    }
    return spec.lines.map((line) => {
      // Runtime cycle guard: wouldCreateBomCycle (src/shared/valuation.ts) stops a cycle being
      // saved, but a database that predates that guard still holds one, and it has to surface as
      // a message rather than as a stack overflow with no item id anywhere in it.
      if (path.includes(line.componentId)) {
        throw new Error(`Bill of materials contains a cycle: item ${[...path, line.componentId].join(' → ')}`)
      }
      const qty = componentIssueQtyMilli(line.qtyMilliPerUnit, parentQtyMilli, line.scrapBp, spec.yieldBp)
      const childSpec = graph.get(line.componentId)
      const isSubAssembly = childSpec != null && childSpec.lines.length > 0
      const bucket = isSubAssembly ? subs : raw
      bucket.set(line.componentId, (bucket.get(line.componentId) ?? 0) + qty)
      return {
        componentId: line.componentId,
        qtyMilli: qty,
        scrapBp: line.scrapBp,
        parentYieldBp: spec.yieldBp,
        depth,
        isSubAssembly,
        children: isSubAssembly ? walk(line.componentId, qty, depth + 1, [...path, line.componentId]) : []
      }
    })
  }

  const tree = walk(itemId, qtyMilli, 1, [itemId])
  const sorted = (m: Map<number, number>): { componentId: number; qtyMilli: number }[] =>
    [...m.entries()]
      .map(([componentId, q]) => ({ componentId, qtyMilli: q }))
      .sort((a, b) => a.componentId - b.componentId)
  return { tree, raw: sorted(raw), subAssemblies: sorted(subs) }
}
