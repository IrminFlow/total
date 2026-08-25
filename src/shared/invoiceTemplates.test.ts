import { describe, it, expect } from 'vitest'
import {
  INVOICE_TEMPLATES,
  INVOICE_TEMPLATE_CLASSES,
  invoiceTemplateCss,
  DEFAULT_INVOICE_TEMPLATE
} from './invoiceTemplates'

describe('invoice templates (I-182)', () => {
  it('offers more than one template, each with a label and a reason to pick it', () => {
    expect(INVOICE_TEMPLATES.length).toBeGreaterThanOrEqual(3)
    for (const t of INVOICE_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it('has unique ids, so a saved config can never mean two templates', () => {
    expect(new Set(INVOICE_TEMPLATES.map((t) => t.id)).size).toBe(INVOICE_TEMPLATES.length)
  })

  it('defaults to a template that exists', () => {
    expect(INVOICE_TEMPLATES.some((t) => t.id === DEFAULT_INVOICE_TEMPLATE)).toBe(true)
  })

  it('styles every class the invoice skeleton uses, in every template', () => {
    // The failure this catches: a template that forgets `.endorse` drops the composition-dealer
    // declaration off the printed page, and nobody notices until an officer does.
    for (const t of INVOICE_TEMPLATES) {
      const css = invoiceTemplateCss(t.id)
      for (const cls of INVOICE_TEMPLATE_CLASSES) {
        expect(css, `${t.id} is missing .${cls}`).toContain(`.${cls}`)
      }
    }
  })

  it('keeps the print rules that make a multi-page invoice work, in every template', () => {
    for (const t of INVOICE_TEMPLATES) {
      const css = invoiceTemplateCss(t.id)
      expect(css).toContain('page-break-after')
      expect(css).toContain('page-break-inside: avoid')
      expect(css).toContain('display: table-header-group')
    }
  })

  it('gives every template a different stylesheet — otherwise the picker is a lie', () => {
    const sheets = INVOICE_TEMPLATES.map((t) => invoiceTemplateCss(t.id))
    expect(new Set(sheets).size).toBe(sheets.length)
  })

  it('falls back to Classic for an unknown id rather than printing nothing', () => {
    expect(invoiceTemplateCss('a-template-from-a-later-version')).toBe(invoiceTemplateCss('classic'))
  })
})
