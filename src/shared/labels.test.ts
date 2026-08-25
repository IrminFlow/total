import { describe, expect, it } from 'vitest'
import {
  LABEL_SIZES,
  dots,
  fitText,
  isCode128Printable,
  labelPreview,
  labelPrice,
  labelSize,
  planLabels,
  renderLabelsTspl,
  tsplText
} from './labels'

const decode = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

describe('isCode128Printable', () => {
  it('accepts the ASCII a barcode is actually made of', () => {
    expect(isCode128Printable('8901234567890')).toBe(true)
    expect(isCode128Printable('ITEM-001/A')).toBe(true)
  })

  it('refuses a blank, a rupee sign and a Devanagari name', () => {
    expect(isCode128Printable('')).toBe(false)
    expect(isCode128Printable('₹100')).toBe(false)
    expect(isCode128Printable('चावल')).toBe(false)
  })
})

describe('tsplText', () => {
  it('neutralises the quote that would end the command string', () => {
    // `12" pipe` is an ordinary thing to sell, and an unescaped quote turns the rest of the
    // label into printer commands.
    expect(tsplText('12" pipe')).toBe("12' pipe")
    expect(tsplText('a\\b')).toBe("a'b")
  })

  it('replaces what the printer has no glyph for, visibly', () => {
    expect(tsplText('चावल 5kg')).toBe('???? 5kg')
    expect(tsplText('₹250')).toBe('?250')
  })
})

describe('fitText', () => {
  it('leaves a name that fits alone and marks one that did not', () => {
    expect(fitText('Basmati', 10)).toBe('Basmati')
    expect(fitText('Basmati Rice Premium', 10)).toBe('Basmati R…')
    expect(fitText('abc', 0)).toBe('')
  })
})

describe('dots', () => {
  it('converts millimetres at both head resolutions', () => {
    expect(dots(50, 203)).toBe(400)
    expect(dots(50, 300)).toBe(591)
    expect(dots(2)).toBe(16)
  })
})

describe('labelPrice', () => {
  it('spells the rupee out, because the glyph is not in the printer font', () => {
    expect(labelPrice(25_000)).toBe('Rs.250.00')
    expect(labelPrice(100_000_00)).toContain('Rs.')
    expect(labelPrice(25_000)).not.toContain('₹')
  })
})

describe('labelSize', () => {
  it('finds a preset and returns null for one that is not there', () => {
    expect(labelSize('50x25')?.widthMm).toBe(50)
    expect(labelSize('nope')).toBeNull()
  })
})

describe('planLabels', () => {
  it('counts the copies across every spec', () => {
    const plan = planLabels([
      { barcode: 'A1', copies: 3 },
      { barcode: 'B2', copies: 2 }
    ])
    expect(plan.totalLabels).toBe(5)
    expect(plan.errors).toEqual([])
  })

  it('reports every unprintable barcode at once rather than stopping at the first', () => {
    const plan = planLabels([{ barcode: 'A1' }, { barcode: '₹1', name: 'Rice' }, { barcode: '', name: 'Dal' }])
    expect(plan.errors).toHaveLength(2)
    expect(plan.errors[0]).toContain('Rice')
    expect(plan.errors[1]).toContain('Dal')
  })

  it('refuses an empty job and an absurd one', () => {
    expect(planLabels([]).errors[0]).toContain('Nothing selected')
    expect(planLabels([{ barcode: 'A', copies: 400 }, { barcode: 'B', copies: 400 }], { maxTotal: 500 }).errors[0]).toContain(
      '800 labels'
    )
    expect(planLabels([{ barcode: 'A', copies: 0 }]).errors[0]).toContain('not a number of labels')
  })
})

describe('renderLabelsTspl', () => {
  const spec = { barcode: '8901234567890', name: 'Basmati Rice', detail: 'Batch B-12', pricePaise: 25_000, copies: 2 }

  it('sets the roll up once and then prints each label', () => {
    const job = decode(renderLabelsTspl([spec, { barcode: 'X1' }]))
    expect(job.match(/SIZE /g)).toHaveLength(1)
    expect(job.match(/GAP /g)).toHaveLength(1)
    expect(job.match(/CLS/g)).toHaveLength(2)
    expect(job.match(/PRINT /g)).toHaveLength(2)
  })

  it('asks for the right number of copies of each label', () => {
    const job = decode(renderLabelsTspl([spec]))
    expect(job).toContain('PRINT 2,1')
  })

  it('emits a Code 128 barcode command carrying the data verbatim', () => {
    const job = decode(renderLabelsTspl([spec]))
    expect(job).toMatch(/BARCODE \d+,\d+,"128",\d+,1,0,2,4,"8901234567890"/)
  })

  it('puts the size the caller asked for in the header', () => {
    const job = decode(renderLabelsTspl([spec], { size: LABEL_SIZES[3] }))
    expect(job).toContain('SIZE 100 mm,50 mm')
    expect(job).toContain('GAP 3 mm,0 mm')
  })

  it('gives the barcode more height on a taller label', () => {
    const short = decode(renderLabelsTspl([spec], { size: LABEL_SIZES[0] }))
    const tall = decode(renderLabelsTspl([spec], { size: LABEL_SIZES[3] }))
    const height = (job: string): number => Number(/BARCODE \d+,\d+,"128",(\d+)/.exec(job)![1])
    expect(height(tall)).toBeGreaterThan(height(short))
    // And never below the floor that still scans, even on the smallest stock with three lines.
    expect(height(short)).toBeGreaterThanOrEqual(24)
  })

  it('drops the human-readable digits when asked', () => {
    const job = decode(renderLabelsTspl([spec], { humanReadable: false }))
    expect(job).toMatch(/"128",\d+,0,0,2,4/)
  })

  it('is every byte a single byte, so the printer reads what was written', () => {
    const bytes = renderLabelsTspl([{ barcode: 'A1', name: 'चावल' }])
    expect([...bytes].every((b) => b >= 0 && b <= 0x7f)).toBe(true)
  })

  it('refuses the whole job when one label cannot be encoded', () => {
    expect(() => renderLabelsTspl([{ barcode: 'A1' }, { barcode: '₹1', name: 'Rice' }])).toThrow(/Rice/)
  })

  it('ends every line with CR LF, which is what TSPL terminates a command with', () => {
    const job = decode(renderLabelsTspl([{ barcode: 'A1' }]))
    expect(job.endsWith('\r\n')).toBe(true)
    expect(job.split('\r\n').filter(Boolean).every((l) => !l.includes('\n'))).toBe(true)
  })
})

describe('labelPreview', () => {
  it('shows what the label will say, including the truncation', () => {
    const lines = labelPreview({
      barcode: '8901234567890',
      name: 'Basmati Rice Premium Extra Long Grain Superior',
      pricePaise: 25_000,
      qtyMilli: 5000,
      unitSymbol: 'kg'
    })
    expect(lines[0]!.endsWith('…')).toBe(true)
    expect(lines.some((l) => l.includes('8901234567890'))).toBe(true)
    expect(lines.at(-1)).toContain('Rs.250.00')
    expect(lines.at(-1)).toContain('5.000 kg')
  })
})
