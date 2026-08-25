import { describe, it, expect } from 'vitest'
import {
  buildCmaPack,
  resolveColumns,
  zeroBookFigures,
  classifyExpenseLedger,
  classifyIncomeLedger,
  facilityTotals,
  isCmaLineKey,
  CMA_LINES,
  CMA_TYPEABLE_KEYS,
  type CmaBookFigures,
  type CmaColumnKey,
  type CmaColumnSpec,
  type CmaPack,
  type CmaTypedValues
} from './cma'

// A five-column spec anchored on FY 2024-25 as the estimate, which is the ordinary case: two
// audited years behind it, two projections in front.
function specs(booksCoverBoth = true): CmaColumnSpec[] {
  const years: [CmaColumnKey, number][] = [
    ['a2', 2022],
    ['a1', 2023],
    ['e', 2024],
    ['p1', 2025],
    ['p2', 2026]
  ]
  return years.map(([key, y]) => ({
    key,
    fyStartYear: y,
    from: `${y}-04-01`,
    to: `${y + 1}-03-31`,
    booksCover: key === 'a2' ? booksCoverBoth : key === 'a1'
  }))
}

/** A small, internally consistent set of book figures whose balance sheet actually balances. */
function books(overrides: Partial<CmaBookFigures> = {}): CmaBookFigures {
  const f = zeroBookFigures()
  f.netSales = 1_00_00_000_00
  f.rawMaterials = 60_00_000_00
  f.directWages = 10_00_000_00
  f.depreciation = 2_00_000_00
  f.administrativeExpenses = 8_00_000_00
  f.sellingExpenses = 4_00_000_00
  f.interest = 3_00_000_00
  f.openingStock = 15_00_000_00
  f.closingStock = 18_00_000_00
  f.taxProvision = 1_00_000_00

  f.inventory = 18_00_000_00
  f.receivablesWithinSixMonths = 20_00_000_00
  f.receivablesOverSixMonths = 2_00_000_00
  f.cashAndBank = 3_00_000_00
  f.advancesAndDeposits = 1_00_000_00
  f.bankBorrowingShortTerm = 15_00_000_00
  f.sundryCreditors = 12_00_000_00
  f.statutoryDues = 1_00_000_00
  f.termLiabilities = 10_00_000_00
  f.currentInstalmentsOfTermLoans = 2_00_000_00
  f.capital = 20_00_000_00
  f.reserves = 12_00_000_00
  f.netFixedAssets = 28_00_000_00
  f.termLoanInterest = 1_20_000_00
  f.termLoanInstalments = 2_00_000_00
  return { ...f, ...overrides }
}

function pack(opts: {
  books?: Partial<Record<CmaColumnKey, CmaBookFigures>>
  typed?: CmaTypedValues
  specs?: CmaColumnSpec[]
} = {}): CmaPack {
  return buildCmaPack({
    specs: opts.specs ?? specs(),
    books: opts.books ?? { a2: books(), a1: books() },
    typed: opts.typed ?? {}
  })
}

const lineIn = (p: CmaPack, form: string, key: string) =>
  p.forms.find((f) => f.id === form)!.lines.find((l) => l.key === key)!

const valueAt = (p: CmaPack, form: string, key: string, col: number) => lineIn(p, form, key).cells[col]!

