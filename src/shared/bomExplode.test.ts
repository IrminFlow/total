import { describe, it, expect } from 'vitest'
import {
  BP_ONE,
  MAX_BOM_DEPTH,
  componentIssueQtyMilli,
  explodeBom,
  type BomGraph,
  type BomSpec
} from './bomExplode'

/** Terse graph builder: [yieldBp, [componentId, qtyMilliPerUnit, scrapBp][]] per item. */
function graph(entries: Record<number, [number, [number, number, number][]]>): BomGraph {
  const m = new Map<number, BomSpec>()
  for (const [id, [yieldBp, lines]] of Object.entries(entries)) {
    m.set(Number(id), {
      yieldBp,
      lines: lines.map(([componentId, qtyMilliPerUnit, scrapBp]) => ({ componentId, qtyMilliPerUnit, scrapBp }))
    })
  }
  return m
}

describe('componentIssueQtyMilli', () => {
  it('with no scrap and 100% yield is exactly the plain multiplication (today’s behaviour)', () => {
    // 2 units per unit × 3 units = 6 units, to the thousandth, for a range of shapes.
    expect(componentIssueQtyMilli(2000, 3000, 0, BP_ONE)).toBe(6000)
    expect(componentIssueQtyMilli(1500, 1000, 0, BP_ONE)).toBe(1500)
    expect(componentIssueQtyMilli(333, 7000, 0, BP_ONE)).toBe(2331)
    expect(componentIssueQtyMilli(0, 5000, 0, BP_ONE)).toBe(0)
    expect(componentIssueQtyMilli(1000, 0, 0, BP_ONE)).toBe(0)
  })

  it('inflates by scrap: 2.5% wastage on 100 metres needs 102.5', () => {
    expect(componentIssueQtyMilli(1000, 100_000, 250, BP_ONE)).toBe(102_500)
  })

  it('inflates by yield: 97% good means starting 100/0.97 of every component', () => {
    // 1 × 97 units at 97% yield is exactly 100 units of input.
    expect(componentIssueQtyMilli(1000, 97_000, 0, 9700)).toBe(100_000)
  })

  it('compounds scrap and yield on the same line', () => {
    // 2 per unit × 10 units × 1.10 scrap ÷ 0.50 yield = 44.
    expect(componentIssueQtyMilli(2000, 10_000, 1000, 5000)).toBe(44_000)
  })

  it('rounds half up, once', () => {
    // 1 × 1 unit ÷ 3 yield-ish: 1000 × 1000 × 10000 / (1000 × 30000) = 333.33… → 333
    expect(componentIssueQtyMilli(1000, 1000, 0, 30_000)).toBe(333)
    // exactly .5 goes up: 1 × 1 at 5 bp scrap → 1000.5 → 1001
    expect(componentIssueQtyMilli(1000, 1000, 5, BP_ONE)).toBe(1001)
  })

  it('stays exact past 2^53, where a double would not', () => {
    // 10 million units of a component needed 1 million times over: the intermediate product is
    // ~1e20, which is why the arithmetic is BigInt.
    expect(componentIssueQtyMilli(10_000_000_000, 1_000_000_000, 0, BP_ONE)).toBe(10_000_000_000_000_000)
  })

  it('refuses 100% scrap and 0% yield rather than dividing by nothing', () => {
    expect(() => componentIssueQtyMilli(1000, 1000, BP_ONE, BP_ONE)).toThrow(/100%/)
    expect(() => componentIssueQtyMilli(1000, 1000, 0, 0)).toThrow(/0%/)
    expect(() => componentIssueQtyMilli(1000, 1000, -1, BP_ONE)).toThrow(/negative/)
    expect(() => componentIssueQtyMilli(1000.5, 1000, 0, BP_ONE)).toThrow(/thousandths/)
  })
})

describe('explodeBom — single level', () => {
  const flat = graph({ 1: [BP_ONE, [[2, 2000, 0], [3, 500, 0]]] })

  it('reproduces the flat one-level list when scrap and yield are at their defaults', () => {
    const out = explodeBom(flat, 1, 3000)
    expect(out.tree.map((n) => [n.componentId, n.qtyMilli])).toEqual([
      [2, 6000],
      [3, 1500]
    ])
    expect(out.raw).toEqual([
      { componentId: 2, qtyMilli: 6000 },
      { componentId: 3, qtyMilli: 1500 }
    ])
    expect(out.subAssemblies).toEqual([])
    expect(out.tree.every((n) => n.depth === 1 && !n.isSubAssembly && n.children.length === 0)).toBe(true)
  })

  it('applies scrap to one component only, and yield to all of them', () => {
    const g = graph({ 1: [9000, [[2, 1000, 1000], [3, 1000, 0]]] })
    const out = explodeBom(g, 1, 9000) // 9 units of the finished item
    // component 2: 9 × 1.10 ÷ 0.90 = 11; component 3: 9 ÷ 0.90 = 10
    expect(out.raw).toEqual([
      { componentId: 2, qtyMilli: 11_000 },
      { componentId: 3, qtyMilli: 10_000 }
    ])
  })

  it('returns nothing for an item with no BOM at all', () => {
    expect(explodeBom(flat, 99, 1000)).toEqual({ tree: [], raw: [], subAssemblies: [] })
  })
})

