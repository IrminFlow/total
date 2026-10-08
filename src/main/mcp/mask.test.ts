// WP 5.7 review: MCP masking is by field. Codes, numbers and ids survive intact; identifiers are
// masked; free text masks only stand-alone account-like digit runs.
import { describe, expect, it } from 'vitest'
import { createPseudonymiser } from '../ai/privacy'
import { cleanClientName, fieldKind, maskFreeText, mcpMaskString, mcpMaskValue } from './mask'

const MASK = { maskIds: true, pseudonymiser: null }

describe('field-aware masking', () => {
  it('keeps HSN, voucher numbers, line uids, FY-prefixed numbers and references to codes intact', () => {
    const v = {
      hsn: '99831100',
      number: 'INV-20250415',
      lineUid: '3f0912345678abcd',
      billName: '2025-26/00012345',
      lines: [{ ledgerId: 7, amount: 1234567890, uid: '00912345678' }],
      narration: 'Against bill 2025-26/00012345, invoice INV-20250415, HSN 99831100'
    }
    const out = mcpMaskValue(v, MASK)
    expect(out).toEqual(v)
  })

  it('masks identifier fields whatever their shape', () => {
    const out = mcpMaskValue({ gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', ifsc: 'HDFC0001234', accountNo: '50100123456789', udyamNo: 'UDYAM-MH-01-0012345' }, MASK)
    expect(out).toEqual({ gstin: '[GSTIN …1ZV]', pan: '[PAN …9F]', ifsc: '[IFSC HDFC…]', accountNo: '[A/c …6789]', udyamNo: '[Udyam …2345]' })
  })

  it('in free text masks GSTIN / PAN / IFSC and only stand-alone account numbers', () => {
    expect(maskFreeText('Paid to A/c 50100123456789 via HDFC0001234 (GSTIN 27AAPFU0939F1ZV)')).toBe(
      'Paid to A/c [A/c …6789] via [IFSC HDFC…] (GSTIN [GSTIN …1ZV])'
    )
    expect(maskFreeText('a/c 5010 0123 4567 89 ok')).toBe('a/c [A/c …6789] ok')
    for (const keep of ['INV-20250415', '2025-26/00012345', 'ref3f0912345678', '99831100', '12,34,567.00', '1234567890.50']) {
      expect(maskFreeText(keep), keep).toBe(keep)
    }
  })

  it('never masks with masking off; pseudonymises names in text fields only', () => {
    const p = { maskIds: false, pseudonymiser: createPseudonymiser([{ name: 'Acme Traders', alias: 'Party-0001' }]) }
    expect(mcpMaskValue({ name: 'Acme Traders', gstin: '27AAPFU0939F1ZV', number: 'Acme Traders' }, p)).toEqual({
      name: 'Party-0001',
      gstin: '27AAPFU0939F1ZV',
      number: 'Acme Traders'
    })
    expect(mcpMaskString('Received from Acme Traders', null, p)).toBe('Received from Party-0001')
  })

  it('classifies keys', () => {
    expect(fieldKind('gstin')).toBe('id')
    expect(fieldKind('bank_account_no')).toBe('id')
    expect(fieldKind('voucherId')).toBe('keep')
    expect(fieldKind('narration')).toBe('text')
    expect(fieldKind('name')).toBe('text')
    expect(fieldKind('account')).toBe('text')
    expect(fieldKind('accountNumber')).toBe('id')
  })

  it('cleans client names to a short printable string', () => {
    expect(cleanClientName('Claude Desktop')).toBe('Claude Desktop')
    expect(cleanClientName('evil\u0000‮\nname<script>')).toBe('evilnamescript')
    expect(cleanClientName('x'.repeat(200))).toHaveLength(60)
    expect(cleanClientName('\u0001\u0002')).toBeNull()
  })
})