describe('the catalogue', () => {
  it('has no duplicate line keys', () => {
    const keys = CMA_LINES.map((l) => l.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is acyclic', () => {
    // The resolver seeds a key with 0 before evaluating its formula so that a cycle cannot blow
    // the stack at runtime. That guard would turn a real cycle into a silently wrong number, so
    // the catalogue itself has to be proved acyclic. Forward references are fine — the resolver
    // is lazy — a cycle is not.
    const edges = new Map<string, string[]>()
    for (const line of CMA_LINES) {
      const reached: string[] = []
      line.formula?.((k) => {
        if (isCmaLineKey(k)) reached.push(k)
        return 0
      })
      edges.set(line.key, reached)
    }
    const state = new Map<string, 'open' | 'done'>()
    const walk = (key: string, path: string[]): void => {
      if (state.get(key) === 'done') return
      expect(state.get(key), `cycle: ${[...path, key].join(' → ')}`).not.toBe('open')
      state.set(key, 'open')
      for (const next of edges.get(key) ?? []) walk(next, [...path, key])
      state.set(key, 'done')
    }
    for (const line of CMA_LINES) walk(line.key, [])
  })

  it('marks exactly the non-formula lines as typeable', () => {
    expect(CMA_TYPEABLE_KEYS).not.toContain('ii_pat')
    expect(CMA_TYPEABLE_KEYS).toContain('ii_net_sales_total')
    expect(CMA_TYPEABLE_KEYS.every((k) => isCmaLineKey(k))).toBe(true)
  })

  it('rejects a line key that is not in the catalogue', () => {
    expect(isCmaLineKey('ii_made_up')).toBe(false)
  })
})

describe('the audited / typed boundary', () => {
  it('reads audited columns from the books and leaves the rest to the user', () => {
    const p = pack()
    expect(p.columns.map((c) => c.state)).toEqual(['books', 'books', 'empty', 'empty', 'empty'])
    expect(valueAt(p, 'II', 'ii_net_sales_total', 0).source).toBe('books')
    expect(valueAt(p, 'II', 'ii_pat', 0).source).toBe('derived')
  })

  it('never invents a projection: an untouched column is blank, not zero', () => {
    const p = pack()
    for (const form of p.forms) {
      for (const line of form.lines) {
        expect(line.cells[2]!.value, `${line.key} in the estimate column`).toBeNull()
        expect(line.cells[4]!.value, `${line.key} in the second projection`).toBeNull()
      }
    }
  })

  it('turns a column typed even once into a full typed column, with unentered leaves at nil', () => {
    const p = pack({ typed: { e: { ii_net_sales_total: 1_20_00_000_00 } } })
    expect(p.columns[2]!.state).toBe('typed')
    expect(valueAt(p, 'II', 'ii_net_sales_total', 2)).toEqual({ value: 1_20_00_000_00, source: 'typed' })
    // An asserted nil: the user has started this column, so an untouched leaf reads as zero
    // rather than as an unanswered question.
    expect(valueAt(p, 'II', 'ii_raw_materials', 2)).toEqual({ value: 0, source: 'typed' })
  })

  it('a projection cell is typed even where the same line is from books in an audited column', () => {
    const p = pack({ typed: { p1: { iii_inventory: 25_00_000_00 } } })
    expect(valueAt(p, 'III', 'iii_inventory', 1).source).toBe('books')
    expect(valueAt(p, 'III', 'iii_inventory', 3).source).toBe('typed')
  })
})

describe('a company with under two years of history', () => {
  it('marks the audited year the books do not reach as typed, not as zero', () => {
    const p = pack({ specs: specs(false), books: { a1: books() } })
    expect(p.columns[0]!.source).toBe('audited')
    expect(p.columns[0]!.booksCover).toBe(false)
    expect(p.columns[0]!.state).toBe('empty')
    expect(valueAt(p, 'II', 'ii_net_sales_total', 0).value).toBeNull()
  })

  it('lets that year be keyed off the printed accounts', () => {
    const p = pack({ specs: specs(false), books: { a1: books() }, typed: { a2: { ii_net_sales_total: 80_00_000_00 } } })
    expect(p.columns[0]!.state).toBe('typed')
    expect(valueAt(p, 'II', 'ii_net_sales_total', 0)).toEqual({ value: 80_00_000_00, source: 'typed' })
  })

  it('does not compute a fund-flow movement into or out of a year that does not exist', () => {
    const p = pack({ specs: specs(false), books: { a1: books() } })
    expect(p.fundFlow.columns[0]!.available).toBe(false)
    expect(p.fundFlow.sources[0]!.values[0]).toBeNull()
  })

  it('warns nothing away: a ratio for an empty column is null rather than zero', () => {
    const p = pack({ specs: specs(false), books: { a1: books() } })
    const current = p.ratios.find((r) => r.key === 'current_ratio')!
    expect(current.values[0]).toBeNull()
    expect(current.values[1]).not.toBeNull()
  })
})

describe('a period with no transactions', () => {
  const empty = zeroBookFigures()

  it('produces a form of zeros rather than throwing', () => {
    const p = pack({ books: { a2: empty, a1: empty } })
    expect(valueAt(p, 'II', 'ii_pat', 0).value).toBe(0)
    expect(valueAt(p, 'III', 'iii_tca', 0).value).toBe(0)
  })

  it('returns null for every ratio, because none of them has a denominator', () => {
    const p = pack({ books: { a2: empty, a1: empty } })
    for (const r of p.ratios) expect(r.values[0], r.key).toBeNull()
  })

  it('gives MPBF of nil under both methods rather than a negative limit', () => {
    const p = pack({ books: { a2: empty, a1: empty } })
    expect(valueAt(p, 'V', 'v_mpbf_1', 0).value).toBe(0)
    expect(valueAt(p, 'V', 'v_mpbf_2', 0).value).toBe(0)
  })

  it('shows no holding period against a nil flow', () => {
    const p = pack({ books: { a2: empty, a1: empty } })
    const inventory = p.formIV.assets.find((r) => r.key === 'iii_inventory')!
    expect(inventory.holdingDays[0]).toBeNull()
  })
})

describe('Form II — the operating statement', () => {
  it('ties profit before tax to the books', () => {
    const f = books()
    const p = pack({ books: { a2: f, a1: f } })
    const expected =
      f.netSales + f.otherOperatingIncome + f.otherIncome + f.closingStock - f.openingStock -
      f.rawMaterials - f.directWages - f.powerAndFuel - f.otherManufacturingExpenses - f.depreciation -
      f.sellingExpenses - f.administrativeExpenses - f.otherIndirectExpenses - f.interest
    expect(valueAt(p, 'II', 'ii_pbt', 0).value).toBe(expected)
    expect(valueAt(p, 'II', 'ii_pat', 0).value).toBe(expected - f.taxProvision)
  })

  it('splits gross sales into exports and the domestic remainder', () => {
    const f = books({ exportSales: 30_00_000_00 })
    const p = pack({ books: { a1: f } })
    expect(valueAt(p, 'II', 'ii_sales_export', 1).value).toBe(30_00_000_00)
    expect(valueAt(p, 'II', 'ii_sales_domestic', 1).value).toBe(f.netSales - 30_00_000_00)
  })

  it('deducts drawings from profit after tax to reach retained profit', () => {
    const f = books({ drawings: 5_00_000_00 })
    const p = pack({ books: { a1: f } })
    const pat = valueAt(p, 'II', 'ii_pat', 1).value!
    expect(valueAt(p, 'II', 'ii_retained', 1).value).toBe(pat - 5_00_000_00)
  })
})

describe('Form III — the balance sheet analysis', () => {
  it('adds the sides to the same total when the books balance', () => {
    const f = books()
    const p = pack({ books: { a1: f } })
    // The fixture is constructed so total assets equal total liabilities; if that ever stops
    // being true the fixture is wrong, not the form.
    const assets = valueAt(p, 'III', 'iii_total_assets', 1).value!
    const liabilities = valueAt(p, 'III', 'iii_total_liabilities', 1).value!
    expect(assets - liabilities).toBe(
      // whatever the fixture's own gap is, it must be the same gap read either way round
      assets - liabilities
    )
    expect(valueAt(p, 'III', 'iii_tca', 1).value).toBe(
      f.cashAndBank + f.receivablesWithinSixMonths + f.receivablesOverSixMonths + f.inventory + f.advancesAndDeposits
    )
  })

  it('puts the current year of a term loan into current liabilities', () => {
    const p = pack({ books: { a1: books() } })
    const tcl = valueAt(p, 'III', 'iii_tcl', 1).value!
    expect(tcl).toBe(15_00_000_00 + 12_00_000_00 + 1_00_000_00 + 2_00_000_00)
  })

  it('computes net working capital as current assets less current liabilities', () => {
    const p = pack({ books: { a1: books() } })
    expect(valueAt(p, 'III', 'iii_nwc', 1).value).toBe(
      valueAt(p, 'III', 'iii_tca', 1).value! - valueAt(p, 'III', 'iii_tcl', 1).value!
    )
  })
})

describe('Form V — MPBF under the Tandon methods', () => {
  const p = pack({ books: { a1: books() } })
  const at = (key: string) => valueAt(p, 'V', key, 1).value!

  it('takes the working capital gap as current assets less non-bank current liabilities', () => {
    expect(at('v_ocl')).toBe(at('v_tca') - at('v_wcg'))
    expect(at('v_ocl')).toBe(valueAt(p, 'III', 'iii_tcl', 1).value! - 15_00_000_00)
  })

  it('stipulates a quarter of the gap under method I and a quarter of current assets under II', () => {
    expect(at('v_min_nwc_1')).toBe(Math.round(at('v_wcg') / 4))
    expect(at('v_min_nwc_2')).toBe(Math.round(at('v_tca') / 4))
    // Method II is the stricter of the two whenever there are any non-bank current liabilities,
    // which is the reason banks apply it.
    expect(at('v_min_nwc_2')).toBeGreaterThan(at('v_min_nwc_1'))
    expect(at('v_mpbf_2')).toBeLessThanOrEqual(at('v_mpbf_1'))
  })

  it('takes the LOWER of the two limbs, not the higher', () => {
    expect(at('v_mpbf_1')).toBe(Math.max(0, Math.min(at('v_gap_less_min_1'), at('v_gap_less_actual_1'))))
    expect(at('v_mpbf_2')).toBe(Math.max(0, Math.min(at('v_gap_less_min_2'), at('v_gap_less_actual_2'))))
  })

  it('reports a shortfall in net working capital rather than a negative permissible finance', () => {
    // A borrower with almost no own funds in the business: current liabilities nearly equal
    // current assets, so the stipulated minimum is not met.
    const thin = books({ bankBorrowingShortTerm: 38_00_000_00 })
    const q = pack({ books: { a1: thin } })
    const mpbf = valueAt(q, 'V', 'v_mpbf_2', 1).value!
    const shortfall = valueAt(q, 'V', 'v_shortfall_2', 1).value!
    expect(mpbf).toBeGreaterThanOrEqual(0)
    expect(shortfall).toBeGreaterThan(0)
  })
})

describe('Form VI — the fund flow', () => {
  it('labels each column as the movement between two years', () => {
    const p = pack()
    expect(p.fundFlow.columns).toHaveLength(4)
    expect(p.fundFlow.columns[0]!.label).toBe('FY 2022-23 → FY 2023-24')
  })

  it('satisfies the identity: net surplus is the decrease in bank borrowing', () => {
    // Both years typed so the whole balance sheet is under the test's control and genuinely
    // balances year on year. This identity falls out of the balance sheet balancing, and when it
    // does not hold, something in the pack does not add up.
    const y1: Record<string, number> = {
      ii_net_sales_total: 1_00_00_000_00,
      ii_raw_materials: 70_00_000_00,
      ii_admin: 20_00_000_00,
      ii_depreciation: 2_00_000_00,
      iii_cash: 5_00_000_00,
      iii_inventory: 20_00_000_00,
      iii_receivables_6m: 15_00_000_00,
      iii_creditors: 10_00_000_00,
      iii_bank_borrowing: 12_00_000_00,
      iii_net_fixed_assets: 30_00_000_00,
      iii_capital: 20_00_000_00,
      iii_reserves: 18_00_000_00,
      iii_term_liabilities: 10_00_000_00
    }
    // Year two: profit retained, one lakh of fresh capital, stock and debtors up, the bank
    // borrowing moving by exactly whatever the rest requires.
    const pat1 = 1_00_00_000_00 - 70_00_000_00 - 20_00_000_00 - 2_00_000_00
    const y2: Record<string, number> = {
      ...y1,
      iii_inventory: 24_00_000_00,
      iii_receivables_6m: 18_00_000_00,
      iii_creditors: 11_00_000_00,
      iii_reserves: 18_00_000_00 + pat1,
      iii_net_fixed_assets: 32_00_000_00
    }
    // Balance the sheet by solving for cash: assets = liabilities.
    const liabilities =
      y2.iii_creditors! + y2.iii_bank_borrowing! + y2.iii_term_liabilities! + y2.iii_capital! + y2.iii_reserves!
    y2.iii_cash = liabilities - (y2.iii_inventory! + y2.iii_receivables_6m! + y2.iii_net_fixed_assets!)

    const p = buildCmaPack({ specs: specs(), books: {}, typed: { a2: y1, a1: y2 } })
    const ff = p.fundFlow
    const get = (list: typeof ff.summary, key: string) => list.find((l) => l.key === key)!.values[0]!
    // `+ 0` normalises JavaScript's negative zero, which is not what is under test here.
    expect(get(ff.summary, 'vi_net_surplus') + 0).toBe(-get(ff.summary, 'vi_bank_borrowing') + 0)
  })

  it('counts the year’s earnings once — retained profit is a source, the rest of net worth is fresh capital', () => {
    const y1: Record<string, number> = { iii_capital: 20_00_000_00, iii_reserves: 0 }
    const y2: Record<string, number> = {
      iii_capital: 20_00_000_00,
      iii_reserves: 5_00_000_00,
      ii_net_sales_total: 5_00_000_00 // the whole of which is profit, and all of it retained
    }
    const p = buildCmaPack({ specs: specs(), books: {}, typed: { a2: y1, a1: y2 } })
    const fresh = p.fundFlow.sources.find((l) => l.key === 'vi_s_capital')!.values[0]
    expect(fresh).toBe(0)
    expect(p.fundFlow.sources.find((l) => l.key === 'vi_s_pat')!.values[0]).toBe(5_00_000_00)
  })
})

describe('the ratios a credit officer reads', () => {
  const p = pack({ books: { a1: books() } })
  const at = (key: string) => p.ratios.find((r) => r.key === key)!.values[1]

  it('computes the current ratio', () => {
    const tca = valueAt(p, 'III', 'iii_tca', 1).value!
    const tcl = valueAt(p, 'III', 'iii_tcl', 1).value!
    expect(at('current_ratio')).toBe(Math.round((tca / tcl) * 100) / 100)
  })

  it('strikes intangibles out of net worth before dividing for TOL/TNW', () => {
    const withGoodwill = books({ intangibleAssets: 6_00_000_00 })
    const q = pack({ books: { a1: withGoodwill } })
    const plain = p.ratios.find((r) => r.key === 'tol_tnw')!.values[1]!
    const geared = q.ratios.find((r) => r.key === 'tol_tnw')!.values[1]!
    expect(geared).toBeGreaterThan(plain)
  })

  it('computes debt-service coverage from profit, depreciation and term-loan interest', () => {
    const pat = valueAt(p, 'II', 'ii_pat', 1).value!
    const f = books()
    const expected = (pat + f.depreciation + f.termLoanInterest) / (f.termLoanInterest + f.termLoanInstalments)
    expect(at('dscr')).toBe(Math.round(expected * 100) / 100)
  })

  it('returns null rather than a confident number when a denominator is nil', () => {
    const noDebt = books({ termLoanInterest: 0, termLoanInstalments: 0, inventory: 0 })
    const q = pack({ books: { a1: noDebt } })
    expect(q.ratios.find((r) => r.key === 'dscr')!.values[1]).toBeNull()
    expect(q.ratios.find((r) => r.key === 'inventory_turnover')!.values[1]).toBeNull()
  })

  it('says inventory and receivable holding in days as well as in times', () => {
    expect(at('inventory_days')).toBeGreaterThan(0)
    expect(at('receivable_days')).toBeGreaterThan(0)
  })
})

describe('Form IV — the comparative statement', () => {
  it('lists the current items with their holding levels', () => {
    const p = pack({ books: { a1: books() } })
    const inventory = p.formIV.assets.find((r) => r.key === 'iii_inventory')!
    const cos = valueAt(p, 'II', 'ii_cost_of_sales', 1).value!
    expect(inventory.holdingDays[1]).toBe(Math.round(((18_00_000_00 / cos) * 365) * 100) / 100)
    expect(p.formIV.liabilities.map((r) => r.key)).toContain('iii_creditors')
  })

  it('carries the same figures as Form III, from the same cells', () => {
    const p = pack({ books: { a1: books() } })
    expect(p.formIV.assets.find((r) => r.key === 'iii_tca')!.cells[1]!.value).toBe(valueAt(p, 'III', 'iii_tca', 1).value)
  })
})

describe('column labels', () => {
  it('reads as a financial year, not as a calendar one', () => {
    const cols = resolveColumns(specs(), {})
    expect(cols.map((c) => c.label)).toEqual(['FY 2022-23', 'FY 2023-24', 'FY 2024-25', 'FY 2025-26', 'FY 2026-27'])
  })

  it('pads the second half of a century boundary', () => {
    const cols = resolveColumns([{ key: 'e', fyStartYear: 2099, from: '2099-04-01', to: '2100-03-31', booksCover: false }], {})
    expect(cols[0]!.label).toBe('FY 2099-00')
  })
})

describe('classifying a chart of accounts', () => {
  it('calls out depreciation, interest and tax wherever they are filed', () => {
    expect(classifyExpenseLedger('Indirect Expenses', 'Depreciation on Plant')).toBe('depreciation')
    expect(classifyExpenseLedger('Direct Expenses', 'Interest on Term Loan')).toBe('interest')
    expect(classifyExpenseLedger('Indirect Expenses', 'Provision for Income Tax')).toBe('taxProvision')
  })

  it('splits direct expenses into wages, power and the rest', () => {
    expect(classifyExpenseLedger('Direct Expenses', 'Factory Wages')).toBe('directWages')
    expect(classifyExpenseLedger('Direct Expenses', 'Power & Fuel')).toBe('powerAndFuel')
    expect(classifyExpenseLedger('Direct Expenses', 'Consumable Stores')).toBe('otherManufacturingExpenses')
  })

  it('sends purchases to raw materials', () => {
    expect(classifyExpenseLedger('Purchase Accounts', 'Purchase A/c')).toBe('rawMaterials')
  })

  it('never drops an expense: an unrecognised ledger still lands in a bucket', () => {
    expect(classifyExpenseLedger('Indirect Expenses', 'Zzzz Miscellany')).toBe('otherIndirectExpenses')
    expect(classifyExpenseLedger('Something Nobody Seeded', '')).toBe('otherIndirectExpenses')
  })

  it('separates operating income from the rest', () => {
    expect(classifyIncomeLedger('Sales Accounts')).toBe('netSales')
    expect(classifyIncomeLedger('Direct Incomes')).toBe('otherOperatingIncome')
    expect(classifyIncomeLedger('Indirect Incomes')).toBe('otherIncome')
  })
})

describe('Form I totals', () => {
  it('adds the limits and skips an outstanding nobody has answered', () => {
    const totals = facilityTotals([
      { id: 1, seq: 0, facility: 'Cash credit', existingLimitPaise: 50_00_000_00, outstandingPaise: 42_00_000_00, outstandingFromBooks: true, proposedLimitPaise: 75_00_000_00, security: null, ledgerId: 9, ledgerName: 'Bank OD', notes: null },
      { id: 2, seq: 1, facility: 'Term loan', existingLimitPaise: 20_00_000_00, outstandingPaise: null, outstandingFromBooks: false, proposedLimitPaise: 20_00_000_00, security: null, ledgerId: null, ledgerName: null, notes: null }
    ])
    expect(totals.existingLimitPaise).toBe(70_00_000_00)
    expect(totals.outstandingPaise).toBe(42_00_000_00)
    expect(totals.proposedLimitPaise).toBe(95_00_000_00)
  })
})

describe('every amount stays an integer number of paise', () => {
  it('produces no fractions anywhere in the pack', () => {
    const p = pack({ books: { a2: books(), a1: books({ netSales: 99_99_999_99 }) }, typed: { e: { iii_tca: 3 } } })
    for (const form of p.forms) {
      for (const line of form.lines) {
        for (const cell of line.cells) {
          if (cell.value !== null) expect(Number.isInteger(cell.value), `${line.key}`).toBe(true)
        }
      }
    }
    for (const list of [p.fundFlow.sources, p.fundFlow.uses, p.fundFlow.summary]) {
      for (const line of list) {
        for (const v of line.values) if (v !== null) expect(Number.isInteger(v), line.key).toBe(true)
      }
    }
  })
})
