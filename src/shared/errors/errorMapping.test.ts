// WP 8.5: every error code saveVoucher (its posting rules, TDS / TCS checks and its own
// refusals), the bin / undo paths, the masters services and the IPC boundary raise has a field
// mapping and a plain message — the codes are read from the sources, so a new one can't ship
// unmapped. Plus the placement rules of mapError and the save card's sentences.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { en, translator, type MessageKey } from '../i18n'

const t = translator('en')
import { ERROR_MAP, errorEntry, mapError, WITHHOLDING_ERROR_SUFFIXES, AppError, structuredOf } from './index'
import { saveCardSentences, type SaveSummary } from '../simple/saveCard'

const src = (rel: string): string => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const all = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]!)

/** Every code the save / masters paths can raise, read from the sources. */
function enumerateCodes(): Map<string, string> {
  const codes = new Map<string, string>()
  const add = (from: string, list: string[]): void => list.forEach((c) => codes.set(c, from))
  // Posting rules and TCS checks: `code: 'x'` literals.
  add('shared/posting.ts', all(/code: '([a-z_]+)'/g, src('shared/posting.ts')))
  add('shared/tcs.ts', all(/code: '([a-z_]+)'/g, src('shared/tcs.ts')))
  // Withholding entries: code('x') under both prefixes.
  const suffixes = all(/code\('([a-z_]+)'\)/g, src('shared/withholding.ts'))
  for (const p of ['tds', 'tcs']) add('shared/withholding.ts', suffixes.map((s) => `${p}_${s}`))
  // Services and the IPC boundary: new AppError('x', …).
  for (const f of ['main/services/vouchers.ts', 'main/services/masters.ts', 'main/services/undo.ts', 'main/services/openings.ts', 'main/services/openingBills.ts', 'main/services/simplePost.ts', 'main/services/simpleBank.ts', 'main/services/simplePeople.ts', 'main/ipc.ts']) {
    add(f, all(/new AppError\(\s*'([a-z_]+)'/g, src(f)))
  }
  // WP 9.1: the intent mapper's fail('x', …).
  add('shared/simple/intents.ts', all(/fail\(\s*'([a-z_]+)'/g, src('shared/simple/intents.ts')))
  // ipc.ts structured codes produced without an AppError.
  add('main/ipc.ts', all(/code: '([a-z_]+)'/g, src('main/ipc.ts')).filter((c) => c === 'invalid_input' || c === 'duplicate_name'))
  return codes
}

describe('error mapping completeness', () => {
  const codes = enumerateCodes()

  it('finds the codes it should (sanity)', () => {
    for (const c of ['unbalanced', 'cash_bank_rule', 'tds_no_rate', 'tcs_party_credit', 'books_locked', 'credit_hold', 'ledger_in_use', 'undo_edited', 'invalid_input']) {
      expect(codes.has(c), c).toBe(true)
    }
    expect([...new Set(all(/code\('([a-z_]+)'\)/g, src('shared/withholding.ts')))].sort()).toEqual([...WITHHOLDING_ERROR_SUFFIXES].sort())
  })

  it('maps every code to a plain message', () => {
    const missing = [...codes].filter(([c]) => !(c in ERROR_MAP)).map(([c, from]) => `${c} (${from})`)
    expect(missing).toEqual([])
  })

  it('every mapped message exists, and declares exactly the variables it uses', () => {
    for (const [code, entry] of Object.entries(ERROR_MAP)) {
      const text = (en as Record<string, string>)[entry.key]
      expect(text, `${code} → ${entry.key}`).toBeTypeOf('string')
      const used = [...text!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(used, `${code} → ${entry.key}`).toEqual([...(entry.vars ?? [])].sort())
      if (entry.vars?.length) {
        expect(entry.plainKey, `${code} needs a param-free fallback`).toBeTruthy()
        expect((en as Record<string, string>)[entry.plainKey!]).not.toMatch(/\{\w+\}/)
      }
    }
  })
})

describe('mapError', () => {
  const posting = Object.assign(new Error('Line amounts must be positive; Debits (100) and credits (0) differ by 100 paise'), {
    code: 'validation',
    issues: [
      { code: 'bad_amount', line: 1, message: 'Line amounts must be positive' },
      { code: 'unbalanced', params: { amount: '₹1.00' }, message: 'Debits (100) and credits (0) differ by 100 paise' }
    ]
  })

  it('puts each issue under its field; accountant wording is the service’s own', () => {
    const m = mapError(posting, { simple: false, t, fields: ['date', 'lines'] })
    // 'lines.1.amount' isn't on the form — it walks up to 'lines'; both issues share it.
    expect(m.fields).toEqual({ lines: 'Line amounts must be positive Debits (100) and credits (0) differ by 100 paise' })
    expect(m.general).toBeNull()
  })

  it('simple shell: only the plain t() messages, the technical text kept for Details', () => {
    const m = mapError(posting, { simple: true, t, fields: ['lines.1.amount', 'lines'] })
    expect(m.fields['lines.1.amount']).toBe(t('errors.enterAmount'))
    expect(m.fields.lines).toBe(t('errors.unbalanced', { amount: '₹1.00' }))
    expect(m.details).toBe(posting.message)
  })

  it('an issue with no field on the form is the form’s message — the original text in the accountant shell', () => {
    const err = new AppError('books_locked', 'Books are locked up to 2026-06-30', { field: 'date', params: { date: '30/06/2026' } })
    expect(mapError(err, { simple: false, t, fields: ['party'] })).toMatchObject({ fields: {}, general: 'Books are locked up to 2026-06-30' })
    expect(mapError(err, { simple: true, t, fields: ['date'] }).fields.date).toBe('Entries up to 30/06/2026 are locked. Pick a later date or ask the owner to unlock.')
    // Missing params → the param-free message, never a raw {placeholder}.
    const bare = new AppError('books_locked', 'Books are locked up to 2026-06-30', { field: 'date' })
    expect(mapError(bare, { simple: true, t }).fields.date).toBe(t('errors.dateLockedPlain'))
  })

  it('a plain Error (no code): accountant keeps it, simple says the generic sentence', () => {
    const err = new Error('SQLITE_BUSY: database is locked')
    expect(mapError(err, { simple: false, t })).toMatchObject({ fields: {}, general: 'SQLITE_BUSY: database is locked' })
    expect(mapError(err, { simple: true, t })).toMatchObject({ fields: {}, general: t('errors.generic'), details: err.message })
  })

  it('Zod issues map by their path', () => {
    const err = Object.assign(new Error('gstin: A GSTIN has 15 characters; name: Required'), {
      code: 'invalid_input',
      issues: [
        { code: 'zod.custom', field: 'gstin', message: 'gstin: A GSTIN has 15 characters' },
        { code: 'zod.too_small', field: 'name', message: 'name: Required' }
      ]
    })
    expect(errorEntry('zod.custom', 'gstin')?.key).toBe('errors.gstinInvalid')
    const m = mapError(err, { simple: true, t, fields: ['name', 'gstin'] })
    expect(m.fields).toEqual({ gstin: t('errors.gstinInvalid'), name: t('errors.nameNeeded') })
    expect(mapError(err, { simple: false, t, fields: ['name', 'gstin'] }).fields.gstin).toBe('gstin: A GSTIN has 15 characters')
  })

  it('structuredOf carries code / field / params / issues, nothing for a plain Error', () => {
    expect(structuredOf(new AppError('credit_hold', 'x', { field: 'party', params: { name: 'R' } }))).toEqual({ code: 'credit_hold', field: 'party', params: { name: 'R' } })
    expect(structuredOf(new Error('x'))).toBeNull()
  })
})

describe('save card sentences', () => {
  const base: SaveSummary = { entries: [], parties: [], undo: { undoable: true, reason: null } }
  const k = (key: MessageKey, vars?: Record<string, string | number>): string => t(key, vars)

  it('a bill with a payment and the balance left', () => {
    const s = saveCardSentences(
      {
        ...base,
        entries: [
          { voucherId: 1, kind: 'sales', number: 'S1', date: '2026-10-13', amount: 118000, money: null },
          { voucherId: 2, kind: 'receipt', number: 'R1', date: '2026-10-13', amount: 50000, money: { name: 'UPI', isCash: false, amount: 50000 } }
        ],
        parties: [{ ledgerId: 9, name: 'Ramesh', side: 'customer', balance: 68000 }]
      },
      t
    )
    expect(s).toEqual(['Bill ₹1,180.00 saved.', 'Received ₹500.00 into UPI.', 'Ramesh still owes ₹680.00.'])
  })

  it('a cash purchase settled in full; a supplier paid ahead', () => {
    expect(
      saveCardSentences({ ...base, entries: [{ voucherId: 1, kind: 'purchase', number: 'P1', date: '2026-10-13', amount: 1000, money: null }], parties: [{ ledgerId: 3, name: 'Gupta', side: 'supplier', balance: 0 }] }, t)
    ).toEqual([k('simple.saveCard.entry', { kind: 'purchase', amount: '₹10.00' }), 'You owe Gupta nothing now.'])
    expect(
      saveCardSentences({ ...base, entries: [{ voucherId: 1, kind: 'payment', number: 'X', date: '2026-10-13', amount: 500, money: { name: 'Cash', isCash: true, amount: 500 } }], parties: [{ ledgerId: 3, name: 'Gupta', side: 'supplier', balance: -500 }] }, t)
    ).toEqual(['Money out ₹5.00 saved.', 'You have paid Gupta ₹5.00 in advance.'])
  })
})
