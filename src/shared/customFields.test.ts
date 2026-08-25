import { describe, it, expect } from 'vitest'
import {
  customFieldKey,
  formatCustomValue,
  validateCustomValue,
  validateCustomValues,
  type CustomFieldDef
} from './customFields'

const def = (p: Partial<CustomFieldDef>): CustomFieldDef => ({
  id: 1,
  voucherTypeId: 1,
  key: 'field',
  label: 'Field',
  kind: 'text',
  options: [],
  required: false,
  printed: true,
  sortOrder: 0,
  retiredAt: null,
  ...p
})

describe('customFieldKey', () => {
  it('derives a stable machine name from a label', () => {
    expect(customFieldKey('Customer PO number')).toBe('customer_po_number')
    expect(customFieldKey('  Site / Location!  ')).toBe('site_location')
  })
})

describe('validateCustomValue', () => {
  it('accepts an empty value unless the field is required', () => {
    expect(validateCustomValue(def({}), '  ')).toEqual({ ok: true, value: '' })
    expect(validateCustomValue(def({ required: true }), '')).toMatchObject({ ok: false })
  })

  it('caps text length', () => {
    expect(validateCustomValue(def({}), 'x'.repeat(201))).toMatchObject({ ok: false })
    expect(validateCustomValue(def({}), 'x'.repeat(200))).toMatchObject({ ok: true })
  })

  it('accepts a plain number and rejects anything that is pretending to be money', () => {
    const n = def({ kind: 'number' })
    expect(validateCustomValue(n, '1000')).toEqual({ ok: true, value: '1000' })
    expect(validateCustomValue(n, '-12.5')).toEqual({ ok: true, value: '-12.5' })
    for (const bad of ['1,000', '₹100', '1e6', '12.', '1.2.3', 'ten']) {
      expect(validateCustomValue(n, bad), bad).toMatchObject({ ok: false })
    }
  })

  it('stores a number as the text that was typed — it is never paise', () => {
    const r = validateCustomValue(def({ kind: 'number' }), '10.5')
    expect(r).toEqual({ ok: true, value: '10.5' })
    // The point: no ×100, no rounding, no numeric type at all.
    expect(typeof (r as { value: string }).value).toBe('string')
  })

  it('requires a real ISO date', () => {
    const d = def({ kind: 'date' })
    expect(validateCustomValue(d, '2026-02-28')).toMatchObject({ ok: true })
    expect(validateCustomValue(d, '2026-02-30')).toMatchObject({ ok: false })
    expect(validateCustomValue(d, '28/02/2026')).toMatchObject({ ok: false })
  })

  it('holds a list value to its options', () => {
    const l = def({ kind: 'list', options: ['Road', 'Rail', 'Air'] })
    expect(validateCustomValue(l, 'Rail')).toMatchObject({ ok: true })
    expect(validateCustomValue(l, 'Sea')).toMatchObject({ ok: false })
  })
})

describe('validateCustomValues', () => {
  it('refuses a value for a field that is not defined on the type', () => {
    expect(validateCustomValues([def({ id: 1 })], [{ fieldId: 9, value: 'x' }])).toMatchObject({ ok: false })
  })

  it('complains about a required field that was left out entirely', () => {
    expect(validateCustomValues([def({ id: 1, required: true })], [])).toMatchObject({ ok: false })
  })

  it('lets a retired field keep the value a voucher already carries', () => {
    // The field was deleted last year; this voucher was issued with it and says so on its face.
    const retired = def({ id: 1, kind: 'list', options: ['A'], required: true, retiredAt: '2026-01-01' })
    expect(validateCustomValues([retired], [{ fieldId: 1, value: 'B' }])).toEqual({
      ok: true,
      values: [{ fieldId: 1, value: 'B' }]
    })
  })
})

describe('formatCustomValue', () => {
  it('prints a date the way the rest of the document does', () => {
    expect(formatCustomValue('date', '2026-03-31')).toBe('31-03-2026')
  })

  it('prints a number exactly as typed, so it never looks like an amount', () => {
    expect(formatCustomValue('number', '1000')).toBe('1000')
    expect(formatCustomValue('number', '10.5')).toBe('10.5')
  })

  it('prints nothing for an empty value', () => {
    expect(formatCustomValue('text', '')).toBe('')
  })
})
