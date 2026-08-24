import { describe, expect, it } from 'vitest'
import { compareStatements } from './statementCompare'
import type { StatementNode } from './reports'

const node = (over: Partial<StatementNode> & { id: number; name: string; amount: number }): StatementNode => ({
  kind: 'ledger',
  children: [],
  ...over
})

describe('compareStatements', () => {
  it('pairs lines that exist in both periods', () => {
    const out = compareStatements(
      [node({ id: 1, name: 'Rent', amount: 120000 })],
      [node({ id: 1, name: 'Rent', amount: 100000 })]
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      name: 'Rent',
      amount: 120000,
      priorAmount: 100000,
      change: 20000,
      onlyIn: null
    })
    expect(out[0]!.changeRatio).toBeCloseTo(0.2)
  })

  it('pairs by id, not by name — a renamed ledger is the same ledger', () => {
    // Matching by name would show a renamed account as "new this year" beside a phantom that
    // "disappeared", which is two wrong rows instead of one right one.
    const out = compareStatements(
      [node({ id: 7, name: 'Office Rent', amount: 100 })],
      [node({ id: 7, name: 'Rent', amount: 80 })]
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.onlyIn).toBeNull()
    expect(out[0]!.name).toBe('Office Rent') // the current name wins
  })

  it('pairs by id, not by position', () => {
    // Position is wrong the moment a ledger existed in one period and not the other, which is
    // exactly the case a comparison is for.
    const out = compareStatements(
      [node({ id: 2, name: 'B', amount: 20 }), node({ id: 1, name: 'A', amount: 10 })],
      [node({ id: 1, name: 'A', amount: 5 }), node({ id: 2, name: 'B', amount: 50 })]
    )
    expect(out.map((n) => [n.name, n.priorAmount])).toEqual([
      ['B', 50],
      ['A', 5]
    ])
  })

  it('keeps a line that started this period', () => {
    const out = compareStatements([node({ id: 9, name: 'New Expense', amount: 500 })], [])
    expect(out[0]).toMatchObject({ onlyIn: 'current', priorAmount: 0, change: 500 })
    // No meaningful percentage against nothing.
    expect(out[0]!.changeRatio).toBeNull()
  })

  it('keeps a line that stopped, appended after the current ones', () => {
    // Dropping it would hide the most interesting row on the page: the income that stopped.
    const out = compareStatements(
      [node({ id: 1, name: 'Still Here', amount: 10 })],
      [node({ id: 1, name: 'Still Here', amount: 10 }), node({ id: 2, name: 'Gone', amount: 400 })]
    )
    expect(out.map((n) => n.name)).toEqual(['Still Here', 'Gone'])
    expect(out[1]).toMatchObject({ onlyIn: 'prior', amount: 0, priorAmount: 400, change: -400 })
    expect(out[1]!.changeRatio).toBeCloseTo(-1)
  })

  it('recurses into children, pairing them the same way', () => {
    const out = compareStatements(
      [node({ id: 1, kind: 'group', name: 'Indirect', amount: 300, children: [node({ id: 5, name: 'Tea', amount: 300 })] })],
      [node({ id: 1, kind: 'group', name: 'Indirect', amount: 200, children: [node({ id: 5, name: 'Tea', amount: 200 })] })]
    )
    expect(out[0]!.children[0]).toMatchObject({ name: 'Tea', priorAmount: 200, change: 100 })
  })

  it('keeps the whole subtree of a group that no longer exists', () => {
    const out = compareStatements(
      [],
      [node({ id: 3, kind: 'group', name: 'Closed Division', amount: 900, children: [node({ id: 8, name: 'Salaries', amount: 900 })] })]
    )
    expect(out[0]!.onlyIn).toBe('prior')
    expect(out[0]!.children).toHaveLength(1)
    expect(out[0]!.children[0]).toMatchObject({ name: 'Salaries', priorAmount: 900, amount: 0 })
  })

  it('matches computed rows by name, since they carry no real id', () => {
    const out = compareStatements(
      [node({ id: 0, kind: 'computed', name: 'Gross profit', amount: 100 })],
      [node({ id: 0, kind: 'computed', name: 'Gross profit', amount: 60 })]
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.change).toBe(40)
  })

  it('does not confuse a ledger and a group that share an id', () => {
    const out = compareStatements(
      [node({ id: 1, kind: 'ledger', name: 'Ledger One', amount: 10 })],
      [node({ id: 1, kind: 'group', name: 'Group One', amount: 99 })]
    )
    expect(out).toHaveLength(2)
    expect(out.map((n) => n.onlyIn)).toEqual(['current', 'prior'])
  })

  it('handles a negative prior amount without flipping the sign of the ratio', () => {
    // -100 to -50 is an improvement of 50, which is +50% against the magnitude of the base.
    const out = compareStatements(
      [node({ id: 1, name: 'X', amount: -50 })],
      [node({ id: 1, name: 'X', amount: -100 })]
    )
    expect(out[0]!.change).toBe(50)
    expect(out[0]!.changeRatio).toBeCloseTo(0.5)
  })

  it('answers empty for two empty statements', () => {
    expect(compareStatements([], [])).toEqual([])
  })
})