describe('explodeBom — nested sub-assemblies (#126)', () => {
  it('explodes three levels, compounding scrap and yield down the tree', () => {
    // 1 shirt ← 1 sleeve-pair (sub) ← 2 panels (sub) ← 1 m cloth, all with waste.
    const g = graph({
      1: [BP_ONE, [[2, 1000, 0]]],
      2: [5000, [[3, 2000, 0]]], // half of what is started passes
      3: [BP_ONE, [[4, 1000, 2500]]] // 25% of the cloth is offcut
    })
    const out = explodeBom(g, 1, 1000)
    expect(out.tree).toHaveLength(1)
    const sleeve = out.tree[0]!
    expect([sleeve.componentId, sleeve.qtyMilli, sleeve.isSubAssembly, sleeve.depth]).toEqual([2, 1000, true, 1])
    const panel = sleeve.children[0]!
    expect([panel.componentId, panel.qtyMilli, panel.depth]).toEqual([3, 4000, 2]) // 1 ÷ 0.5 × 2
    const cloth = panel.children[0]!
    expect([cloth.componentId, cloth.qtyMilli, cloth.depth, cloth.isSubAssembly]).toEqual([4, 5000, 3, false])
    expect(out.raw).toEqual([{ componentId: 4, qtyMilli: 5000 }])
    expect(out.subAssemblies).toEqual([
      { componentId: 2, qtyMilli: 1000 },
      { componentId: 3, qtyMilli: 4000 }
    ])
  })

  it('adds the requirements of a component that appears at two different levels', () => {
    // Screws are used both directly by the product and by its sub-assembly.
    const g = graph({
      1: [BP_ONE, [[2, 1000, 0], [9, 4000, 0]]],
      2: [BP_ONE, [[9, 3000, 0]]]
    })
    const out = explodeBom(g, 1, 2000) // 2 units
    expect(out.raw).toEqual([{ componentId: 9, qtyMilli: 14_000 }]) // 8 direct + 6 through the sub
    expect(out.subAssemblies).toEqual([{ componentId: 2, qtyMilli: 2000 }])
  })

  it('rounds once per level, so the tree the screen shows is the tree that was costed', () => {
    // 1 sub per unit at 30% yield → 3.333 subs; its component is 3.333 × 1, not 3.334.
    const g = graph({ 1: [3000, [[2, 1000, 0]]], 2: [BP_ONE, [[3, 1000, 0]]] })
    const out = explodeBom(g, 1, 1000)
    expect(out.subAssemblies).toEqual([{ componentId: 2, qtyMilli: 3333 }])
    expect(out.raw).toEqual([{ componentId: 3, qtyMilli: 3333 }])
  })
})

describe('explodeBom — bad graphs', () => {
  it('reports a cycle instead of overflowing the stack', () => {
    // A cycle that wouldCreateBomCycle would refuse today, but an older database still holds.
    const g = graph({ 1: [BP_ONE, [[2, 1000, 0]]], 2: [BP_ONE, [[1, 1000, 0]]] })
    expect(() => explodeBom(g, 1, 1000)).toThrow(/cycle/)
  })

  it('reports a self-referencing component as a cycle', () => {
    const g = graph({ 1: [BP_ONE, [[1, 1000, 0]]] })
    expect(() => explodeBom(g, 1, 1000)).toThrow(/cycle/)
  })

  it('bounds the depth with a message that says what to look for', () => {
    // A chain longer than the cap, with no repeated item, so only the depth bound can stop it.
    const entries: Record<number, [number, [number, number, number][]]> = {}
    for (let i = 1; i <= MAX_BOM_DEPTH + 5; i++) entries[i] = [BP_ONE, [[i + 1, 1000, 0]]]
    expect(() => explodeBom(graph(entries), 1, 1000)).toThrow(
      new RegExp(`nests more than ${MAX_BOM_DEPTH} levels deep`)
    )
  })
})
