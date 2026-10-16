// Outstandings (accountant screen) fits a standard page at 1280 px wide without a sideways
// scrollbar (#130 review: the table was 1030 px in the 1022 px panel). The DataTable's own layout
// helpers decide the widths, so this checks them on the screen's real column config.
import { describe, expect, it } from 'vitest'
import { columnWidthSpecs, layoutColumnWidths, NAME_MIN_WIDTH } from '../lib/table/layout'
import { OUTSTANDING_COLUMNS, OUTSTANDING_TRAILING_WIDTH } from '../screens/Outstandings'

// DataTable.tsx's fixed columns: the expand chevron and the bulk tick box.
const EXPANDER_WIDTH = 32
const SELECT_WIDTH = 34
// A standard Page is max-w-5xl (1024 px) — reached from a 1280 px window (192 px sidebar + the
// main padding) — inside a Panel with a 1 px border each side.
const PANEL_INNER = 1024 - 2
// A classic (Windows) vertical scrollbar inside the 70vh scroll box.
const SCROLLBAR = 17

const visible = OUTSTANDING_COLUMNS.filter((c) => !c.defaultHidden)
const fixed = EXPANDER_WIDTH + SELECT_WIDTH + OUTSTANDING_TRAILING_WIDTH

describe('Outstandings column config', () => {
  it('fits the 1022 px panel with the tick box, and still with a classic scrollbar', () => {
    for (const available of [PANEL_INNER, PANEL_INNER - SCROLLBAR]) {
      const { widths, total } = layoutColumnWidths(columnWidthSpecs(visible), available, fixed)
      expect(total).toBeLessThanOrEqual(available)
      // The party name keeps at least the name column's floor; spare room goes to it.
      expect(widths[visible.findIndex((c) => c.id === 'party')]).toBeGreaterThanOrEqual(NAME_MIN_WIDTH)
    }
  })

  it('the party name takes the spare room; every money column keeps its width', () => {
    const { widths, total } = layoutColumnWidths(columnWidthSpecs(visible), PANEL_INNER, fixed)
    expect(total).toBe(PANEL_INNER)
    const byId = Object.fromEntries(visible.map((c, i) => [c.id, widths[i]]))
    expect(byId).toEqual({ party: 1022 - fixed - 4 * 122 - 136, b0: 122, b1: 122, b2: 122, b3: 122, pending: 136 })
  })
})
