import { describe, expect, it } from 'vitest'
import { inputCls, mergeInputCls } from '../components/ui'

/**
 * Tailwind emits `.w-full` after the numeric widths, so `<Select className="w-36">` used to
 * render full-width: same specificity, later rule wins, and the class attribute's order is
 * irrelevant. A dozen call sites across the app were affected. These pin the merge.
 */
describe('mergeInputCls', () => {
  it('keeps the base width when the caller does not ask for one', () => {
    expect(mergeInputCls()).toBe(inputCls)
    expect(mergeInputCls('num text-right')).toContain('w-full')
  })

  it('drops the base width when the caller names their own', () => {
    const merged = mergeInputCls('w-36')
    expect(merged).not.toContain('w-full')
    expect(merged).toContain('w-36')
    // Everything else about the input styling survives.
    expect(merged).toContain('rounded-md')
    expect(merged).toContain('border-line')
  })

  it('respects a width that is not the first class', () => {
    expect(mergeInputCls('num text-right w-28')).not.toContain('w-full')
  })

  it('honours an explicitly important width too', () => {
    expect(mergeInputCls('!w-20')).not.toContain('w-full')
  })

  it('leaves w-full in place for max-w and min-w, which are meant to combine with it', () => {
    // `max-w-prose w-full` is a real pairing: fill the row, but stop at a readable measure.
    expect(mergeInputCls('max-w-prose')).toContain('w-full')
    expect(mergeInputCls('min-w-0')).toContain('w-full')
  })

  it('does not match a width-like fragment inside another utility name', () => {
    // `overflow-x-auto` and `shadow-md` both contain no standalone w- utility.
    expect(mergeInputCls('overflow-x-auto shadow-md')).toContain('w-full')
  })
})
